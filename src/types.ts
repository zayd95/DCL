
// ─── Primitives ───────────────────────────────────────────────────────────────

export type StockStatus =
  | 'quay_pad'    // at quay, not yet received
  | 'stored'      // in depot, available
  | 'in_transit'  // being transferred between depots
  | 'delivered'   // delivered to client
  | 'archived';   // soft-deleted

/** All movement types for a stock lot. Path: depots/{id}/stock/{id}/movements/{id} */
export type MovementType =
  | 'entry'       // stock received / added
  | 'exit'        // stock dispatched to client
  | 'transfer'    // moved between depots
  | 'split'       // lot divided
  | 'edit'        // manual correction
  | 'adjustment'; // inventory count correction

export type UserRole = 'magasinier' | 'manager' | 'cfo';

export type UnitType = 'carton' | 'palette' | 'kg' | 'tonne' | 'litre' | 'piece';

export type DocCategory =
  | 'invoice' | 'bill_of_lading' | 'sanitary_certificate'
  | 'halal_certificate' | 'temperature_log' | 'customs'
  | 'packing_list' | 'other';

export type DocStatus = 'processing' | 'completed' | 'error';

// ─── Audit ────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  field: string;
  old: unknown;
  new: unknown;
  user: string;
  reason: string;
  timestamp: string;
}

// ─── Stock ────────────────────────────────────────────────────────────────────

export interface StockItem {
  // Identity
  id: string;
  sku: string;
  productName: string;
  category: string;
  supplier?: string;
  container?: string;
  lotNumber?: string;

  // Location
  depotId: string;
  location?: string;

  // Quantity model
  stockType: 'unitized' | 'bulk';
  unitType: UnitType;
  /**
   * Canonical quantity.
   * unitized → carton / unit count
   * bulk     → weight in kg
   */
  quantity: number;
  unitWeight?: number;    // kg per unit — unitized only
  totalWeightKg: number;  // always set; derived (quantity × unitWeight) or direct

  // Financials
  costPrice: number | null;
  costPer: 'unit' | 'kg';
  costCurrency: 'XOF' | 'USD' | 'EUR';
  /** Total portfolio value in costCurrency */
  costBasis: number;

  // FEFO / traceability
  productionDate?: string;  // ISO date
  expirationDate?: string;  // ISO date
  arrivalDate: string;      // ISO date, always set
  agingDays: number;
  fefoScore: number;

  // State
  status: StockStatus;
  /** Low-stock alert level (same unit as quantity) */
  threshold: number;

  // Transfer
  transferRef?: string;

  // Audit
  createdAt: any;
  updatedAt?: any;
  createdBy?: string;

  sourceDoc?: {
    invoiceNo: string;
    supplier: string;
    pdfUrl?: string;
  };

  issueFlags?: ('damaged' | 'temp_breach' | 'shortage')[];
  editLog?: AuditEntry[];
  photos?: string[];

  // ── Deprecated aliases ────────────────────────────────────────────────────
  // Set by normalizeStockItem() so existing UI code keeps working until updated.
  // New code must use the canonical fields above.
  /** @deprecated use quantity */    cartons?: number;
  /** @deprecated use costBasis */   cost_basis?: number;
  /** @deprecated use agingDays */   aging_days?: number;
  /** @deprecated use fefoScore */   fefo_score?: number;
  /** @deprecated use arrivalDate */ arrival_date?: string;
  /** @deprecated use depotId */     depot_id?: string;
  /** @deprecated use productName */ product?: string;
  /** @deprecated use threshold */   min_threshold?: number;
  /** @deprecated use quantity */    units?: number;
  /** @deprecated use costBasis */   totalValue?: number;
  /** @deprecated use costPrice */   unitPrice?: number;
  /** @deprecated use costPer */     costCurrency_?: string;
  // raw source_doc kept for normalizer to read
  source_doc?: { invoice_no: string; supplier: string; pdf_url?: string };
}

// ─── Movement ─────────────────────────────────────────────────────────────────
// Canonical path: depots/{depotId}/stock/{stockId}/movements/{movId}

export interface StockMovement {
  id: string;
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
  timestamp: any;
  createdAt: any;
}

// ─── Depot ────────────────────────────────────────────────────────────────────

export interface Depot {
  id: string;
  name: string;
  code: string;
  type: 'frozen' | 'cold' | 'dry';
  location: { lat: number; lng: number };
  manager_uid: string;
  capacity_cartons: number;
  current_load: number;        // unit count (legacy — UI uses this)
  current_load_kg?: number;    // kg aggregate (canonical for mixed-unit depots)
  temp_range?: string;
  color: string;
  created_at?: any;
}

// ─── User ─────────────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  name: string;
  phone: string;
  role: UserRole;
  depot_id?: string;
  fcm_token?: string;
}

// ─── Documents ────────────────────────────────────────────────────────────────

export interface Invoice {
  id: string;
  file_name: string;
  pdf_url: string;
  parsed_data: {
    supplier: string;
    origin: string;
    product: string;
    total_value_usd: number;
    total_cartons: number;
    containers: { id: string; cartons: number }[];
  };
  assigned_depot_id?: string;
  status: 'pending' | 'confirmed' | 'archived';
  created_by: string;
}

