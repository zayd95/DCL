import { useState, useEffect } from 'react';
import { collection, query, onSnapshot } from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { StockViewDoc } from '../types';

export interface StockViewStats {
  totalValueXof: number;
  totalQuantity: number;
  totalWeightKg: number;
  lotsCount: number;
  urgentCount: number;
  fefoHealth: number;
  loading: boolean;
  isEmpty: boolean;
}

/**
 * Reads aggregate stock totals from /stockView (Phase 1+ schema).
 * Gate with featureFlags.USE_STOCKVIEW_READS before using in production UI.
 *
 * fefoUrgency is computed by a Cloud Function (eventual consistency).
 * If the field is absent the view is treated as ACTIVE (healthy).
 */
export function useStockViewStats(depotId: string | 'all'): StockViewStats {
  const [views, setViews] = useState<StockViewDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'stockView'));
    const unsub = onSnapshot(
      q,
      snap => {
        let docs = snap.docs.map(d => d.data() as StockViewDoc);
        if (depotId !== 'all') docs = docs.filter(d => d.depotId === depotId);
        setViews(docs);
        setLoading(false);
      },
      err => {
        console.error('useStockViewStats error:', err);
        setLoading(false);
      },
    );
    return () => unsub();
  }, [depotId]);

  const totalValueXof = views.reduce((s, v) => s + (v.totalValueXof ?? 0), 0);
  const totalQuantity = views.reduce((s, v) => s + (v.totalQuantity ?? 0), 0);
  const totalWeightKg = views.reduce((s, v) => s + (v.totalWeightKg ?? 0), 0);
  const lotsCount     = views.reduce((s, v) => s + (v.lotsCount    ?? 0), 0);

  const urgentCount = views.filter(
    v => v.fefoUrgency === 'CRITICAL' || v.fefoUrgency === 'EXPIRED',
  ).length;

  const fefoHealth = views.length > 0
    ? Math.max(0, 100 - (urgentCount / views.length) * 100)
    : 100;

  return {
    totalValueXof,
    totalQuantity,
    totalWeightKg,
    lotsCount,
    urgentCount,
    fefoHealth,
    loading,
    isEmpty: views.length === 0,
  };
}
