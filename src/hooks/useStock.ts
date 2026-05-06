import { useState, useEffect, useCallback } from 'react';
import {
  collectionGroup,
  collection,
  query,
  where,
  onSnapshot,
  writeBatch,
  doc,
  increment,
  serverTimestamp,
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { StockItem } from '../types';
import { onAuthStateChanged } from 'firebase/auth';
import { normalizeStockItem, createMovement } from '../lib/stockService';

export const useStock = (depotId: string | 'global') => {
  const [stock, setStock] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ totalCartons: 0, totalValue: 0 });

  useEffect(() => {
    let unsubscribeSnap: (() => void) | null = null;
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (unsubscribeSnap) {
        unsubscribeSnap();
        unsubscribeSnap = null;
      }

      if (!user) {
        setStock([]);
        setLoading(false);
        return;
      }

      // collectionGroup covers both /stock (legacy) and /depots/*/stock (current)
      const base = collectionGroup(db, 'stock');
      const q = depotId === 'global'
        ? query(base)
        : query(base, where('depot_id', '==', depotId));

      unsubscribeSnap = onSnapshot(q, (snapshot) => {
        const lots: StockItem[] = [];
        let totalQty = 0;
        let totalValue = 0;

        snapshot.forEach((d) => {
          const item = normalizeStockItem(d.data(), d.id);
          lots.push(item);
          totalQty   += item.quantity;
          totalValue += item.costBasis;
        });

        setStock(lots);
        setStats({ totalCartons: totalQty, totalValue });
        setLoading(false);
      }, (error) => {
        console.error('Firestore useStock error:', error);
        setLoading(false);
      });
    });

    return () => {
      unsubAuth();
      if (unsubscribeSnap) unsubscribeSnap();
    };
  }, [depotId]);

  const importInvoice = useCallback(async (
    invoiceData: {
      invoice_no: string;
      supplier: string;
      product: string;
      total_value_usd: number;
      containers: Array<{ id: string; cartons: number; kg?: number }>;
    },
    targetDepotId: string,
  ) => {
    const batch = writeBatch(db);
    const createdLots: string[] = [];

    const USD_TO_FCFA = 605;
    const totalCartons = invoiceData.containers.reduce((sum, c) => sum + c.cartons, 0);
    const valuePerCarton = totalCartons > 0
      ? (invoiceData.total_value_usd / totalCartons) * USD_TO_FCFA
      : 0;

    for (const container of invoiceData.containers) {
      const lotRef = doc(collection(db, 'depots', targetDepotId, 'stock'));
      const weightKg    = container.kg ?? container.cartons * 20;
      const costBasis   = Math.round(valuePerCarton * container.cartons);
      const costPrice   = Math.round(valuePerCarton);

      // Write canonical fields only
      batch.set(lotRef, {
        id:           lotRef.id,
        sku:          '',
        productName:  invoiceData.product,
        category:     '',
        supplier:     invoiceData.supplier,
        container:    container.id,
        depotId:      targetDepotId,
        stockType:    'unitized',
        quantity:     container.cartons,
        unitWeight:   weightKg / (container.cartons || 1),
        totalWeightKg: weightKg,
        costPrice,
        costPer:      'unit',
        costCurrency: 'XOF',
        costBasis,
        arrivalDate:  new Date().toISOString(),
        agingDays:    0,
        fefoScore:    0,
        status:       'quay_pad',
        threshold:    10,
        sourceDoc: {
          invoiceNo: invoiceData.invoice_no,
          supplier:  invoiceData.supplier,
        },
        createdAt:    serverTimestamp(),
        updatedAt:    serverTimestamp(),
        createdBy:    auth.currentUser?.uid || 'system',
      });

      // Single movement path: depots/{id}/stock/{id}/movements/{id}
      createMovement(batch, lotRef, {
        type:        'entry',
        quantity:    container.cartons,
        previousQty: 0,
        newQty:      container.cartons,
        reason:      `Import facture ${invoiceData.invoice_no}`,
        notes:       `Fournisseur: ${invoiceData.supplier}`,
        userId:      auth.currentUser?.uid || 'system',
        userName:    auth.currentUser?.displayName || 'Système',
      });

      createdLots.push(lotRef.id);
    }

    batch.update(doc(db, 'depots', targetDepotId), {
      current_load: increment(totalCartons),
    });

    batch.set(doc(db, 'stats', 'global'), {
      totalCartons: increment(totalCartons),
      valeurStock:  increment(Math.round(invoiceData.total_value_usd * USD_TO_FCFA)),
      lastUpdated:  serverTimestamp(),
    }, { merge: true });

    await batch.commit();
    return createdLots;
  }, []);

  return { stock, loading, stats, importInvoice };
};
