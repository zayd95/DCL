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

  return { isExpired, daysToExpiry, fefoScore, isLowStock, statusLabel, statusColor };
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
export async function applyMovement(
  transaction: Transaction,
  stockRef: DocumentReference,
  depotRef: DocumentReference,
  options: ApplyMovementOptions,
): Promise<void> {
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
