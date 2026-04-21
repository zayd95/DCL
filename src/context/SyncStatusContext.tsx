
import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { onSnapshot, doc, collection, getDocFromCache, enableNetwork, disableNetwork } from 'firebase/firestore';
import { Wifi, WifiOff, RefreshCcw, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from './ToastContext';

export const SyncStatusProvider = ({ children }: { children: React.ReactNode }) => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingWrites, setPendingWrites] = useState(0);
  const { showToast } = useToast();

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      enableNetwork(db);
      showToast("Connexion rétablie. Reprise de la synchronisation PAD.", "success");
    };
    
    const handleOffline = () => {
      setIsOnline(false);
      // We don't necessarily need disableNetwork(db) as Firestore handles it,
      // but it helps define a clean offline state.
      showToast("Mode Hors-Ligne activé. Vos actions sont sauvegardées localement.", "warning");
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Monitoring pending writes via a technical "metadata" check if possible,
    // or simply by observing onSnapshot metadata.
    // In Firestore Web SDK, we can check if document data has 'hasPendingWrites'
    
    // We'll use a general "syncing" indicator when network state is changing
    const checkSyncStatus = async () => {
      // Small trick: trying to fetch a dummy doc from server vs cache
      // can help determine sync state, but Firestore's multi-tab persistence 
      // is quite opaque about the global queue size.
    };

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <>
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[2000] pointer-events-none">
        <AnimatePresence>
          {!isOnline && (
            <motion.div 
              initial={{ y: -50, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -50, opacity: 0 }}
              className="bg-[#1a237e] text-white px-4 py-2 rounded-full shadow-2xl flex items-center gap-3 border border-white/10 backdrop-blur-md"
            >
              <WifiOff size={14} className="text-orange-400" />
              <span className="text-[10px] font-black uppercase tracking-widest">Hors-Ligne (PAD Stock Local)</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Syncing Indicator */}
      <div className="fixed bottom-6 right-6 z-[2000] pointer-events-none">
        <AnimatePresence>
          {isOnline && isSyncing && (
            <motion.div 
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              className="bg-white p-3 rounded-full shadow-xl border border-gray-100 flex items-center justify-center"
            >
              <RefreshCcw size={20} className="text-ocean-primary animate-spin" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      
      {children}
    </>
  );
};
