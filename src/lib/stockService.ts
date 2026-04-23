import {
  doc,
  collection,
  DocumentReference,
  serverTimestamp,
} from 'firebase/firestore';
import { StockItem, StockMovement, MovementType } from '../types';

// ─── Movement ─────────────────────────────────────────────────────────────────

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
 * Appends a movement record to a stock lot's movements subcollection.
 * Works with both Firestore Transaction and WriteBatch — both expose .set().
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
  const quantity     = raw.quantity ?? raw.cartons ?? raw.units ?? raw.totalWeightKg ?? 0;
  const totalWeightKg = raw.totalWeightKg ?? raw.kg ?? 0;
  const stockType: 'unitized' | 'bulk' = raw.stockType ?? 'unitized';

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
    cartons:      quantity,
    cost_basis:   costBasis,
    aging_days:   agingDays,
    fefo_score:   fefoScore,
    arrival_date: arrivalDate,
    depot_id:     depotId,
    product:      productName,
    min_threshold: threshold,
    units:        quantity,
    totalValue:   costBasis,
    unitPrice:    costPrice ?? undefined,
    source_doc:   raw.source_doc,
  };
}
