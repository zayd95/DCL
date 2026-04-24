/**
 * stockService — single brain for stock reads, writes, validation, and derived state.
 *
 * Public API surface:
 *   readers:    normalizeStockItem (read boundary)
 *   computed:   computeStockState, toKg
 *   validation: validateStockItem
 *   writers:    applyMovement (interactive, in-transaction)
 *               createMovement (low-level, used by importInvoice WriteBatch only)
 *
 * ─── ROADMAP: lot-based stock (Step 2 — biggest upgrade, deferred) ────────────
 *
 * Current model: one StockItem doc per (depot × product × import). costBasis is a
 * single proportional pool. Works for uniform lots, breaks down with multi-supplier
 * stock at the same SKU (mixed prices, partial exits FIFO/LIFO ambiguous).
 *
 * Target model:
 *   /products/{sku}              — catalog (productName, category, unitWeight default)
 *   /lots/{lotId}                — physical batch (sku, supplier, productionDate,
 *                                  expirationDate, originalQty, costPriceUnit, currency)
 *   /depots/{d}/lotStock/{lotId} — qty of a lot AT a depot (depotId, lotId, quantity)
 *   /movements/{movId}           — already global; gains lotId field
 *
 * Unlocks:
 *   real FEFO (oldest lot exits first by expirationDate, not by doc order)
 *   accurate per-lot costing (no proportional approximation)
 *   multi-container traceability (lot → invoice → container chain preserved)
 *   loss attribution (which supplier's batch expired)
 *
 * Migration sketch:
 *   1. Backfill /products from existing StockItems (group by sku).
 *   2. Backfill /lots from existing StockItems (one lot per existing doc, copying
 *      sourceDoc.invoiceNo/supplier and totalWeight).
 *   3. Convert each StockItem to a depot/lotStock entry pointing at its lot.
 *   4. Update applyMovement to debit lots in FEFO order, not the source doc directly.
 *   5. Drop StockItem.costBasis (derived from /lots costPriceUnit × current qty).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { db } from './firebase';
import {
  doc,
  collection,
  DocumentReference,
  serverTimestamp,
  Transaction,
  increment,
} from 'firebase/firestore';
import { StockItem, MovementType, UnitType } from '../types';

// ─── Unit Type ────────────────────────────────────────────────────────────────

const VALID_UNIT_TYPES: UnitType[] = ['carton', 'palette', 'kg', 'tonne', 'litre', 'piece'];

/** Resolves a UnitType from a stored hint or derives it from stockType. */
export function deriveUnitType(stockType: 'unitized' | 'bulk', hint?: string): UnitType {
  if (hint && (VALID_UNIT_TYPES as string[]).includes(hint)) return hint as UnitType;
  return stockType === 'bulk' ? 'kg' : 'carton';
}

// ─── Unit conversion ──────────────────────────────────────────────────────────

const KG_DEFAULTS: Record<UnitType, number> = {
  carton: 20, palette: 800, kg: 1, tonne: 1000, litre: 1, piece: 1,
};

/**
 * Converts a quantity in unitType units to kg.
 * Prefers unitWeight (from the lot) over category defaults.
 */
