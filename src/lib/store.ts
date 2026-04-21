
import { StockItem, Mouvement, Depot, StockStatus, AuditEntry } from '../types';

import { 
  collection, 
  updateDoc, 
  doc, 
  runTransaction,
  serverTimestamp,
  getDoc,
  setDoc
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { handleFirestoreError } from './utils';

export const db_stock = collection(db, 'stock');
export const db_movements = collection(db, 'movements');
export const db_depots = collection(db, 'depots');

export const calculateFefoScore = (item: Partial<StockItem>) => {
  if (!item.arrival_date) return 0;
  const arrivalDate = new Date(item.arrival_date);
  const now = new Date();
  const aging_days = Math.floor((now.getTime() - arrivalDate.getTime()) / (1000 * 60 * 60 * 24));
  
  let score = aging_days;
  if (item.status === 'quay_pad') score += 30;
  if (item.issue_flags?.includes('temp_breach')) score += 100;
  
  if (item.product?.toLowerCase().includes('buffalo') || item.product?.toLowerCase().includes('meat')) {
    score += 20;
  }
  
  return score;
};

export const addStockItem = async (item: Omit<StockItem, 'id' | 'fefo_score' | 'aging_days'>) => {
  const aging_days = Math.floor((new Date().getTime() - new Date(item.arrival_date).getTime()) / (1000 * 60 * 60 * 24));
  const fefo_score = calculateFefoScore(item);
  
  return await runTransaction(db, async (transaction) => {
    const depotSnap = await transaction.get(doc(db, 'depots', item.depot_id));
    if (!depotSnap.exists()) throw new Error("Dépôt introuvable");
    const depot = depotSnap.data() as Depot;

    if ((depot.current_load || 0) + item.cartons > depot.capacity_cartons) {
      throw new Error("Capacité du dépôt dépassée");
    }

    const stockRef = doc(collection(db, 'stock'));
    transaction.set(stockRef, {
      ...item,
      id: stockRef.id,
      fefo_score,
      aging_days,
      createdAt: serverTimestamp()
    });

    transaction.update(doc(db, 'depots', item.depot_id), {
      current_load: (depot.current_load || 0) + item.cartons,
      last_updated: serverTimestamp()
    });

    // Create RECEPTION Movement
    const mouvRef = doc(collection(db, 'movements'));
    transaction.set(mouvRef, {
      type: 'RECEPTION',
      lot_id: stockRef.id,
      depot_id: item.depot_id,
      qty_change: item.cartons,
      timestamp: new Date().toISOString(),
      user_id: auth.currentUser?.uid || 'system',
      createdAt: serverTimestamp()
    });

    return stockRef.id;
  }).catch(err => handleFirestoreError(err, 'create', 'stock', auth));
};

export const editStockItem = async (
  item: StockItem,
  changes: Partial<StockItem>,
  userId: string,
  reason: string
) => {
  return await runTransaction(db, async (transaction) => {
    const stockRef = doc(db, 'stock', item.id);
    const audit: AuditEntry[] = item.edit_log || [];

    Object.keys(changes).forEach(key => {
      audit.push({
        field: key,
        old: (item as any)[key],
        new: (changes as any)[key],
        user: userId,
        reason,
        timestamp: new Date().toISOString()
      });
    });

    transaction.update(stockRef, {
      ...changes,
      edit_log: audit
    });

    // Handle capacity change if depot or qty changed
    if (changes.depot_id || (changes.cartons !== undefined)) {
      const oldDepotRef = doc(db, 'depots', item.depot_id);
      const newDepotId = changes.depot_id || item.depot_id;
      const newQty = changes.cartons !== undefined ? changes.cartons : item.cartons;

      if (changes.depot_id && changes.depot_id !== item.depot_id) {
        const oldSnap = await transaction.get(oldDepotRef);
        transaction.update(oldDepotRef, { current_load: Math.max(0, (oldSnap.data()?.current_load || 0) - item.cartons) });
        const newDepotRef = doc(db, 'depots', newDepotId);
        const newSnap = await transaction.get(newDepotRef);
        transaction.update(newDepotRef, { current_load: (newSnap.data()?.current_load || 0) + newQty });
      } else if (changes.cartons !== undefined) {
        const diff = newQty - item.cartons;
        const oldSnap = await transaction.get(oldDepotRef);
        transaction.update(oldDepotRef, { current_load: (oldSnap.data()?.current_load || 0) + diff });
      }
    }
  }).catch(err => handleFirestoreError(err, 'update', `stock/${item.id}`, auth));
};

export const splitStockItem = async (
  item: StockItem,
  splitQty: number,
  targetDepotId: string,
  userId: string,
  userRole: any
) => {
  if (splitQty >= item.cartons) throw new Error("Quantité à diviser doit être inférieure au total");

  return await runTransaction(db, async (transaction) => {
    const originalRef = doc(db, 'stock', item.id);
    const newRef = doc(collection(db, 'stock'));

    // 1. Create split lot
    transaction.set(newRef, {
      ...item,
      id: newRef.id,
      cartons: splitQty,
      depot_id: targetDepotId,
      status: targetDepotId === item.depot_id ? 'stored' : 'in_transit',
      createdAt: serverTimestamp()
    });

    // 2. Shrink original
    transaction.update(originalRef, {
      cartons: item.cartons - splitQty
    });

    // 3. Movement
    const mouvRef = doc(collection(db, 'movements'));
    transaction.set(mouvRef, {
      type: 'SPLIT',
      lot_id: item.id,
      depot_id: item.depot_id,
      target_depot_id: targetDepotId,
      qty_change: splitQty,
      timestamp: new Date().toISOString(),
      user_id: userId,
      createdAt: serverTimestamp()
    });

    // 4. Update capacities
    if (targetDepotId !== item.depot_id) {
      const targetDepotRef = doc(db, 'depots', targetDepotId);
      const targetSnap = await transaction.get(targetDepotRef);
      transaction.update(targetDepotRef, { current_load: (targetSnap.data()?.current_load || 0) + splitQty });
    }
  }).catch(err => handleFirestoreError(err, 'write', 'stock-split', auth));
};

export const processSortieFirestore = async (
  stock: StockItem[], 
  product: string, 
  qteRequise: number, 
  client_name: string,
  userId: string,
  userRole: any,
  depotId?: string
) => {
  const eligibleStock = stock
    .filter(item => {
      const matchProduct = item.product.toLowerCase().includes(product.toLowerCase());
      const matchDepot = depotId ? item.depot_id === depotId : true;
      return matchProduct && matchDepot && item.cartons > 0 && item.status === 'stored';
    })
    .sort((a, b) => b.fefo_score - a.fefo_score);

  let remaining = qteRequise;

  await runTransaction(db, async (transaction) => {
    for (const item of eligibleStock) {
      if (remaining <= 0) break;

      const deduct = Math.min(item.cartons, remaining);
      const stockRef = doc(db, 'stock', item.id);
      const depotRef = doc(db, 'depots', item.depot_id);
      
      const newNbCartons = item.cartons - deduct;
      
      if (newNbCartons === 0) {
        transaction.update(stockRef, { cartons: 0, status: 'delivered' });
      } else {
        transaction.update(stockRef, { cartons: newNbCartons });
      }

      const dSnap = await transaction.get(depotRef);
      transaction.update(depotRef, { current_load: (dSnap.data()?.current_load || 0) - deduct });

      const mouvRef = doc(collection(db, 'movements'));
      transaction.set(mouvRef, {
        type: 'SORTIE',
        lot_id: item.id,
        depot_id: item.depot_id,
        qty_change: -deduct,
        timestamp: new Date().toISOString(),
        client_name,
        user_id: userId,
        createdAt: serverTimestamp()
      });

      remaining -= deduct;
    }

    if (remaining > 0) {
      throw new Error(`Stock insuffisant. Manquant: ${remaining} cartons.`);
    }
  }).catch(err => handleFirestoreError(err, 'write', 'sortie-transaction', auth));
};

export const createDepot = async (depot: Omit<Depot, 'id' | 'current_load'>) => {
  const newRef = doc(collection(db, 'depots'));
  return await setDoc(newRef, {
    ...depot,
    id: newRef.id,
    current_load: 0,
    created_at: serverTimestamp()
  }).then(() => newRef.id)
    .catch(err => handleFirestoreError(err, 'create', 'depots', auth));
};

export const calculateGlobalFefoAllocation = (
  stock: StockItem[],
  product: string,
  qteRequise: number,
  targetDepotId: string | null
) => {
  const allEligible = stock
    .filter(item => 
      item.product.toLowerCase().includes(product.toLowerCase()) && 
      item.status === 'stored' && 
      item.cartons > 0
    )
    .sort((a, b) => b.fefo_score - a.fefo_score);

  let remaining = qteRequise;
  const localPicks: { item: StockItem; qty: number }[] = [];
  const transferPicks: { item: StockItem; qty: number; from_depot_id: string }[] = [];

  for (const item of allEligible) {
    if (remaining <= 0) break;
    const take = Math.min(item.cartons, remaining);
    
    if (targetDepotId && item.depot_id === targetDepotId) {
      localPicks.push({ item, qty: take });
    } else {
      transferPicks.push({ item, qty: take, from_depot_id: item.depot_id });
    }
    
    remaining -= take;
  }

  return {
    localPicks,
    transferPicks,
    isComplete: remaining <= 0,
    missing: remaining,
    totalAllocated: qteRequise - remaining
  };
};
