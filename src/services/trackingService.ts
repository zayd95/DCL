
import { 
  doc, 
  setDoc, 
  updateDoc, 
  collection, 
  query, 
  where, 
  getDocs,
  onSnapshot, 
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';

export interface TrackingData {
  id?: string;
  numeroConteneur: string;
  billOfLading?: string;
  bookingNumber?: string;
  carrier?: string;
  vessel?: {
    name?: string;
    imo?: string;
    voyage?: string;
  };
  portChargement?: string;
  portDechargement?: string;
  paysOrigine?: string;
  dateETD?: Timestamp | any;
  dateETA?: Timestamp | any;
  statut: 'pending' | 'in_transit' | 'arrived' | 'at_port' | 'customs_clearance' | 'discharged' | 'alert';
  localisationActuelle?: string;
  historiqueMilestones: Milestone[];
  dataQuality: {
    sourcesCount: number;
    confidence: 'haute' | 'moyenne' | 'basse';
  };
  requiresAttention: boolean;
  isActive: boolean;
  lastSync: Timestamp | any;
  creePar: string;
}

export interface Milestone {
  timestamp: string;
  location: string;
  description: string;
  status: string;
}

class TrackingService {
  // --- RECHERCHE & DETECTION ---

  detectReferenceType(ref: string): 'CONTAINER' | 'BL' | 'BOOKING' | 'UNKNOWN' {
    const containerRegex = /^[A-Z]{4}[0-9]{7}$/;
    const blRegex = /^[A-Z0-9]{9,}$/;
    const bookingRegex = /^[A-Z0-9]{6,8}$/;

    if (containerRegex.test(ref.toUpperCase())) return 'CONTAINER';
    if (blRegex.test(ref.toUpperCase())) return 'BL';
    if (bookingRegex.test(ref.toUpperCase())) return 'BOOKING';
    return 'UNKNOWN';
  }

  // --- CORE LOGIC (INTERNAL ONLY) ---

  async logTrackingAction(containerNumber: string, carrier: string) {
    if (!auth.currentUser) return;
    try {
      const logRef = doc(collection(db, 'tracking_logs'));
      await setDoc(logRef, {
        numeroConteneur: containerNumber,
        carrier: carrier,
        user: auth.currentUser.email,
        timestamp: serverTimestamp(),
        action: "tracking_opened"
      });
    } catch (err) {
      console.warn("Audit logging failed:", err);
    }
  }

  async trackNewReference(ref: string): Promise<TrackingData | null> {
    // Note: External APIs disabled as per user request.
    // This now only initializes a local tracking entry if it doesn't exist.
    const containerNo = ref.toUpperCase();
    const newData: TrackingData = {
      numeroConteneur: containerNo,
      statut: 'pending',
      historiqueMilestones: [],
      dataQuality: {
        sourcesCount: 0,
        confidence: 'basse'
      },
      requiresAttention: false,
      isActive: true,
      lastSync: serverTimestamp(),
      creePar: auth.currentUser?.uid || 'system'
    };

    await this.saveTrackingToFirestore(newData);
    return newData;
  }

  async saveTrackingToFirestore(data: TrackingData) {
    const docId = data.numeroConteneur || `track_${Date.now()}`;
    await setDoc(doc(db, 'tracking', docId), {
      ...data,
      lastSync: serverTimestamp()
    }, { merge: true });

    // Sync back to conteneurs if needed
    const conteneursRef = collection(db, 'conteneurs');
    const q = query(conteneursRef, where('numeroConteneur', '==', data.numeroConteneur));
    const querySnapshot = await getDocs(q);
    
    const updates = querySnapshot.docs.map(d => 
      updateDoc(d.ref, { trackingSync: true, status: data.statut })
    );
    await Promise.all(updates);
  }

  startRealtimeTracking(containerId: string, containerNumber: string, callback: (data: TrackingData) => void) {
    // Local listener only, no background API polling
    const unsubscribe = onSnapshot(doc(db, 'tracking', containerNumber), (docSnap) => {
      if (docSnap.exists()) {
        callback({ id: docSnap.id, ...docSnap.data() } as TrackingData);
      }
    });

    return unsubscribe;
  }
}

export const trackingService = new TrackingService();