export interface DocumentEntry {
  id: string;
  fileName: string;
  fileType: string;
  downloadURL: string;
  category: DocCategory;
  status: DocStatus;
  extraitsIA?: {
    containerNumber?: string;
    invoiceNumber?: string;
    supplier?: string;
    products?: { name: string; quantity: number }[];
    dates?: { arrival?: string; expiry?: string };
    totalValue?: number;
  };
  extractedData?: {
    containerNumber?: string;
    invoiceNumber?: string;
    supplier?: string;
    products?: { name: string; quantity: number }[];
    dates?: { arrival?: string; expiry?: string };
    totals?: { amount: number; currency: string };
    compliance?: {
      hasSanitaryCertificate: boolean;
      hasTemperatureLog: boolean;
      hasCustomsDeclaration: boolean;
    };
  };
  linkedContainer?: string;
  actionTaken?: 'new_container' | 'depot_add' | 'other';
  createdAt: any;
  createdBy: string;
}

// ─── Tracking ─────────────────────────────────────────────────────────────────

export type ContainerStatus =
  | 'at_sea' | 'port_arrival' | 'customs_clearance'
  | 'quay_pad' | 'stored' | 'in_transit' | 'delivered';

export interface TrackingStep {
  status: ContainerStatus;
  location: string;
  timestamp: any;
  note?: string;
}

export interface ContainerInfo {
  id: string;
  containerNumber: string;
  status: ContainerStatus;
  origin: string;
  destination: string;
  eta: any;
  ata?: any;
  products: { productName: string; sku: string; quantity: number }[];
  linkedDocuments: { docId: string; fileName: string; category: DocCategory; downloadURL: string }[];
  trackingHistory: TrackingStep[];
  compliance: {
    sanitaryCertificate: boolean;
    temperatureLog: boolean;
    customsDeclaration: boolean;
    halalCertificate: boolean;
    originCertificate: boolean;
  };
  complianceScore: number;
  createdAt: any;
  updatedAt: any;
}

// ─── Lot system (Phase 0+) ────────────────────────────────────────────────────
// Path: /lots/{lotId}

export interface LotDoc {
  lotId: string;
  sku: string;
  lotNumber: string;
  supplier?: string;
  containerNo?: string;
  productionDate?: string;
  expirationDate?: string;
  originalQty: number;
  unitType: UnitType;
  unitWeight?: number | null;
  costPriceUnit: number | null;
  costCurrency: 'XOF' | 'USD' | 'EUR';
  /** Rate to XOF locked at import time. 1 for XOF, 655.957 for EUR, live rate for USD. */
  exchangeRateAtImport: number;
  /** costPriceUnit × exchangeRateAtImport — locked for aggregation. */
  costPriceUnitXof: number;
  originalDepotId: string;
  /** Global counter across all depots. Updated via increment() in applyMovement. */
  totalQuantity: number;
  /** Set by Cloud Function when totalQuantity reaches 0. Never written from client. */
  status: 'active' | 'depleted' | 'archived';
  sourceDoc?: { invoiceNo?: string; supplier?: string; pdfUrl?: string } | null;
  createdAt: any;
  createdBy: string;
}

// Path: /depots/{d}/lotStock/{lotId}
export interface LotStockDoc {
  lotId: string;
  sku: string;
  depotId: string;
  quantity: number;
  /** true when quantity > 0; enables cheap equality index instead of range query. */
  isActive: boolean;
  /** lot.expirationDate ?? '9999-12-31' — sentinel makes nulls sort last. */
  expirationSortKey: string;
  productionDate: string;
  /** Denormalized from lot for in-transaction stockView value deltas. */
  costPriceUnitXof: number;
  createdAt: any;
  updatedAt: any;
}

// Path: /stockView/{depotId}_{sku}
export interface StockViewDoc {
  sku: string;
  depotId: string;
  /** Maintained via increment() in applyMovement. */
  totalQuantity: number;
  totalWeightKg: number;
  totalValueXof: number;
  lotsCount: number;
  /** Set by Cloud Function — may lag ~2 s. UI falls back to lotStock query if null. */
  earliestExpiration: string | null;
  fefoUrgency: 'ACTIVE' | 'LOW' | 'CRITICAL' | 'EXPIRED';
  lastUpdated: any;
}

// Path: /lotGuards/{sku}_{lotNumber}
export interface LotGuardDoc {
  sku: string;
  lotNumber: string;
  /** Canonical lotId for this sku+lotNumber pair — reused across depots. */
  lotId: string;
  createdAt: any;
}

// ─── Legacy ───────────────────────────────────────────────────────────────────

/** @deprecated use StockMovement */
export interface Mouvement {
  id: string;
  type: string;
  lot_id: string;
  depot_id: string;
  target_depot_id?: string;
  qty_change: number;
  client_name?: string;
  document_url?: string;
  user_id: string;
  reason?: string;
  timestamp: string;
  createdAt?: any;
}
