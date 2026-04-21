import { useState, useEffect } from 'react';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { StockItem, Mouvement, Depot } from '../types';
import { onAuthStateChanged } from 'firebase/auth';

export function useDepots() {
  const [data, setData] = useState<Depot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubscribeSnap: (() => void) | null = null;
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (unsubscribeSnap) {
        unsubscribeSnap();
        unsubscribeSnap = null;
      }

      if (!user) {
        setData([]);
        setLoading(false);
        return;
      }

      const q = query(collection(db, 'depots'), orderBy('name', 'asc'));
      unsubscribeSnap = onSnapshot(q, (snapshot) => {
        const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Depot));
        setData(items);
        setLoading(false);
      }, (error) => {
        console.error("Firestore useDepots error:", error);
        setLoading(false);
      });
    });

    return () => {
      unsubAuth();
      if (unsubscribeSnap) unsubscribeSnap();
    };
  }, []);

  return { data, loading };
}

export function useMovements(max = 20) {
  const [data, setData] = useState<Mouvement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubscribeSnap: (() => void) | null = null;
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (unsubscribeSnap) {
        unsubscribeSnap();
        unsubscribeSnap = null;
      }

      if (!user) {
        setData([]);
        setLoading(false);
        return;
      }

      const q = query(collection(db, 'movements'), orderBy('timestamp', 'desc'), limit(max));
      unsubscribeSnap = onSnapshot(q, (snapshot) => {
        const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Mouvement));
        setData(items);
        setLoading(false);
      }, (error) => {
        console.error("Firestore useMovements error:", error);
        setLoading(false);
      });
    });

    return () => {
      unsubAuth();
      if (unsubscribeSnap) unsubscribeSnap();
    };
  }, [max]);

  return { data, loading };
}
