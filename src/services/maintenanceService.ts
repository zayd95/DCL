
import { db } from '../lib/firebase';
import { 
  collection, 
  getDocs, 
  writeBatch, 
  doc, 
  deleteDoc,
  collectionGroup,
  query
} from 'firebase/firestore';

export const maintenanceService = {
  /**
   * Reset all application data for Demo purposes.
   * Deletes stocks, depots, movements, logs, and tracking.
   */
  async resetAllData() {
    const batch = writeBatch(db);
    
    // Collections to clear
    const collectionsToClear = ['logs', 'tracking', 'alerts', 'containers', 'document_library', 'stock', 'movements'];
    
    for (const colName of collectionsToClear) {
      const snap = await getDocs(collection(db, colName));
      snap.docs.forEach(d => batch.delete(d.ref));
    }

    // Clean nested stock and movements
    // 1. Get all depots
    const depotsSnap = await getDocs(collection(db, 'depots'));
    for (const depotDoc of depotsSnap.docs) {
      // 2. Clear stock subcollection
      const stockSnap = await getDocs(collection(db, 'depots', depotDoc.id, 'stock'));
      for (const stockDoc of stockSnap.docs) {
        // 3. Clear movements subcollection
        const moveSnap = await getDocs(collection(db, 'depots', depotDoc.id, 'stock', stockDoc.id, 'movements'));
        moveSnap.docs.forEach(m => batch.delete(m.ref));
        // Delete stock item
        batch.delete(stockDoc.ref);
      }
      // Delete depot itself
      batch.delete(depotDoc.ref);
    }

    // Reset global stats
    batch.set(doc(db, 'stats', 'global'), {
      valeurStock: 0,
      totalCartons: 0,
      lastUpdated: new Date()
    });

    await batch.commit();
  }
};
