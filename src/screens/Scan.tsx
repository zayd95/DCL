
import React, { useState, useRef, useEffect } from 'react';
import { Scan, Mic, Zap, Flashlight, ChevronLeft, X, Plus, Minus, Box, ArrowRight, Package, MapPin, Clock, CheckCircle2, Settings, FileText, Building2, ArrowUpRight, ArrowDownRight, Truck, Bell } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { db, auth } from '../lib/firebase';
import { collection, query, where, getDocs, doc, runTransaction, increment, serverTimestamp, collectionGroup } from 'firebase/firestore';
import { useToast } from '../context/ToastContext';
import { StockItem } from '../types';
import { useDepots, useUnreadAlerts } from './StockHome';

type ScanMode = 'camera' | 'voice' | 'quick';

export const ScanScreen = ({ onBack, onNavigate }: { onBack: () => void, onNavigate: (screen: string) => void }) => {
  const { data: depots } = useDepots();
  const unreadAlerts = useUnreadAlerts();
  const [mode, setMode] = useState<ScanMode>('camera');
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [scannedProduct, setScannedProduct] = useState<StockItem | null>(null);
  const [scannedTransfer, setScannedTransfer] = useState<StockItem | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [voiceText, setVoiceText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { showToast } = useToast();

  // Mode Camera: Camera feed logic
  useEffect(() => {
    if (mode === 'camera' && !scannedProduct) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(stream => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        })
        .catch(err => {
          console.error("Erreur accès caméra:", err);
          showToast("Accès caméra refusé ou non disponible", "error");
        });
    }

    return () => {
      if (videoRef.current && videoRef.current.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [mode, scannedProduct]);

  const handleSimulateScan = async (codeInput: string = 'DKR-BUF-001') => {
    setIsScanning(true);
    try {
      // Check if it's a transfer reference (BT-...)
      if (codeInput.startsWith('BT-')) {
        const qTransfer = query(collectionGroup(db, "stock"), where("transferRef", "==", codeInput));
        const transferSnap = await getDocs(qTransfer);
        if (!transferSnap.empty) {
           const transferItem = { id: transferSnap.docs[0].id, ...transferSnap.docs[0].data() } as StockItem;
           setScannedTransfer(transferItem);
           return;
        } else {
           showToast("Bon de Transfert introuvable", "error");
           return;
        }
      }

      const q = query(collectionGroup(db, "stock"), where("sku", "==", codeInput));
      const snapshot = await getDocs(q);
      
      if (!snapshot.empty) {
        const product = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as StockItem;
        setScannedProduct(product);
      } else {
        showToast("Produit introuvable sur DEPOTEK", "error");
      }
    } catch (err) {
      showToast("Erreur recherche stock", "error");
    } finally {
      setIsScanning(false);
    }
  };

  const handleVoiceCommand = () => {
    setIsListening(true);
    // Simulate voice recognition
    setTimeout(() => {
      setVoiceText("Ajouter 50 cartons de Buffalo dans SODIDA");
      setIsListening(false);
    }, 2000);
  };

  const handleConfirmMovement = async (type: 'entry' | 'exit', qty: number = 1) => {
    if (!scannedProduct) return;
    
    try {
      await runTransaction(db, async (transaction) => {
        const dId = scannedProduct.depot_id || scannedProduct.depotId || '';
        const stockRef = doc(db, "depots", dId, "stock", scannedProduct.id);
        const depotRef = doc(db, "depots", dId);
        
        const change = type === 'entry' ? qty : -qty;
        
        // Log movement
        const movementRef = doc(collection(db, "depots", dId, "stock", scannedProduct.id, "movements"));
        transaction.set(movementRef, {
          lot_id: scannedProduct.id,
          type: type === 'entry' ? 'entry' : 'exit',
          quantity: Math.abs(change),
          userId: auth.currentUser?.uid || 'anon',
          userName: auth.currentUser?.displayName || 'Agent DEPOTEK',
          reason: 'Scan Rapide (Détention SKU)',
          timestamp: serverTimestamp()
        });

        transaction.update(stockRef, {
          quantity: increment(change),
          cartons: increment(change),
          updatedAt: serverTimestamp()
        });

        transaction.update(depotRef, {
          current_load: increment(change)
        });
      });

      showToast(`Mouvement ${type === 'entry' ? 'Entrée' : 'Sortie'} validé`);
      setScannedProduct(null);
    } catch (err) {
      console.error(err);
      showToast("Erreur lors du mouvement", "error");
    }
  };

  const handleConfirmReception = async () => {
    if (!scannedTransfer) return;
    
    try {
      const dId = scannedTransfer.depot_id || scannedTransfer.depotId || '';
      const stockRef = doc(db, "depots", dId, "stock", scannedTransfer.id);
      
      await runTransaction(db, async (transaction) => {
        const depotRef = doc(db, "depots", dId);
        const depotSnap = await transaction.get(depotRef);
        const depotName = depotSnap.data()?.name || 'Dépot Inconnu';

        transaction.update(stockRef, {
          status: 'stored',
          updatedAt: serverTimestamp()
        });

        const movementRef = doc(collection(db, "depots", dId, "stock", scannedTransfer.id, "movements"));
        transaction.set(movementRef, {
          type: 'reception',
          quantity: scannedTransfer.quantity || scannedTransfer.cartons || 0,
          reason: `Réception transfert ${scannedTransfer.transferRef} validée`,
          userName: auth.currentUser?.displayName || 'Agent',
          userId: auth.currentUser?.uid,
          timestamp: serverTimestamp()
        });
      });

      const targetDepot = depots.find(d => d.id === (scannedTransfer.depot_id || scannedTransfer.depotId))?.name || 'Dépôt';
      showToast(`Stock mis à jour à ${targetDepot}`, "success");
      setScannedTransfer(null);
    } catch (err) {
      console.error(err);
      showToast("Erreur lors de la validation", "error");
    }
  };

  return (
    <div className="min-h-screen bg-black max-w-[480px] mx-auto relative overflow-hidden font-sans flex flex-col">
      
      {/* 1. LAYER CAMERA (Background) */}
      {mode === 'camera' && !scannedProduct && (
        <div className="absolute inset-0 z-0">
          <video 
            ref={videoRef} 
            autoPlay 
            playsInline 
            className="w-full h-full object-cover opacity-60"
          />
          {/* Scan Frame Overlay */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-64 h-64 border-2 border-white/30 rounded-[40px] relative">
              <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-brand rounded-tl-xl" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-brand rounded-tr-xl" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-brand rounded-bl-xl" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-brand rounded-br-xl" />
              
              {/* Scan Line Animation */}
              <motion.div 
                animate={{ top: ['10%', '90%', '10%'] }}
                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                className="absolute left-4 right-4 h-0.5 bg-gradient-to-r from-transparent via-ocean-primary to-transparent shadow-[0_0_15px_rgba(0,102,255,0.8)] z-10"
              />
            </div>
            <p className="absolute bottom-1/4 text-white/60 text-label font-black tracking-[0.3em]">SCANNER CODE SKU / DEPOTEK</p>
          </div>
        </div>
      )}

      {/* 2. HEADER OVERLAY */}
      <header className="p-6 flex items-center justify-between relative z-50">
        <button onClick={onBack} className="w-10 h-10 bg-white/10 backdrop-blur-md rounded-2xl flex items-center justify-center text-white border border-white/10">
          <ChevronLeft size={24} />
        </button>
        <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-2xl border border-white/10">
          <h1 className="text-white text-xs font-black uppercase tracking-widest">
            {mode === 'camera' ? 'Hub DEPOTEK' : mode === 'voice' ? 'Commande Vocale' : 'Saisie Rapide'}
          </h1>
        </div>
        {mode === 'camera' ? (
          <button 
            onClick={() => setIsTorchOn(!isTorchOn)}
            className={cn("w-10 h-10 rounded-2xl flex items-center justify-center transition-colors border border-white/10", isTorchOn ? "bg-brand text-white" : "bg-white/10 text-white")}
          >
            <Flashlight size={20} />
          </button>
        ) : <div className="w-10" />}
      </header>

      {/* 3. MODE CONTENT */}
      <div className="flex-1 relative z-10 flex flex-col justify-center items-center px-6">
        
        {/* VOICE MODE UI */}
        {mode === 'voice' && (
          <div className="w-full text-center space-y-12">
            <div className="space-y-4">
              <h2 className="text-white text-lg font-black uppercase tracking-tight">"Ajouter 50 filets Buffalo..."</h2>
              <p className="text-white/40 text-label font-bold uppercase tracking-widest leading-relaxed">
                Dites une commande naturelle en français.<br/>L'IA logistique s'occupe du reste.
              </p>
            </div>

            {/* Wave Animation */}
            {isListening ? (
              <div className="flex items-center justify-center gap-1 h-20">
                {[1, 2, 3, 4, 5, 4, 3, 2, 1].map((h, i) => (
                  <motion.div 
                    key={i}
                    animate={{ height: [20, h * 10, 20] }}
                    transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.05 }}
                    className="w-1.5 bg-brand rounded-full"
                  />
                ))}
              </div>
            ) : (
                <div className="h-20" />
            )}

            <motion.button 
              whileTap={{ scale: 0.9 }}
              onMouseDown={handleVoiceCommand}
              onTouchStart={handleVoiceCommand}
              onMouseUp={() => setIsListening(false)}
              onTouchEnd={() => setIsListening(false)}
              className={cn(
                "w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-all border-4",
                isListening ? "bg-red-500 scale-110 border-red-200" : "bg-white border-ocean-soft text-brand"
              )}
            >
              <Mic size={40} strokeWidth={isListening ? 3 : 2} />
            </motion.button>

            <AnimatePresence>
              {voiceText && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white/10 backdrop-blur-xl border border-white/10 p-4 rounded-2xl text-white text-sm font-black italic"
                >
                  "{voiceText}"
                  <button className="ml-2 text-brand uppercase text-label font-black underline">Modifier</button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* QUICK ENTRY MODE UI */}
        {mode === 'quick' && (
          <div className="w-full space-y-6">
            <div className="grid grid-cols-2 gap-4">
            <QuickCard icon="🥩" title="Buffalo G.A" qty={450} depot="CENTRE" />
            <QuickCard icon="🐟" title="Poisson Sea" qty={120} depot="DEPOT 2" />
            <QuickCard icon="🍗" title="Poulet Grill" qty={800} depot="CENTRE" />
            <QuickCard icon="🧊" title="HUB DEPOTEK" qty={25} depot="HUB" />
            </div>
            
            <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
               <h3 className="text-white/40 text-label font-black uppercase tracking-widest mb-4">Favoris Récents</h3>
               <div className="space-y-3">
                 <RecentItem label="Transfert Buffalo SODIDA -> FOIRE" time="Il y a 2 min" />
                 <RecentItem label="Réception Maersk-440" time="Il y a 14 min" />
               </div>
            </div>
          </div>
        )}

        {/* CAMERA BUTTON (To trigger mock scan) */}
        {mode === 'camera' && !scannedProduct && (
          <div className="absolute bottom-12 w-full px-6 space-y-4">
             <button 
                onClick={() => handleSimulateScan('BT-DEMO')}
                className="w-full py-5 bg-white rounded-2xl text-brand-dark font-black uppercase text-xs tracking-widest shadow-2xl active:scale-95 transition-all"
             >
                Simuler Détection BT (Test)
             </button>
             <button className="w-full py-4 text-white/40 font-black uppercase text-label tracking-widest">Saisie manuelle</button>
          </div>
        )}
      </div>

      {/* 4. SCAN RESULT DRAWER / ACTION SHEET */}
      <AnimatePresence>
        {scannedProduct && (
          <div className="fixed inset-0 z-[200] flex items-end">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setScannedProduct(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              className="w-full bg-white rounded-t-[40px] p-8 z-[210] shadow-2xl space-y-6 pb-12"
            >
              <div className="w-12 h-1.5 bg-surface-page rounded-full mx-auto" />
              
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 bg-surface-subtle rounded-2xl flex items-center justify-center text-3xl">
                    {scannedProduct.product?.includes('BUF') ? '🥩' : '📦'}
                  </div>
                  <div>
                    <h2 className="text-lg font-black text-brand-dark uppercase tracking-tight">{scannedProduct.product}</h2>
                    <p className="text-label font-black text-text-muted uppercase tracking-widest">{scannedProduct.sku}</p>
                  </div>
                </div>
                <div className="bg-green-50 text-green-500 px-3 py-1.5 rounded-full text-label font-black uppercase tracking-widest">
                  {scannedProduct.status}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-surface-subtle p-4 rounded-2xl">
                  <span className="text-micro font-black text-text-muted uppercase block mb-1">Localisation</span>
                  <div className="flex items-center gap-2 text-brand-dark font-black text-xs uppercase">
                    <MapPin size={12} className="text-brand" />
                    {depots.find(d => d.id === (scannedProduct.depotId || scannedProduct.depot_id))?.name || 'Dépôt DEPOTEK'}
                  </div>
                </div>
                <div className="bg-surface-subtle p-4 rounded-2xl">
                  <span className="text-micro font-black text-text-muted uppercase block mb-1">Inventaire Actuel</span>
                  <div className="flex items-center gap-2 text-brand-dark font-black text-xs uppercase">
                    <Box size={12} className="text-brand" />
                    {scannedProduct.quantity || scannedProduct.cartons} CTN
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-2">
                 <button 
                  onClick={() => handleConfirmMovement('entry', 10)}
                  className="py-5 bg-green-500 text-white rounded-2xl font-black uppercase text-label tracking-widest shadow-xl shadow-green-500/20 active:scale-95 transition-all"
                 >
                   Dépotage (+10)
                 </button>
                 <button 
                  onClick={() => handleConfirmMovement('exit', 10)}
                  className="py-5 bg-orange-500 text-white rounded-2xl font-black uppercase text-label tracking-widest shadow-xl shadow-orange-500/20 active:scale-95 transition-all"
                 >
                   Bon de Sortie (-10)
                 </button>
              </div>

              <button 
                onClick={() => { setScannedProduct(null); onNavigate('StockDetail'); }} 
                className="w-full py-5 border-2 border-brand text-brand rounded-2xl font-black uppercase text-label tracking-widest flex items-center justify-center gap-2"
              >
                Fiche Complète <ArrowRight size={14} />
              </button>
            </motion.div>
          </div>
        )}

        {scannedTransfer && (
          <div className="fixed inset-0 z-[200] flex items-end">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setScannedTransfer(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              className="w-full bg-white rounded-t-[40px] p-8 z-[210] shadow-2xl space-y-6 pb-12"
            >
              <div className="w-12 h-1.5 bg-surface-page rounded-full mx-auto" />
              
              <div className="bg-blue-50 p-4 rounded-3xl border border-blue-100 flex items-center gap-4">
                 <div className="w-12 h-12 bg-brand text-white rounded-2xl flex items-center justify-center">
                    <Truck size={24} />
                 </div>
                 <div>
                    <h3 className="text-xs font-black text-brand-dark uppercase">Bon de Transfert Détecté</h3>
                    <p className="text-label text-brand font-bold">{scannedTransfer.transferRef}</p>
                 </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-black text-brand-dark uppercase tracking-tight">
                    {scannedTransfer.productName || scannedTransfer.product}
                  </h2>
                  <span className="text-sm font-black text-brand">{scannedTransfer.quantity || scannedTransfer.cartons} CTN</span>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                   <div className="p-3 bg-surface-subtle rounded-xl">
                      <span className="text-micro font-black text-text-muted uppercase block mb-1">Dépôt Destinataire</span>
                      <span className="text-label font-black text-brand-dark uppercase">
                        {depots.find(d => d.id === (scannedTransfer.depotId || scannedTransfer.depot_id))?.name || 'A confirmer'}
                      </span>
                   </div>
                   <div className="p-3 bg-surface-subtle rounded-xl">
                      <span className="text-micro font-black text-text-muted uppercase block mb-1">Statut Actuel</span>
                      <span className="text-label font-black text-blue-500 uppercase tracking-widest italic">En Transit</span>
                   </div>
                </div>
              </div>

              <button 
                onClick={handleConfirmReception}
                className="w-full py-6 bg-green-500 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-2xl shadow-green-500/30 flex items-center justify-center gap-3 active:scale-95 transition-all"
              >
                <CheckCircle2 size={20} />
                Confirmer la Réception
              </button>

              <button 
                onClick={() => setScannedTransfer(null)} 
                className="w-full py-4 text-text-muted font-black uppercase text-label tracking-widest"
              >
                Annuler
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 5. BOTTOM TAB BAR TOGGLE */}
      <div className="p-6 bg-black/40 backdrop-blur-xl border-t border-white/10 relative z-50">
        <div className="bg-white/5 p-1.5 rounded-[2rem] flex items-center">
           <TabButton 
              active={mode === 'camera'} 
              icon={<Scan size={18} />} 
              label="Scanner" 
              onClick={() => setMode('camera')} 
           />
           <TabButton 
              active={mode === 'voice'} 
              icon={<Mic size={18} />} 
              label="Vocale" 
              onClick={() => setMode('voice')} 
           />
           <TabButton 
              active={mode === 'quick'} 
              icon={<Zap size={18} />} 
              label="Rapide" 
              onClick={() => setMode('quick')} 
           />
        </div>
      </div>
      
    </div>
  );
};

const TabButton = ({ active, icon, label, onClick }: any) => (
  <button 
    onClick={onClick}
    className={cn(
      "flex-1 flex items-center justify-center gap-2 py-3 rounded-full transition-all",
      active ? "bg-white text-brand-dark shadow-xl" : "text-white/40"
    )}
  >
    {icon}
    <span className="text-micro font-black uppercase tracking-widest">{active ? label : ''}</span>
  </button>
);

const QuickCard = ({ icon, title, qty, depot }: any) => (
  <button className="bg-white/10 backdrop-blur-md border border-white/10 p-4 rounded-3xl flex flex-col items-center gap-2 active:scale-95 transition-all text-center">
    <span className="text-2xl">{icon}</span>
    <h4 className="text-white text-label font-black uppercase">{title}</h4>
    <div className="flex flex-col">
       <span className="text-brand text-xs font-black">{qty} CTN</span>
       <span className="text-white/20 text-micro font-bold uppercase">{depot}</span>
    </div>
  </button>
);

const RecentItem = ({ label, time }: any) => (
  <div className="flex items-center justify-between p-3 bg-white/5 rounded-xl">
    <div className="flex items-center gap-3">
       <Clock size={12} className="text-white/20" />
       <span className="text-white/60 text-label font-bold">{label}</span>
    </div>
    <span className="text-white/20 text-micro uppercase">{time}</span>
  </div>
);
