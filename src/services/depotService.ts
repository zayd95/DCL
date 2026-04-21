
import { 
  collection, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  serverTimestamp,
  getDoc
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { Depot } from '../types';

export const depotService = {
  create: async (data: Omit<Depot, 'id' | 'current_load' | 'created_at'>) => {
    return addDoc(collection(db, 'depots'), {
      ...data,
      current_load: 0,
      manager_uid: auth.currentUser?.uid || 'system',
      created_at: serverTimestamp()
    });
  },

  update: async (id: string, data: Partial<Depot>) => {
    const depotRef = doc(db, 'depots', id);
    return updateDoc(depotRef, data);
  },

  delete: async (id: string) => {
    const depotRef = doc(db, 'depots', id);
    return deleteDoc(depotRef);
  },

  duplicate: async (id: string) => {
    const depotRef = doc(db, 'depots', id);
    const snap = await getDoc(depotRef);
    if (!snap.exists()) throw new Error("Dépôt introuvable");
    
    const data = snap.data() as Depot;
    const { id: _, created_at, ...rest } = data;
    
    return addDoc(collection(db, 'depots'), {
      ...rest,
      name: `${data.name} (Copie)`,
      code: `${data.code}-COPY`,
      created_at: serverTimestamp()
    });
  }
};