export function toKg(quantity: number, unitType: UnitType, unitWeight?: number | null): number {
  if (unitType === 'kg') return quantity;
  if (unitType === 'tonne') return quantity * 1000;
  if (unitWeight) return quantity * unitWeight;
  return quantity * KG_DEFAULTS[unitType];
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Guards the write boundary. Call with the RESULTING state after applying a delta.
 * Throws a user-visible error string on any invalid state.
 */
export function validateStockItem(item: Partial<StockItem>): void {
  if (item.quantity !== undefined && item.quantity < 0)
    throw new Error(`Quantité négative refusée: ${item.quantity}`);
  if (item.costBasis !== undefined && item.costBasis < 0)
    throw new Error(`Valeur stock négative refusée (costBasis: ${item.costBasis})`);
  if (item.costPrice !== null && item.costPrice !== undefined && item.costPrice < 0)
    throw new Error(`Prix unitaire négatif refusé: ${item.costPrice}`);
  if (item.unitType && !(VALID_UNIT_TYPES as string[]).includes(item.unitType))
    throw new Error(`unitType invalide: ${item.unitType}`);
}

// ─── Computed state ───────────────────────────────────────────────────────────

export interface StockComputedState {
  isExpired: boolean;
  daysToExpiry: number | null;
  fefoScore: number;
  isLowStock: boolean;
  statusLabel: string;
  statusColor: 'green' | 'orange' | 'red';
  /**
   * State-machine health for automation/alerts. Priority (highest first):
   * ARCHIVED > EXPIRED > CRITICAL > LOW > ACTIVE
   *   ARCHIVED — soft-deleted (status === 'archived')
   *   EXPIRED  — past expiration date
   *   CRITICAL — < 15 days to expiry, or aging > 90 days, or fefoScore > 60
   *   LOW      — quantity ≤ threshold (and not CRITICAL/EXPIRED)
   *   ACTIVE   — healthy default
   */
  healthStatus: 'ACTIVE' | 'LOW' | 'CRITICAL' | 'EXPIRED' | 'ARCHIVED';
}

/**
 * Single source of truth for derived display state from a StockItem.
 * UI components must call this instead of recomputing these values locally.
 */
export function computeStockState(item: StockItem): StockComputedState {
  const daysToExpiry = item.expirationDate
    ? Math.ceil((new Date(item.expirationDate).getTime() - Date.now()) / 86_400_000)
    : null;
  const isExpired = daysToExpiry !== null && daysToExpiry <= 0;
  const fefoScore = isExpired
    ? 100
    : daysToExpiry !== null
      ? Math.max(0, Math.round(((90 - daysToExpiry) / 90) * 100))
      : item.fefoScore;
  const isLowStock = item.quantity <= item.threshold && item.status !== 'delivered';

  let statusLabel = 'Disponible';
  let statusColor: 'green' | 'orange' | 'red' = 'green';
  if (isExpired) { statusLabel = 'Expiré'; statusColor = 'red'; }
  else if (daysToExpiry !== null && daysToExpiry < 15) { statusLabel = 'Alerte DLC'; statusColor = 'orange'; }
  else if (isLowStock) { statusLabel = 'Stock Bas'; statusColor = 'orange'; }

  // State machine — higher-priority states win
  const isCritical =
    (daysToExpiry !== null && daysToExpiry < 15) ||
    item.agingDays > 90 ||
    fefoScore > 60;
  let healthStatus: StockComputedState['healthStatus'] = 'ACTIVE';
  if (item.status === 'archived')   healthStatus = 'ARCHIVED';
  else if (isExpired)               healthStatus = 'EXPIRED';
  else if (isCritical)              healthStatus = 'CRITICAL';
  else if (isLowStock)              healthStatus = 'LOW';

  return { isExpired, daysToExpiry, fefoScore, isLowStock, statusLabel, statusColor, healthStatus };
}

// ─── Movement (low-level) ─────────────────────────────────────────────────────

export interface MovementPayload {
  type: MovementType;
  quantity: number;
  previousQty: number;
  newQty: number;
  reason: string;
  notes?: string;
  client?: string;
  targetDepotId?: string;
  transferRef?: string;
  userId: string;
  userName: string;
}

/**
 * Appends one movement record to a stock lot's local subcollection.
 * Works with both Transaction and WriteBatch (both expose .set()).
 * Used directly only by importInvoice (WriteBatch context).
 * All interactive mutations should go through applyMovement() instead.
 *
 * Path: depots/{depotId}/stock/{stockId}/movements/{movId}
 */
export function createMovement(
  writer: { set: (ref: DocumentReference, data: Record<string, unknown>) => unknown },
  stockRef: DocumentReference,
  payload: MovementPayload,
): void {
  const movRef = doc(collection(stockRef, 'movements'));
  writer.set(movRef, {
    id: movRef.id,
    ...payload,
    timestamp: serverTimestamp(),
    createdAt: serverTimestamp(),
  });
}

// ─── Movement (high-level) ────────────────────────────────────────────────────

export interface ApplyMovementOptions {
  /**
   * 'create' — new lot (transaction.set); requires createPayload.
   * 'update' — existing lot (transaction.get → validate → recompute → transaction.update).
   * Default: 'update'.
   */
  mode?: 'create' | 'update';
  type: MovementType;
  /** Signed quantity delta: positive for increases, negative for decreases. */
  quantityDelta: number;
  /** Signed cost delta matching quantityDelta direction. */
  costDelta: number;
  reason: string;
  notes?: string;
  client?: string;
  targetDepotId?: string;
  transferRef?: string;
  userId: string;
  userName: string;
  /** Required when mode === 'create'. Merged with id, quantity, costBasis, timestamps. */
  createPayload?: Record<string, unknown>;
}

/**
 * Single engine for all interactive stock mutations inside a Firestore Transaction.
 *
 * update mode (default):
 *   - Reads authoritative state via transaction.get() — never blindly increments.
 *   - Validates the RESULTING state before writing. Rejects negatives.
 *   - Writes absolute quantity/costBasis (not increment-based).
 *
 * create mode:
 *   - Sets a new lot (createPayload + id/timestamps from this function).
 *   - Validates the initial state. No prior read needed.
 *   - Eliminates the manual "set + createMovement + depot update" pattern.
 *
 * Both modes:
 *   - Depot load: dual-write current_load (unit count, UI compat) +
 *                 current_load_kg (kg, canonical for mixed-unit depots).
 *   - Movements: dual-write to /depots/{d}/stock/{s}/movements/ (detail view)
 *                and to /movements/ (global analytics + activity feed).
 */
/**
 * Enforces direction/intent rules per movement type.
 *  entry      — quantityDelta must be > 0
 *  exit       — quantityDelta must be < 0
 *  adjustment — requires a non-empty reason
 *  transfer   — caller must invoke applyMovement twice (source debit + dest credit);
 *               each leg's direction is validated by entry/exit rules above when
 *               the caller uses signed deltas, or skipped if type === 'transfer'
 *  split, edit — direction not enforced
 */
function validateMovementType(opts: ApplyMovementOptions): void {
  if (opts.type === 'entry' && opts.quantityDelta <= 0)
    throw new Error("Mouvement 'entry' doit augmenter la quantité (quantityDelta > 0)");
  if (opts.type === 'exit' && opts.quantityDelta >= 0)
    throw new Error("Mouvement 'exit' doit diminuer la quantité (quantityDelta < 0)");
  if (opts.type === 'adjustment' && (!opts.reason || !opts.reason.trim()))
    throw new Error("Mouvement 'adjustment' requiert un motif");
}

export async function applyMovement(
  transaction: Transaction,
  stockRef: DocumentReference,
  depotRef: DocumentReference,
  options: ApplyMovementOptions,
): Promise<void> {
  validateMovementType(options);
  const mode = options.mode ?? 'update';
  let previousQty = 0;
  let newQty: number;
  let newCostBasis: number;
  let unitType: UnitType = 'carton';
  let unitWeight: number | undefined;

  if (mode === 'create') {
    if (!options.createPayload)
      throw new Error('applyMovement: createPayload required in create mode');
    newQty       = options.quantityDelta;
    newCostBasis = options.costDelta;
    unitType     = (options.createPayload.unitType as UnitType | undefined) ?? 'carton';
    unitWeight   = options.createPayload.unitWeight as number | undefined;
    validateStockItem({ quantity: newQty, costBasis: newCostBasis, unitType });

    // SKU + LOT uniqueness guard — atomic check + reserve via deterministic guard doc.
    // Race-free: transaction.get ensures snapshot isolation; transaction.set reserves the slot.
    const guardSku     = (options.createPayload.sku      as string) || '';
    const guardLot     = (options.createPayload.lotNumber as string) || '';
    const guardDepotId = (options.createPayload.depotId  as string) || '';
    if (guardSku && guardLot && guardDepotId) {
      const guardKey = `${guardSku}_${guardLot}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
      const guardRef = doc(db, 'depots', guardDepotId, 'lotKeys', guardKey);
      const guardSnap = await transaction.get(guardRef);
      if (guardSnap.exists()) {
        throw new Error(
          `Lot ${guardLot} (SKU: ${guardSku}) existe déjà au dépôt ${guardDepotId}`
        );
      }
      transaction.set(guardRef, {
        sku: guardSku, lotNumber: guardLot, depotId: guardDepotId,
        stockId: stockRef.id, createdAt: serverTimestamp(),
      });
    }

    transaction.set(stockRef, {
      ...options.createPayload,
      id:        stockRef.id,
      quantity:  newQty,
      costBasis: newCostBasis,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: options.userId,
    });
  } else {
    const snap = await transaction.get(stockRef);
    if (!snap.exists()) throw new Error(`Lot introuvable: ${stockRef.path}`);
    const current = normalizeStockItem(snap.data() as Record<string, any>, snap.id);
    previousQty  = current.quantity;
    newQty       = previousQty + options.quantityDelta;
    newCostBasis = current.costBasis + options.costDelta;
    unitType     = current.unitType;
    unitWeight   = current.unitWeight;
    validateStockItem({ ...current, quantity: newQty, costBasis: newCostBasis });
    transaction.update(stockRef, {
      quantity:  newQty,
      costBasis: newCostBasis,
      updatedAt: serverTimestamp(),
    });
  }

  // Depot load — dual write for transition from carton-count to kg-based aggregation
  const depotDeltaKg = options.quantityDelta >= 0
    ? toKg(options.quantityDelta, unitType, unitWeight)
    : -toKg(-options.quantityDelta, unitType, unitWeight);
  transaction.update(depotRef, {
    current_load:    increment(options.quantityDelta), // legacy unit count (UI compat)
    current_load_kg: increment(depotDeltaKg),          // canonical kg (mixed-unit safe)
    updatedAt:       serverTimestamp(),
  });

  // Movement record (shared between local and global writes)
  const movData: Record<string, unknown> = {
    type:     options.type,
    quantity: Math.abs(options.quantityDelta),
    previousQty,
    newQty,
    reason:   options.reason,
    ...(options.notes         && { notes:         options.notes }),
    ...(options.client        && { client:        options.client }),
    ...(options.targetDepotId && { targetDepotId: options.targetDepotId }),
    ...(options.transferRef   && { transferRef:   options.transferRef }),
    userId:    options.userId,
    userName:  options.userName,
    timestamp: serverTimestamp(),
    createdAt: serverTimestamp(),
  };

  // Local: depots/{depotId}/stock/{stockId}/movements/{movId} — for StockDetail view
  const localMovRef = doc(collection(stockRef, 'movements'));
  transaction.set(localMovRef, { id: localMovRef.id, ...movData });

  // Global: /movements/{movId} — for dashboard analytics + cross-depot activity feed
  const globalMovRef = doc(collection(db, 'movements'));
  transaction.set(globalMovRef, {
    id:      globalMovRef.id,
    ...movData,
    stockId: stockRef.id,
    depotId: depotRef.id,
  });
}

// ─── Transfer (high-level) ────────────────────────────────────────────────────

export interface ApplyTransferOptions {
  /** Unit count to move (always positive). */
  amount: number;
  /** Proportional cost value to move (always positive). */
  costDelta: number;
  reason?: string;
  notes?: string;
  userId: string;
  userName: string;
  /** Name of the source depot, used to build the movement reason label. */
  currentDepotName?: string;
  /** True when the destination lot does not yet exist (create mode). */
  isNewLot?: boolean;
  /** Full payload for the new destination lot. Required when isNewLot === true. */
  destCreatePayload?: Record<string, unknown>;
}

/**
 * Atomically debits the source lot and credits the destination lot inside one
 * Firestore Transaction.
 *
 * Callers MUST use this instead of calling applyMovement({ type: 'transfer' })
 * directly. A raw transfer applyMovement call with no matching credit leg leaves
 * the system in a half-transferred state that is impossible to detect or repair.
 *
 * The entire operation lives inside the caller's runTransaction — pass the same
 * Transaction object the caller received. Any error (negative stock, duplicate lot,
 * etc.) will abort the whole transaction cleanly.
 */
export async function applyTransfer(
  transaction: Transaction,
  sourceStockRef: DocumentReference,
  sourceDepotRef: DocumentReference,
  destStockRef: DocumentReference,
  destDepotRef: DocumentReference,
  options: ApplyTransferOptions,
): Promise<void> {
  const { amount, costDelta, userId, userName, currentDepotName, isNewLot, destCreatePayload } = options;
  const reason = options.reason
    ?? (currentDepotName ? `Transfert depuis ${currentDepotName}` : 'Transfert');

  // Debit source
  await applyMovement(transaction, sourceStockRef, sourceDepotRef, {
    type:          'transfer',
    quantityDelta: -amount,
    costDelta:     -costDelta,
    reason,
    notes:         options.notes,
    targetDepotId: destDepotRef.id,
    userId,
    userName,
  });

  // Credit destination
  await applyMovement(transaction, destStockRef, destDepotRef, {
    mode:          isNewLot ? 'create' : 'update',
    type:          'transfer',
    quantityDelta: amount,
    costDelta,
    reason,
    notes:         options.notes,
    userId,
    userName,
    createPayload: isNewLot ? destCreatePayload : undefined,
  });
}

// ─── Legacy write guard ───────────────────────────────────────────────────────

const LEGACY_WRITE_FIELDS = [
  'fefo_score', 'depot_id', 'aging_days', 'cost_basis',
  'arrival_date', 'min_threshold', 'source_doc', 'issue_flags', 'edit_log',
];

/**
 * Warns (dev) or throws (production builds that opt-in) when a Firestore write
 * payload contains deprecated snake_case field names.
 * Call this at every direct transaction.set / transaction.update boundary that
 * is NOT inside applyMovement (which manages its own payload).
 */
export function assertNoLegacyFields(
  payload: Record<string, unknown>,
  context = 'write',
): void {
  const found = Object.keys(payload).filter(k => LEGACY_WRITE_FIELDS.includes(k));
  if (found.length === 0) return;
  const msg = `[DEPOTEK] Legacy snake_case fields in ${context}: ${found.join(', ')}`;
  console.warn(msg);
  // Hard-throw in dev so violations surface during review, not silently in prod.
  if (process.env.NODE_ENV !== 'production') throw new Error(msg);
}

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Maps any Firestore document (old snake_case or new camelCase) to the canonical
 * StockItem interface. Always call this when reading from a snapshot — never cast
 * raw doc.data() directly to StockItem.
 *
 * Also populates deprecated aliases (cartons, cost_basis, etc.) so existing UI
 * components keep working until they are updated to canonical field names.
 */
export function normalizeStockItem(raw: Record<string, any>, id: string): StockItem {
  const productName = raw.productName ?? raw.product ?? 'Sans nom';
  const depotId     = raw.depotId     ?? raw.depot_id ?? 'unassigned';
  const arrivalDate = raw.arrivalDate ?? raw.arrival_date ?? new Date().toISOString();
  const agingDays   = raw.agingDays   ?? raw.aging_days  ?? 0;
  const fefoScore   = raw.fefoScore   ?? raw.fefo_score  ?? 0;
  const threshold   = raw.threshold   ?? raw.min_threshold ?? 10;

  // quantity is canonical; cartons / units are legacy aliases
  const quantity      = raw.quantity ?? raw.cartons ?? raw.units ?? raw.totalWeightKg ?? 0;
  const totalWeightKg = raw.totalWeightKg ?? raw.kg ?? 0;
  const stockType: 'unitized' | 'bulk' = raw.stockType ?? 'unitized';
  const unitType = deriveUnitType(stockType, raw.unitType);

  const costPrice = raw.costPrice ?? raw.unitPrice ?? null;
  const costBasis = raw.costBasis ?? raw.cost_basis ?? raw.totalValue ?? 0;

  // Normalize status — reject computed values that should never be stored
  const validStatuses = ['quay_pad', 'stored', 'in_transit', 'delivered', 'archived'] as const;
  const rawStatus = raw.status ?? 'stored';
  const status = (validStatuses as readonly string[]).includes(rawStatus)
    ? (rawStatus as StockItem['status'])
    : 'stored';

  // Normalize sourceDoc — support both old snake_case and new camelCase shapes
  const sourceDoc = raw.sourceDoc
    ? raw.sourceDoc
    : raw.source_doc
      ? { invoiceNo: raw.source_doc.invoice_no, supplier: raw.source_doc.supplier, pdfUrl: raw.source_doc.pdf_url }
      : undefined;

  return {
    // ── Canonical fields ──────────────────────────────────────────────────
    id,
    sku:          raw.sku          ?? '',
    productName,
    category:     raw.category     ?? '',
    supplier:     raw.supplier,
    container:    raw.container,
    lotNumber:    raw.lotNumber    ?? raw.lot,
    depotId,
    location:     raw.location,
    stockType,
    unitType,
    quantity,
    unitWeight:   raw.unitWeight,
    totalWeightKg,
    costPrice,
    costPer:      raw.costPer      ?? (stockType === 'unitized' ? 'unit' : 'kg'),
    costCurrency: raw.costCurrency ?? raw.currency ?? 'XOF',
    costBasis,
    productionDate: raw.productionDate,
    expirationDate: raw.expirationDate ?? raw.expiration,
    arrivalDate,
    agingDays,
    fefoScore,
    status,
    threshold,
    transferRef:  raw.transferRef,
    createdAt:    raw.createdAt,
    updatedAt:    raw.updatedAt,
    createdBy:    raw.createdBy,
    sourceDoc,
    issueFlags:   raw.issueFlags   ?? raw.issue_flags,
    editLog:      raw.editLog      ?? raw.edit_log,
    photos:       raw.photos,
    // ── Deprecated aliases — pointing to canonical values ─────────────────
    // Keeps existing UI components working. Remove these from UI code over time.
    cartons:       quantity,
    cost_basis:    costBasis,
    aging_days:    agingDays,
    fefo_score:    fefoScore,
    arrival_date:  arrivalDate,
    depot_id:      depotId,
    product:       productName,
    min_threshold: threshold,
    units:         quantity,
    totalValue:    costBasis,
    unitPrice:     costPrice ?? undefined,
    source_doc:    raw.source_doc,
  };
}
