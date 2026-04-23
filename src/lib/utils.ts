
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCFA(amount: number) {
  return new Intl.NumberFormat('fr-SN', {
    style: 'currency',
    currency: 'XOF',
    minimumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('fr-SN');
}

export function isFefoAlert(item: any) {
  if (!item) return false;
  // Prefer canonical fields; fall back to deprecated aliases for old Firestore docs
  const score     = item.fefoScore   ?? item.fefo_score   ?? 0;
  const agingDays = item.agingDays   ?? item.aging_days   ?? 0;
  return agingDays > 90 || score > 60;
}

export function isLowStockAlert(item: any) {
  if (!item) return false;
  // quantity is canonical; cartons/units are backward-compat aliases
  const qty = item.quantity ?? item.cartons ?? item.units ?? 0;
  const threshold = item.threshold ?? item.min_threshold;
  if (threshold === undefined || threshold === null) return false;
  return qty <= threshold && item.status !== 'delivered';
}

export function handleFirestoreError(error: any, operationType: string, path: string | null = null, auth: any = null) {
  const errorInfo = {
    error: error.message || 'Unknown error',
    operationType,
    path,
    authInfo: auth ? {
      userId: auth.currentUser?.uid || 'anonymous',
      email: auth.currentUser?.email || 'N/A',
      emailVerified: auth.currentUser?.emailVerified || false,
      isAnonymous: auth.currentUser?.isAnonymous || false,
      providerInfo: auth.currentUser?.providerData.map((p: any) => ({
        providerId: p.providerId,
        displayName: p.displayName,
        email: p.email
      })) || []
    } : 'No Auth Provided'
  };
  
  if (error.message?.includes('insufficient permissions')) {
    console.error("Firestore Security Error:", JSON.stringify(errorInfo, null, 2));
    throw new Error(JSON.stringify(errorInfo));
  }
  
  throw error;
}

export function validateStock(formData: any) {
  const errors: string[] = [];
  if (!formData.productName) errors.push("Le nom du produit est requis");
  if (!formData.sku) errors.push("Le SKU est requis");
  if (!formData.category) errors.push("La catégorie est requise");
  if (!formData.depotId) errors.push("Le dépôt est requis");
  if (!formData.quantity || formData.quantity <= 0) errors.push("Une quantité valide est requise");
  if (!formData.expirationDate) errors.push("La date d'expiration est requise");
  
  if (formData.expirationDate) {
    const expDate = new Date(formData.expirationDate);
    const now = new Date();
    if (expDate <= now) {
      errors.push("Le produit est déjà expiré");
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

export function getStatusColor(expirationDate: string | null, quantity: number, threshold: number = 10) {
  if (!expirationDate) return '#22c55e'; // Green default

  const diff = new Date(expirationDate).getTime() - new Date().getTime();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));

  if (days <= 0) return '#ef4444'; // Red: Expired
  if (days <= 7) return '#ef4444'; // Red: Critical FEFO
  if (days <= 30) return '#f59e0b'; // Yellow: Warning FEFO
  
  if (quantity <= threshold) return '#f59e0b'; // Yellow: Low Stock

  return '#22c55e'; // Green: Good
}

/**
 * Unifies stock data calculation and normalization for Dakar Cold Link HUB.
 * Ensures consistent storage between creation and update.
 */
/**
 * Produces a canonical StockItem payload for Firestore writes.
 * Outputs ONLY canonical camelCase fields — no legacy aliases.
 * Call normalizeStockItem() when reading back from Firestore.
 */
export function computeStockPayload(input: any): Omit<import('../types').StockItem, 'id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'editLog' | 'photos' | 'issueFlags'> {
  const stockType: 'unitized' | 'bulk' = input.stockType ?? 'unitized';

  // Accept both form field names and canonical names
  const rawUnits = input.units ?? input.cartons;
  const unitQty  = stockType === 'unitized' ? (Number(rawUnits) || null) : null;
  const unitWeight = stockType === 'unitized' ? (Number(input.unitWeight) || null) : null;

  const rawCost = input.costPrice !== undefined ? input.costPrice : (input.unitPrice ?? null);
  const costPrice = (rawCost !== '' && rawCost !== null && rawCost !== undefined)
    ? Number(rawCost) : null;

  let totalWeightKg = 0;
  if (stockType === 'unitized') {
    totalWeightKg = (unitQty || 0) * (unitWeight || 0);
  } else {
    totalWeightKg = Number(input.totalWeightKg ?? input.kg) || 0;
  }

  // quantity: unit count for unitized, kg for bulk
  const quantity = unitQty ?? totalWeightKg;

  const costPer: 'unit' | 'kg' = input.costPer ?? (stockType === 'unitized' ? 'unit' : 'kg');
  let costBasis = 0;
  if (costPrice !== null) {
    costBasis = costPer === 'kg' ? totalWeightKg * costPrice : quantity * costPrice;
  }

  const productName = input.productName ?? input.product ?? 'Sans nom';
  const depotId     = input.depotId ?? input.depot_id ?? 'unassigned';
  const threshold   = Number(input.threshold ?? input.min_threshold) || 10;
  const arrivalDate = input.arrivalDate ?? input.arrival_date ?? new Date().toISOString();

  return {
    sku:          input.sku          ?? '',
    productName,
    category:     input.category     ?? '',
    supplier:     input.supplier     ?? '',
    container:    input.container    ?? '',
    lotNumber:    input.lotNumber    ?? input.lot ?? '',
    depotId,
    location:     input.location     ?? '',
    stockType,
    quantity,
    unitWeight,
    totalWeightKg,
    costPrice,
    costPer,
    costCurrency: input.costCurrency ?? 'XOF',
    costBasis,
    productionDate: input.productionDate ?? '',
    expirationDate: input.expirationDate ?? input.expiration ?? '',
    arrivalDate,
    agingDays:   input.agingDays   ?? input.aging_days   ?? 0,
    fefoScore:   input.fefoScore   ?? input.fefo_score   ?? 0,
    status:      input.status      ?? 'stored',
    threshold,
    transferRef: input.transferRef,
    sourceDoc:   input.sourceDoc,
  };
}
