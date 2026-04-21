
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
  
  // Scoring logic integration
  const score = item.fefo_score || 0;
  
  // Aging logic
  let agingDays = 0;
  if (item.aging_days !== undefined) {
    agingDays = item.aging_days;
  } else if (item.arrival_date) {
    const arrivalDate = new Date(item.arrival_date);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - arrivalDate.getTime());
    agingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }
  
  return agingDays > 90 || score > 60;
}

export function isLowStockAlert(item: any) {
  if (!item || item.min_threshold === undefined) return false;
  return item.cartons <= item.min_threshold && item.status !== 'delivered';
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
export function computeStockPayload(input: any) {
  const stockType = input.stockType || 'unitized';
  const units = stockType === 'unitized' ? (Number(input.units) || null) : null;
  const unitWeight = stockType === 'unitized' ? (Number(input.unitWeight) || null) : null;
  
  // Cost normalization
  const rawCost = input.costPrice !== undefined ? input.costPrice : input.unitPrice;
  const costPrice = (rawCost !== '' && rawCost !== null && rawCost !== undefined) ? Number(rawCost) : null;
  
  // Weight logic
  let totalWeightKg = 0;
  if (stockType === 'unitized') {
    totalWeightKg = (units || 0) * (unitWeight || 0);
  } else {
    totalWeightKg = Number(input.totalWeightKg) || 0;
  }

  // Financial logic
  let totalValue = null;
  if (costPrice !== null) {
    const cp = input.costPer || (stockType === 'unitized' ? 'unit' : 'kg');
    if (cp === 'kg') {
      totalValue = totalWeightKg * costPrice;
    } else {
      totalValue = (units || 0) * costPrice;
    }
  }

  const productName = input.productName || input.product || 'Sans nom';
  const depotId = input.depotId || input.depot_id || 'unassigned';

  return {
    sku: input.sku || '',
    productName: productName,
    product: productName, // Backward compat
    category: input.category || '',
    stockType: stockType,
    units: units,
    cartons: units || 0, // Backward compat
    quantity: units || totalWeightKg, // Used in multi-depot queries
    unitWeight: unitWeight,
    totalWeightKg: totalWeightKg,
    costPrice: costPrice,
    unitPrice: costPrice, // Backward compat
    cost_basis: totalValue || 0,
    totalValue: totalValue,
    depotId: depotId,
    depot_id: depotId,
    lotNumber: input.lotNumber || input.lot || '',
    expirationDate: input.expirationDate || input.expiration || '',
    container: input.container || '',
    supplier: input.supplier || '',
    location: input.location || '',
    threshold: Number(input.threshold) || 10,
    productionDate: input.productionDate || '',
    costPer: input.costPer || (stockType === 'unitized' ? 'unit' : 'kg'),
    costCurrency: input.costCurrency || 'XOF',
    derivedFromContainer: !!input.container,
    status: input.status || 'active',
  };
}
