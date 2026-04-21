
export type StockStatus = 'quay_pad' | 'stored' | 'in_transit' | 'delivered' | 'at_sea' | 'port_arrival' | 'customs_clearance';
export type MouvementType = 'RECEPTION' | 'SORTIE' | 'TRANSFER' | 'SPLIT' | 'CANCEL' | 'EDIT';
export type UserRole = 'magasinier' | 'manager' | 'cfo';

export type DocCategory = 'invoice' | 'bill_of_lading' | 'sanitary_certificate' | 'halal_certificate' | 'temperature_log' | 'customs' | 'packing_list' | 'other';
export type DocStatus = 'processing' | 'completed' | 'error';

export interface AuditEntry {
  field: string;
  old: any;
  new: any;
  user: string;
  reason: string;
  timestamp: string;
}

export interface StockMovement {
  id: string;
  type: "entry" | "exit" | "transfer" | "adjustment" | "reception" | "sortie" | "edit";
  quantity: number;
  previousQty: number;
  newQty: number;
  reason: string;
  notes: string;
  client?: string;
  userId: string;
  userName: string;
  timestamp: any;
  createdAt?: any;
}

export interface StockItem {
  id: string;
  container: string;
  product: string;
  productName?: string; // Unified name
  sku?: string;
  category?: string;
  unit?: string;
  depotId?: string; // Unified with prompt requirement
  depot_id?: string; // Backward compatibility
  location?: string; // Specific location (Allée A...)
  quantity?: number; // Current quantity
  cartons?: number; // Backward compatibility
  initialQuantity?: number;
  threshold?: number;
  min_threshold?: number; // Restored for backward compatibility
  kg?: number; // Restored
  productionDate?: any;
  expirationDate?: any;
  arrival_date?: string; // Restored
  lotNumber?: string;
  supplier?: string;
  status: StockStatus | "active" | "expired" | "low_stock" | "archived";
  fefo_score: number;
  aging_days: number;
  cost_basis: number;
  unitPrice?: number;
  costPrice?: number;
  costPer?: 'unit' | 'kg';
  currency?: string;
  costCurrency?: string;
  stockType?: 'unitized' | 'bulk';
  units?: number;
  unitWeight?: number;
  totalWeightKg?: number;
  totalValue?: number;
  derivedFromContainer?: boolean;
  transferRef?: string;
  createdAt: any;
  updatedAt?: any;
  createdBy?: string;
  source_doc?: {
    invoice_no: string;
    supplier: string;
    pdf_url?: string;
  };
  edit_log?: AuditEntry[];
  photos?: string[];
  issue_flags?: ('damaged' | 'temp_breach' | 'shortage')[];
}

export interface Depot {
  id: string;
  name: string;
  code: string;
  type: 'frozen' | 'cold' | 'dry';
  location: { lat: number; lng: number };
  manager_uid: string;
  capacity_cartons: number;
  current_load: number;
  temp_range?: string;
  color: string;
  created_at?: any;
}

export interface Mouvement {
  id: string;
  type: MouvementType;
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

export interface UserProfile {
  id: string;
  name: string;
  phone: string;
  role: UserRole;
  depot_id?: string;
  fcm_token?: string;
}

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

export interface TrackingStep {
  status: StockStatus;
  location: string;
  timestamp: any;
  note?: string;
}

export interface ContainerInfo {
  id: string;
  containerNumber: string;
  status: StockStatus;
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
