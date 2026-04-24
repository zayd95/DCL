
import React, { useState, useEffect } from 'react';
import { auth, signInWithGoogle } from './lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { motion, AnimatePresence } from 'framer-motion';
import { Package, Settings } from 'lucide-react';
import { cn } from './lib/utils';
import { StockHome } from './screens/StockHome';
import { DepotManager } from './screens/DepotManager';
import { AddStock } from './screens/AddStock';
import { StockDetail } from './screens/StockDetail';
import { ReceptionScreen } from './screens/Reception';
import { Notifications } from './screens/Notifications';
import { Settings as SettingsScreen } from './screens/Settings';
import { DocumentLibrary } from './screens/DocumentLibrary';
import { StockMovementForm } from './screens/StockMovementForm';
import { Dashboard } from './screens/Dashboard';
import { ToastProvider } from './context/ToastContext';
import { SyncStatusProvider } from './context/SyncStatusContext';

import { BottomNav } from './components/BottomNav';

import { ErrorBoundary } from './components/ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <SyncStatusProvider>
          <AppContent />
        </SyncStatusProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}

function AppContent() {
  const [currentScreen, setCurrentScreen] = useState('inventaire');
  const [selectedStockId, setSelectedStockId] = useState<string | null>(null);
  const [selectedDepotId, setSelectedDepotId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);

  // Swipe logic state
  const [touchStart, setTouchStart] = useState<{x: number, y: number} | null>(null);
  const [touchEnd, setTouchEnd] = useState<{x: number, y: number} | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, u => setUser(u));
    return () => unsubscribe();
  }, []);

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-ocean-dark to-ocean-primary flex items-center justify-center p-6 text-white text-center">
        <div className="w-full max-w-sm">
          <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="w-24 h-24 bg-white/10 backdrop-blur-2xl rounded-[2.5rem] flex items-center justify-center mx-auto mb-10 shadow-2xl border border-white/20 text-white">
            <Package size={48} />
          </motion.div>
          <h1 className="text-4xl font-black tracking-tighter mb-2 uppercase">DEPOTEK</h1>
          <p className="text-xs font-bold text-white/50 uppercase tracking-[0.2em] mb-12">OS LOGISTIQUE V2.0 ENTERPRISE</p>
          <button onClick={signInWithGoogle} className="w-full bg-white text-ocean-primary py-6 rounded-3xl font-black uppercase tracking-widest shadow-2xl active:scale-95 transition-all text-sm">Entrer sur DEPOTEK</button>
        </div>
      </div>
    );
  }

  const handleNavigateToDetail = (id: string, depotId?: string) => {
    setSelectedStockId(id);
    setSelectedDepotId(depotId || null);
    setCurrentScreen('StockDetail');
  };

  const mainTabs = ['inventaire', 'centre', 'entrees', 'depots'];
  const showBottomNav = mainTabs.includes(currentScreen);

  // Swipe logic handlers
  const minSwipeDistance = 50;
  
  const onTouchStart = (e: React.TouchEvent) => {
    setTouchEnd(null);
    setTouchStart({ x: e.targetTouches[0].clientX, y: e.targetTouches[0].clientY });
  };

  const onTouchMove = (e: React.TouchEvent) => {
    setTouchEnd({ x: e.targetTouches[0].clientX, y: e.targetTouches[0].clientY });
  };

  const onTouchEnd = () => {
    if (!touchStart || !touchEnd) return;
    const distanceX = touchStart.x - touchEnd.x;
    const distanceY = touchStart.y - touchEnd.y;
    
    // Check if the gesture is mostly horizontal
    if (Math.abs(distanceX) > Math.abs(distanceY) && Math.abs(distanceX) > minSwipeDistance) {
      const isLeftSwipe = distanceX > minSwipeDistance;
      const isRightSwipe = distanceX < -minSwipeDistance;
      
      if (showBottomNav) {
        const currentIndex = mainTabs.indexOf(currentScreen);
        if (isLeftSwipe && currentIndex < mainTabs.length - 1) {
          setCurrentScreen(mainTabs[currentIndex + 1]);
        }
        if (isRightSwipe && currentIndex > 0) {
          setCurrentScreen(mainTabs[currentIndex - 1]);
        }
      }
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-[#F8FAFC] overflow-hidden flex flex-col"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Tab Screens (Persistent) */}
      <div className={cn("flex-1 h-full overflow-hidden", currentScreen === 'inventaire' ? 'block' : 'hidden')}>
        <StockHome onNavigate={setCurrentScreen} onSelectStock={handleNavigateToDetail} />
      </div>
      
      <div className={cn("flex-1 h-full overflow-hidden", currentScreen === 'centre' ? 'block' : 'hidden')}>
        <Dashboard onNavigate={setCurrentScreen} />
      </div>

      <div className={cn("flex-1 h-full overflow-hidden", currentScreen === 'entrees' ? 'block' : 'hidden')}>
        <ReceptionScreen onBack={() => setCurrentScreen('inventaire')} onNavigate={setCurrentScreen} />
      </div>

      <div className={cn("flex-1 h-full overflow-hidden", currentScreen === 'depots' ? 'block' : 'hidden')}>
        <DepotManager onBack={() => setCurrentScreen('inventaire')} onNavigate={setCurrentScreen} />
      </div>

      {/* Global Bottom Nav (Shared) */}
      {showBottomNav && (
        <BottomNav currentScreen={currentScreen} onNavigate={setCurrentScreen} />
      )}

      {/* Overlays / Modal Screens (Conditional) */}
      <AnimatePresence mode="wait">
        {currentScreen === 'AddStock' && (
          <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }} className="fixed inset-0 z-[500] bg-white">
            <AddStock onBack={() => setCurrentScreen('inventaire')} />
          </motion.div>
        )}

        {currentScreen === 'Notifications' && (
          <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }} className="fixed inset-0 z-[500] bg-white">
            <Notifications onBack={() => setCurrentScreen('inventaire')} onNavigate={setCurrentScreen} />
          </motion.div>
        )}

        {currentScreen === 'Settings' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[500] bg-white">
            <SettingsScreen onBack={() => setCurrentScreen('inventaire')} />
          </motion.div>
        )}

        {currentScreen === 'Docs' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[500] bg-white">
            <DocumentLibrary onBack={() => setCurrentScreen('inventaire')} />
          </motion.div>
        )}

        {currentScreen === 'StockDetail' && selectedStockId && (
          <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }} className="fixed inset-0 z-[500] bg-white border-l border-gray-100">
            <StockDetail stockId={selectedStockId} depotId={selectedDepotId} onBack={() => setCurrentScreen('inventaire')} />
          </motion.div>
        )}

        {currentScreen === 'MovementForm' && (
          <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }} className="fixed inset-0 z-[510] bg-white">
            <StockMovementForm onBack={() => setCurrentScreen('entrees')} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
