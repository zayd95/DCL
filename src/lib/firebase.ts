import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { 
  initializeFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager,
  clearIndexedDbPersistence,
  Firestore
} from 'firebase/firestore';
import { getMessaging } from 'firebase/messaging';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// Modern Persistence Setup with Recovery Logic
let dbInstance: Firestore;

try {
  dbInstance = initializeFirestore(app, {
    localCache: persistentLocalCache({ 
      tabManager: persistentMultipleTabManager() 
    })
  }, (firebaseConfig as any).firestoreDatabaseId);
} catch (err: any) {
  console.error("Firestore Initialization Failed. Attempting Recovery...", err);
  // Fallback if initialization totally fails - usually because of corrupted persistence
  dbInstance = initializeFirestore(app, {}, (firebaseConfig as any).firestoreDatabaseId);
  
  // Try to clear persistence in background if we suspect corruption
  if (err.message?.includes('assertion') || err.code === 'failed-precondition') {
    clearIndexedDbPersistence(dbInstance).catch(e => console.error("Recovery: Clear persistence failed:", e));
  }
}

export const db = dbInstance;
export const auth = getAuth(app);
export const messaging = typeof window !== 'undefined' ? getMessaging(app) : null;
export const googleProvider = new GoogleAuthProvider();

export const signInWithGoogle = () => signInWithPopup(auth, googleProvider);
