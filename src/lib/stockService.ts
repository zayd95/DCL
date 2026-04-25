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
import { StockItem, MovementType, UnitType, LotDoc, LotStockDoc, LotGuardDoc } from '../types';

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

// ─── Lot helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the XOF conversion rate for a currency, locked at import time.
 * EUR/XOF is the fixed CFA peg (immutable by treaty).
 * USD/XOF uses an approximation; the Reception form should pass the live rate
 * as createPayload.exchangeRateAtImport to override this default.
 */
export function resolveXofRate(currency: 'XOF' | 'USD' | 'EUR'): number {
  if (currency === 'XOF') return 1;
  if (currency === 'EUR') return 655.957;
  return 600; // USD fallback — override via createPayload.exchangeRateAtImport
}

/** Deterministic document ID for /stockView — sanitized, max 100 chars. */
export function stockViewId(depotId: string, sku: string): string {
  return `${depotId}_${sku}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
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
   * Client-generated unique ID for this movement. Used as:
   *   1. Idempotency key — if /movements/{movementId} already exists, the entire
   *      applyMovement call is a safe no-op (protects against app-layer retries).
   *   2. Document ID for both the global /movements/{movId} and the local
   *      depots/{d}/stock/{s}/movements/{movId} records.
   * Generate with: doc(collection(db, 'movements')).id  BEFORE runTransaction.
   */
  movementId: string;
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

  // ① Idempotency — first read in every path. If the movement was already committed
  //   (same movementId from an app-layer retry), return cleanly without any writes.
  const globalMovRef = doc(db, 'movements', options.movementId);
  const idempSnap    = await transaction.get(globalMovRef);
  if (idempSnap.exists()) return;

  const mode = options.mode ?? 'update';
  let previousQty  = 0;
  let newQty: number;
  let newCostBasis: number;
  let unitType: UnitType  = 'carton';
  let unitWeight: number | undefined;
  let lotId: string | undefined;
  let sku:   string | undefined;

  // ─────────────────────────────────────────────────────────────── CREATE ──────
  if (mode === 'create') {
    if (!options.createPayload)
      throw new Error('applyMovement: createPayload required in create mode');

    newQty       = options.quantityDelta;
    newCostBasis = options.costDelta;
    unitType     = (options.createPayload.unitType  as UnitType | undefined) ?? 'carton';
    unitWeight   = options.createPayload.unitWeight as number | undefined;
    sku          = (options.createPayload.sku       as string)  || '';

    const lotNumber = (options.createPayload.lotNumber as string) || '';
    const depotId   = (options.createPayload.depotId  as string) || depotRef.id;

    validateStockItem({ quantity: newQty, costBasis: newCostBasis, unitType });

    // ② Lot identity — global guard at /lotGuards/{sku}_{lotNumber}.
    //   Race-free: transaction.get establishes the snapshot; concurrent writers retry.
    const guardKey  = sku && lotNumber
      ? `${sku}_${lotNumber}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)
      : null;
    const guardRef  = guardKey ? doc(db, 'lotGuards', guardKey)     : null;
    const guardSnap = guardRef ? await transaction.get(guardRef) : null;

    let costPriceUnitXof: number;

    if (guardSnap?.exists()) {
      // Same sku+lotNumber already exists — reuse the canonical lotId.
      // Valid case: same physical lot split across two depots.
      lotId = guardSnap.data().lotId as string;

      // Reject if this lot is already active at THIS depot (true duplicate).
      const existingLotStock = await transaction.get(
        doc(db, 'depots', depotId, 'lotStock', lotId),
      );
      if (existingLotStock.exists() && existingLotStock.data().isActive) {
        throw new Error(
          `Lot ${lotNumber} (SKU: ${sku}) est déjà actif au dépôt ${depotId}`,
        );
      }

      // Read costPriceUnitXof from the existing lot for stockView value delta.
      const existingLot = await transaction.get(doc(db, 'lots', lotId));
      costPriceUnitXof  = existingLot.exists()
        ? (existingLot.data().costPriceUnitXof as number ?? 0)
        : 0;
    } else {
      // ③ New lot — create /lots, /products catalog, and guard atomically.
      lotId = doc(collection(db, 'lots')).id;

      const currency    = (options.createPayload.costCurrency as 'XOF' | 'USD' | 'EUR') || 'XOF';
      const xofRate     = (options.createPayload.exchangeRateAtImport as number | undefined)
        ?? resolveXofRate(currency);
      const cpUnit      = options.createPayload.costPrice as number | null ?? null;
      costPriceUnitXof  = cpUnit != null ? cpUnit * xofRate : 0;

      const lotPayload: LotDoc = {
        lotId,
        sku,
        lotNumber,
        supplier:             (options.createPayload.supplier    as string) || '',
        containerNo:          (options.createPayload.container   as string)
                           || (options.createPayload.containerNo as string) || '',
        productionDate:       (options.createPayload.productionDate  as string) || '',
        expirationDate:       (options.createPayload.expirationDate  as string) || '',
        originalQty:          newQty,
        unitType,
        unitWeight:           unitWeight ?? null,
        costPriceUnit:        cpUnit,
        costCurrency:         currency,
        exchangeRateAtImport: xofRate,
        costPriceUnitXof,
        originalDepotId:      depotId,
        totalQuantity:        newQty,
        status:               'active',
        sourceDoc:            (options.createPayload.sourceDoc as LotDoc['sourceDoc']) ?? null,
        createdAt:            serverTimestamp(),
        createdBy:            options.userId,
      };
      transaction.set(doc(db, 'lots', lotId), lotPayload);

      // Upsert /products catalog — merge preserves existing catalog data.
      if (sku) {
        transaction.set(doc(db, 'products', sku), {
          sku,
          productName:       options.createPayload.productName ?? sku,
          category:          options.createPayload.category    ?? '',
          unitTypeDefault:   unitType,
          unitWeightDefault: unitWeight ?? null,
          thresholdGlobal:   (options.createPayload.threshold as number) ?? 10,
          updatedAt:         serverTimestamp(),
        }, { merge: true });
      }

      if (guardRef) {
        const guardPayload: LotGuardDoc = {
          sku, lotNumber, lotId, createdAt: serverTimestamp(),
        };
        transaction.set(guardRef, guardPayload);
      }
    }

    // ④ LotStock — live quantity of this lot at this depot.
    const lotStockPayload: LotStockDoc = {
      lotId:             lotId!,
      sku:               sku || '',
      depotId,
      quantity:          newQty,
      isActive:          newQty > 0,
      expirationSortKey: (options.createPayload.expirationDate as string) || '9999-12-31',
      productionDate:    (options.createPayload.productionDate  as string) || '',
      costPriceUnitXof,
      createdAt:         serverTimestamp(),
      updatedAt:         serverTimestamp(),
    };
    transaction.set(doc(db, 'depots', depotId, 'lotStock', lotId!), lotStockPayload);

    // ⑤ StockView — increment numeric counters in-transaction.
    //   earliestExpiration + fefoUrgency maintained by Cloud Function (eventual).
    const kgCreate  = toKg(newQty, unitType, unitWeight);
    transaction.set(doc(db, 'stockView', stockViewId(depotId, sku || '')), {
      sku:           sku || '',
      depotId,
      totalQuantity: increment(newQty),
      totalWeightKg: increment(kgCreate),
      totalValueXof: increment(newQty * costPriceUnitXof),
      lotsCount:     increment(1),
      lastUpdated:   serverTimestamp(),
    }, { merge: true });

    // ⑥ Legacy stock doc — dual-written for UI compat; includes lotId as forward ref.
    transaction.set(stockRef, {
      ...options.createPayload,
      id:        stockRef.id,
      lotId:     lotId!,
      quantity:  newQty,
      costBasis: newCostBasis,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: options.userId,
    });

  // ─────────────────────────────────────────────────────────────── UPDATE ──────
  } else {
    const snap = await transaction.get(stockRef);
    if (!snap.exists()) throw new Error(`Lot introuvable: ${stockRef.path}`);
    const current = normalizeStockItem(snap.data() as Record<string, any>, snap.id);
    previousQty  = current.quantity;
    newQty       = previousQty + options.quantityDelta;
    newCostBasis = current.costBasis + options.costDelta;
    unitType     = current.unitType;
    unitWeight   = current.unitWeight;
    lotId        = (snap.data() as any).lotId as string | undefined;
    sku          = current.sku;

    validateStockItem({ ...current, quantity: newQty, costBasis: newCostBasis });

    // Legacy update (always)
    transaction.update(stockRef, {
      quantity:  newQty,
      costBasis: newCostBasis,
      updatedAt: serverTimestamp(),
    });

    // Lot-based updates — Phase-0+ docs have lotId on the legacy record.
    // Pre-Phase-0 docs without lotId skip gracefully; they'll be backfilled in Phase 1.
    if (lotId && sku) {
      const lotStockRef  = doc(db, 'depots', depotRef.id, 'lotStock', lotId);
      const lotRef       = doc(db, 'lots', lotId);

      const lotStockSnap = await transaction.get(lotStockRef);
      const costXof      = lotStockSnap.exists()
        ? (lotStockSnap.data().costPriceUnitXof as number ?? 0)
        : 0;

      transaction.update(lotStockRef, {
        quantity:  newQty,
        isActive:  newQty > 0,
        updatedAt: serverTimestamp(),
      });

      transaction.update(lotRef, {
        totalQuantity: increment(options.quantityDelta),
        updatedAt:     serverTimestamp(),
      });

      const kgDelta  = options.quantityDelta >= 0
        ? toKg(options.quantityDelta, unitType, unitWeight)
        : -toKg(-options.quantityDelta, unitType, unitWeight);
      const viewData: Record<string, unknown> = {
        sku,
        depotId:       depotRef.id,
        totalQuantity: increment(options.quantityDelta),
        totalWeightKg: increment(kgDelta),
        totalValueXof: increment(options.quantityDelta * costXof),
        lastUpdated:   serverTimestamp(),
      };
      // Decrement lotsCount exactly when this lot transitions from active to depleted.
      if (newQty === 0 && previousQty > 0) viewData.lotsCount = increment(-1);
      transaction.set(doc(db, 'stockView', stockViewId(depotRef.id, sku)), viewData, { merge: true });
    }
  }

  // ⑦ Depot load — dual write: legacy unit count (UI compat) + canonical kg.
  const depotDeltaKg = options.quantityDelta >= 0
    ? toKg(options.quantityDelta, unitType, unitWeight)
    : -toKg(-options.quantityDelta, unitType, unitWeight);
  transaction.update(depotRef, {
    current_load:    increment(options.quantityDelta),
    current_load_kg: increment(depotDeltaKg),
    updatedAt:       serverTimestamp(),
  });

  // ⑧ Movement records — lotId + sku always present; movementId is the idempotency key.
  const movData: Record<string, unknown> = {
    type:     options.type,
    quantity: Math.abs(options.quantityDelta),
    previousQty,
    newQty,
    reason:   options.reason,
    lotId:    lotId ?? `legacy:${stockRef.id}`,
    sku:      sku   ?? '',
    ...(options.notes         && { notes:         options.notes }),
    ...(options.client        && { client:        options.client }),
    ...(options.targetDepotId && { targetDepotId: options.targetDepotId }),
    ...(options.transferRef   && { transferRef:   options.transferRef }),
    userId:    options.userId,
    userName:  options.userName,
    timestamp: serverTimestamp(),
    createdAt: serverTimestamp(),
  };

  // Local subcollection — keyed by movementId for consistent addressing.
  const localMovRef = doc(
    db, 'depots', depotRef.id, 'stock', stockRef.id, 'movements', options.movementId,
  );
  transaction.set(localMovRef, { id: options.movementId, ...movData });

  // Global /movements — doc ID = movementId (idempotency key).
  transaction.set(globalMovRef, {
    id:      options.movementId,
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
  /**
   * Idempotency key for the source debit movement.
   * Generate with doc(collection(db,'movements')).id BEFORE runTransaction.
   */
  sourceMovementId: string;
  /**
   * Idempotency key for the destination credit movement.
   * Must be a different ID from sourceMovementId.
   */
  destMovementId: string;
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
  const {
    amount, costDelta, userId, userName,
    currentDepotName, isNewLot, destCreatePayload,
    sourceMovementId, destMovementId,
  } = options;
  const reason = options.reason
    ?? (currentDepotName ? `Transfert depuis ${currentDepotName}` : 'Transfert');

  // Debit source
  await applyMovement(transaction, sourceStockRef, sourceDepotRef, {
    movementId:    sourceMovementId,
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
    movementId:    destMovementId,
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
