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
  serverTimestamp
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { StockItem, Mouvement } from '../types';
import { onAuthStateChanged } from 'firebase/auth';

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

      // collectionGroup covers both /stock and /depots/*/stock paths
      const base = collectionGroup(db, 'stock');
      const q = depotId === 'global'
        ? query(base)
        : query(base, where('depot_id', '==', depotId));

      unsubscribeSnap = onSnapshot(q, (snapshot) => {
        const lots: StockItem[] = [];
        let cartons = 0;
        let value = 0;

        snapshot.forEach((d) => {
          const data = d.data() as StockItem;
          lots.push({ ...data, id: d.id });
          // quantity is the canonical field; cartons is the backward-compat alias
          cartons += data.quantity ?? data.cartons ?? 0;
          value += data.cost_basis || 0;
        });

        setStock(lots);
        setStats({ totalCartons: cartons, totalValue: value });
        setLoading(false);
      }, (error) => {
        console.error("Firestore useStock error:", error);
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
    targetDepotId: string
  ) => {
    const batch = writeBatch(db);
    const createdLots: string[] = [];

    const USD_TO_FCFA = 605;
    const totalCartons = invoiceData.containers.reduce((sum, c) => sum + c.cartons, 0);
    const valuePerCarton = totalCartons > 0
      ? (invoiceData.total_value_usd / totalCartons) * USD_TO_FCFA
      : 0;

    for (const container of invoiceData.containers) {
      // Write to depot subcollection — same path as AddStock and StockMovementForm
      const lotRef = doc(collection(db, 'depots', targetDepotId, 'stock'));
      const costBasis = Math.round(valuePerCarton * container.cartons);
      const weightKg = container.kg ?? container.cartons * 20;

      const lotData = {
        id: lotRef.id,
        container: container.id,
        product: invoiceData.product,
        productName: invoiceData.product,
        stockType: 'unitized',
        // Canonical quantity field + backward-compat aliases
        quantity: container.cartons,
        units: container.cartons,
        cartons: container.cartons,
        unitWeight: weightKg / (container.cartons || 1),
        totalWeightKg: weightKg,
        kg: weightKg,
        cost_basis: costBasis,
        totalValue: costBasis,
        unitPrice: Math.round(valuePerCarton),
        costPrice: Math.round(valuePerCarton),
        costPer: 'unit',
        costCurrency: 'XOF',
        depotId: targetDepotId,
        depot_id: targetDepotId,
        status: 'quay_pad',
        arrival_date: new Date().toISOString(),
        fefo_score: 0,
        aging_days: 0,
        threshold: 10,
        min_threshold: 10,
        source_doc: {
          invoice_no: invoiceData.invoice_no,
          supplier: invoiceData.supplier,
        },
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: auth.currentUser?.uid || 'system',
      };

      batch.set(lotRef, lotData);
      createdLots.push(lotRef.id);

      // Per-stock movement — this is what StockDetail LogsView reads
      const movRef = doc(collection(lotRef, 'movements'));
      batch.set(movRef, {
        id: movRef.id,
        type: 'entry',
        quantity: container.cartons,
        previousQty: 0,
        newQty: container.cartons,
        reason: `Import facture ${invoiceData.invoice_no}`,
        notes: `Fournisseur: ${invoiceData.supplier}`,
        userId: auth.currentUser?.uid || 'system',
        userName: auth.currentUser?.displayName || 'Système',
        timestamp: serverTimestamp(),
        createdAt: serverTimestamp(),
      });

      // Global movements collection for cross-depot reporting
      const globalMovRef = doc(collection(db, 'movements'));
      batch.set(globalMovRef, {
        id: globalMovRef.id,
        type: 'RECEPTION',
        lot_id: lotRef.id,
        depot_id: targetDepotId,
        qty_change: container.cartons,
        timestamp: new Date().toISOString(),
        user_id: auth.currentUser?.uid || 'system',
        createdAt: serverTimestamp(),
      } as Mouvement);
    }

    batch.update(doc(db, 'depots', targetDepotId), {
      current_load: increment(totalCartons),
    });

    // Was missing before — importInvoice now updates global stats
    batch.set(doc(db, 'stats', 'global'), {
      totalCartons: increment(totalCartons),
      valeurStock: increment(Math.round(invoiceData.total_value_usd * USD_TO_FCFA)),
      lastUpdated: serverTimestamp(),
    }, { merge: true });

    await batch.commit();
    return createdLots;
  }, []);

  return { stock, loading, stats, importInvoice };
};
