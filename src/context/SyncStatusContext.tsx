
import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { enableNetwork, disableNetwork } from 'firebase/firestore';
import { WifiOff, RefreshCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useToast } from './ToastContext';

export const SyncStatusProvider = ({ children }: { children: React.ReactNode }) => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      enableNetwork(db);
      showToast("Connexion rétablie. Reprise de la synchronisation PAD.", "success");
    };
    const handleOffline = () => {
      setIsOnline(false);
      showToast("Mode Hors-Ligne activé. Vos actions sont sauvegardées localement.", "warning");
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
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
              className="bg-brand text-white px-4 py-2 rounded-full shadow-2xl flex items-center gap-3 border border-white/10 backdrop-blur-md"
            >
              <WifiOff size={14} className="text-status-warning" />
              <span className="text-label font-black uppercase tracking-widest">Hors-Ligne (PAD Stock Local)</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="fixed bottom-6 right-6 z-[2000] pointer-events-none">
        <AnimatePresence>
          {isOnline && isSyncing && (
            <motion.div
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              className="bg-surface-card p-3 rounded-full shadow-xl border border-border-default flex items-center justify-center"
            >
              <RefreshCcw size={20} className="text-brand animate-spin" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {children}
    </>
  );
};
