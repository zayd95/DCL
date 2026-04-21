import { useState, useEffect, useCallback } from 'react';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  writeBatch,
  doc,
  increment,
  Timestamp,
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

      let q;
      if (depotId === 'global') {
        q = query(collection(db, 'stock'));
      } else {
        q = query(collection(db, 'stock'), where('depot_id', '==', depotId));
      }

      unsubscribeSnap = onSnapshot(q, (snapshot) => {
        const lots: StockItem[] = [];
        let cartons = 0;
        let value = 0;

        snapshot.forEach((doc) => {
          const data = doc.data() as StockItem;
          lots.push({ ...data, id: doc.id });
          cartons += data.cartons || 0;
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

  // IMPORT INVOICE - Création batch des conteneurs
  const importInvoice = useCallback(async (
    invoiceData: {
      invoice_no: string;
      supplier: string;
      product: string;
      total_value_usd: number;
      containers: Array<{id: string; cartons: number; kg?: number}>;
    },
    targetDepotId: string
  ) => {
    const batch = writeBatch(db);
    const createdLots: string[] = [];
    
    // Taux de conversion (XOF)
    const USD_TO_FCFA = 605;
    const totalCartons = invoiceData.containers.reduce((sum, c) => sum + c.cartons, 0);
    const valuePerCarton = (invoiceData.total_value_usd / totalCartons) * USD_TO_FCFA;

    for (const container of invoiceData.containers) {
      const lotRef = doc(collection(db, 'stock'));
      
      const lotData: Omit<StockItem, 'id'> = {
        container: container.id,
        product: invoiceData.product,
        cartons: container.cartons,
        kg: container.kg || container.cartons * 20,
        cost_basis: Math.round(valuePerCarton * container.cartons),
        depot_id: targetDepotId,
        status: 'quay_pad',
        arrival_date: new Date().toISOString(),
        fefo_score: 0,
        aging_days: 0,
        source_doc: {
          invoice_no: invoiceData.invoice_no,
          supplier: invoiceData.supplier
        },
        createdAt: serverTimestamp()
      };

      batch.set(lotRef, { ...lotData, id: lotRef.id });
      createdLots.push(lotRef.id);

      // Logger le mouvement
      const movRef = doc(collection(db, 'movements'));
      batch.set(movRef, {
        id: movRef.id,
        type: 'RECEPTION',
        lot_id: lotRef.id,
        depot_id: targetDepotId,
        qty_change: container.cartons,
        timestamp: new Date().toISOString(),
        user_id: auth.currentUser?.uid || 'system',
        createdAt: serverTimestamp()
      } as Mouvement);
    }

    // Mettre à jour la capacité du dépôt
    const depotRef = doc(db, 'depots', targetDepotId);
    batch.update(depotRef, {
      current_load: increment(totalCartons)
    });

    await batch.commit();
    return createdLots;
  }, []);

  return { stock, loading, stats, importInvoice };
};
