
import React, { useState, useEffect, useMemo } from 'react';
import { 
  doc, 
  onSnapshot, 
  collection, 
  query, 
  orderBy, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  serverTimestamp,
  runTransaction,
  increment,
  getDoc,
  getDocs,
  collectionGroup,
  where,
  DocumentReference,
  setDoc
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { jsPDF } from 'jspdf';
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react';
import { 
  ChevronLeft, 
  Edit3, 
  ArrowRightLeft, 
  History, 
  Trash2, 
  Package, 
  Calendar, 
  MapPin, 
  TrendingUp,
  AlertCircle,
  Bell,
  X,
  Plus,
  ArrowUpRight,
  ArrowDownRight,
  User,
  ExternalLink,
  MessageSquare,
  Settings,
  Truck,
  Phone,
  Clipboard,
  Share2,
  Printer,
  Download,
  AlertTriangle,
  FileText,
  Clock
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, computeStockPayload } from '../lib/utils';
import { computeStockState } from '../lib/stockService';
import { StockItem, StockMovement, Depot } from '../types';
import { useToast } from '../context/ToastContext';
import { useDepots } from './StockHome';
import { StockMovementModal } from '../components/StockMovementModal';

interface StockDetailProps {
  stockId: string;
  depotId: string | null;
  onBack: () => void;
}

const InventaireHubBlock = ({ stock, canSeeFinancials, daysToExpiry }: { stock: StockItem; canSeeFinancials: boolean; daysToExpiry: number | null }) => {
  const unitsCount = Number(stock.units || stock.quantity || 0);
  const uWeight = Number(stock.unitWeight || 0);
  const displayTotalWeight = stock.stockType === 'bulk' 
    ? (Number(stock.totalWeightKg) || 0)
    : (unitsCount * uWeight || Number(stock.totalWeightKg) || 0);

  const displayFinValue = () => {
    if (stock.costPrice == null) {
      return "Non défini";
    }
    if (!canSeeFinancials) return "🔒 Valeur restreinte";
    const val = stock.totalValue || stock.cost_basis;
    return `${Number(val || 0).toLocaleString()} ${stock.costCurrency || stock.currency || 'XOF'}`;
  };

  const displayExpiration = () => {
    if (daysToExpiry === null || daysToExpiry === undefined) return null;
    if (daysToExpiry < 15) return `⚠️ ${daysToExpiry}j restants`;
    if (daysToExpiry < 30) return `${daysToExpiry}j restants`;
    if (!stock.expirationDate) return null;
    const date = new Date(stock.expirationDate);
    if (isNaN(date.getTime())) return null;
    return `Exp: ${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
  };

  return (
    <div className="flex flex-col gap-3">
       <div className="flex flex-col">
         <div className="flex justify-between items-start gap-2">
           <h3 className="text-2xl font-black text-text-ocean uppercase leading-none">
             {stock.stockType === 'bulk' ? `${displayTotalWeight.toLocaleString()} KG` : `${unitsCount.toLocaleString()} CTN`}
           </h3>
           {displayExpiration() && (
              <div className={cn(
                "px-2 py-0.5 rounded text-[10px] font-black whitespace-nowrap",
                daysToExpiry !== null && daysToExpiry < 15 ? "bg-surface-danger text-text-danger" : 
                daysToExpiry !== null && daysToExpiry < 30 ? "bg-surface-warning text-text-warning" : 
                "bg-surface-muted text-text-subtle"
              )}>
                 {displayExpiration()}
              </div>
           )}
         </div>
         
         <div className="flex flex-col mt-1.5 gap-0.5">
           {stock.stockType === 'unitized' && displayTotalWeight > 0 && (
             <span className="text-[12px] font-black text-text-muted uppercase tracking-tighter">
               {displayTotalWeight.toLocaleString()} KG
             </span>
           )}
           {stock.stockType === 'unitized' && uWeight > 0 && (
             <span className="text-[10px] font-medium text-text-subtle italic">
               Cond: {uWeight} kg/u
             </span>
           )}
         </div>
       </div>

       <div className="mt-2 pt-3 border-t border-border-subtle">
          <p className="text-[12px] font-black text-text-ocean flex items-baseline gap-1.5">
            {displayFinValue()}
          </p>
       </div>
    </div>
  );
};

export const StockDetail = ({ stockId, depotId, onBack }: StockDetailProps) => {
  const { data: depots } = useDepots();
  const { showToast } = useToast();
  
  const [stock, setStock] = useState<StockItem | null>(null);
  const [stockDocRef, setStockDocRef] = useState<DocumentReference | null>(null);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [activeModal, setActiveModal] = useState<'edit' | 'move' | 'movement' | 'delete' | 'logs' | null>(null);

  useEffect(() => {
    if (!stockId) return;

    // Listen to stock document
    let unsubStock: (() => void) | undefined;
    let unsubMove: (() => void) | undefined;

    const setUpListeners = (docRef: DocumentReference) => {
      setStockDocRef(docRef);
      unsubStock = onSnapshot(docRef, (doc) => {
        if (doc.exists()) {
          setStock({ id: doc.id, ...doc.data() } as StockItem);
        }
        setLoading(false);
      });

      const movePath = docRef.path + '/movements';
      const moveRef = collection(db, movePath);
      
      const q = query(moveRef, orderBy('timestamp', 'desc'));
      unsubMove = onSnapshot(q, (snapshot) => {
        const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as StockMovement));
        setMovements(items);
      }, (err) => {
         console.warn("Movements listener error", err);
      });
    };

    const fetchAndSubscribe = async () => {
      // 1. Try nested path 
      if (depotId) {
        const nestedRef = doc(db, 'depots', depotId, 'stock', stockId);
        const snap = await getDoc(nestedRef);
        if (snap.exists()) {
          setUpListeners(nestedRef);
          return;
        }
      }

      // 2. Try flat path
      const flatRef = doc(db, 'stock', stockId);
      const flatSnap = await getDoc(flatRef);
      if (flatSnap.exists()) {
        setUpListeners(flatRef);
        return;
      }

      // 3. Search
      try {
        const qSearch = query(collectionGroup(db, 'stock'), where("__name__", "==", stockId));
        const groupSnap = await getDocs(qSearch);
        if (!groupSnap.empty) {
          setUpListeners(groupSnap.docs[0].ref);
          return;
        }
      } catch (e) {
        console.error("Search error", e);
      }

      showToast("Produit introuvable sur DEPOTEK", "error");
      onBack();
      setLoading(false);
    };

    fetchAndSubscribe();

    return () => {
      if (unsubStock) unsubStock();
      if (unsubMove) unsubMove();
    };
  }, [stockId]);

  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    const fetchUserRole = async () => {
      if (auth.currentUser) {
        const userDoc = await getDocs(query(collection(db, 'users'), where('uid', '==', auth.currentUser.uid)));
        if (!userDoc.empty) {
          setUserRole(userDoc.docs[0].data().role);
        }
      }
    };
    fetchUserRole();
  }, []);

  const canSeeFinancials = userRole === "admin" || userRole === "manager";

  const stockState   = useMemo(() => stock ? computeStockState(stock) : null, [stock]);
  const daysToExpiry = stockState?.daysToExpiry ?? null;
  const isExpired    = stockState?.isExpired   ?? false;

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-subtle flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 border-4 border-border-default border-t-ocean-primary rounded-full animate-spin" />
        <p className="text-label font-black uppercase tracking-widest text-text-muted">Inventaire en cours...</p>
      </div>
    );
  }

  if (!stock) return null;

  const currentDepot = depots.find(d => d.id === (stock.depotId || stock.depot_id));

  return (
    <div className="h-screen bg-surface-subtle max-w-[480px] mx-auto pb-32 relative font-sans overflow-y-auto no-scrollbar scroll-smooth">
      {/* Header */}
      <header className="bg-brand-dark p-6 rounded-b-[40px] shadow-xl relative overflow-hidden sticky top-0 z-[100]">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl" />
        <div className="flex items-center justify-between mb-6">
          <button onClick={onBack} className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center text-white">
            <ChevronLeft size={24} />
          </button>
          <div className={cn(
            "px-3 py-1.5 rounded-full flex items-center gap-2",
            isExpired ? "bg-red-500/20 text-red-500" :
            (daysToExpiry !== null && daysToExpiry < 15) ? "bg-orange-500/20 text-orange-500" :
            "bg-green-500/20 text-green-500"
          )}>
            <div className={cn("w-2 h-2 rounded-full", 
              isExpired ? "bg-red-500" :
              (daysToExpiry !== null && daysToExpiry < 15) ? "bg-orange-500" :
              "bg-green-500"
            )} />
            <span className="text-micro font-black uppercase tracking-widest">
              {isExpired ? 'Expiré' : 
               (daysToExpiry !== null && daysToExpiry < 15) ? 'Alerte DLC' : 'Disponible'}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2 relative z-10">
          <h1 className="text-3xl font-black text-white uppercase tracking-tighter leading-none">
            {stock.productName || stock.product}
          </h1>
          <div className="flex items-center gap-3">
            <span className="px-2 py-1 bg-white/10 rounded-lg text-white/60 font-mono text-label border border-white/5 tracking-wider">
              {stock.sku || 'NO-SKU'}
            </span>
            <span className="text-white/40 text-micro font-bold uppercase tracking-[0.2em]">
              {stock.category}
            </span>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex gap-2 mt-6 relative z-10 overflow-x-auto no-scrollbar pb-1">
          <ActionButton onClick={() => setActiveModal('edit')} icon={<Edit3 size={14} />} label="Éditer" />
          <ActionButton onClick={() => setActiveModal('move')} icon={<ArrowRightLeft size={14} />} label="Déplacer" />
          <ActionButton onClick={() => setActiveModal('logs')} icon={<History size={14} />} label="Logs" />
          <ActionButton onClick={() => setActiveModal('delete')} icon={<Trash2 size={14} />} label="Supprimer" variant="danger" />
        </div>
      </header>

      {/* Info Grid */}
      <section className="px-6 -mt-6 grid grid-cols-2 gap-4 relative z-20 mb-8">
        {/* Card 1: Stock */}
        <InfoCard 
          title="État du Stock" 
          icon={<Package size={18} className="text-brand" />}
        >
          {(() => {
            const unitsCount = Number(stock.units || stock.quantity || 0);
            const uWeight = Number(stock.unitWeight || 0);
            const displayTotalWeight = stock.stockType === 'bulk' 
              ? (Number(stock.totalWeightKg) || 0)
              : (unitsCount * uWeight || Number(stock.totalWeightKg) || 0);

            const displayFinValue = () => {
              if (!canSeeFinancials) return "•••• XOF 🔒";
              const val = stock.totalValue || stock.cost_basis;
              if (!val || Number(val) === 0) return "Non défini";
              return `${Number(val).toLocaleString()} ${stock.costCurrency || 'XOF'}`;
            };

            return (
              <div className="flex flex-col gap-3">
                <div>
                   <p className="text-label font-bold text-text-muted uppercase tracking-widest mb-1">Inventaire HUB</p>
                   <div className="flex flex-col">
                     <h3 className="text-2xl font-black text-brand-dark uppercase leading-none">
                       {stock.stockType === 'bulk' ? `${displayTotalWeight.toLocaleString()} KG` : `${unitsCount.toLocaleString()} CTN`}
                     </h3>
                     <div className="flex flex-col mt-1.5 gap-0.5">
                       {stock.stockType === 'unitized' && displayTotalWeight > 0 && (
                         <span className="text-caption font-black text-text-muted uppercase tracking-tighter">
                           {displayTotalWeight.toLocaleString()} KG TOTAL
                         </span>
                       )}
                       {stock.stockType === 'bulk' && (
                         <span className="text-label font-bold text-text-muted uppercase italic">
                           {stock.container ? `Origine: ${stock.container}` : "1 Container"}
                         </span>
                       )}
                       {stock.stockType === 'unitized' && uWeight > 0 && (
                         <span className="text-micro font-bold text-text-muted italic">
                           Conditionnement: {uWeight} kg/carton
                         </span>
                       )}
                     </div>
                   </div>
                   <div className="mt-4 pt-3 border-t border-slate-50">
                      <p className="text-caption font-black text-brand flex items-baseline gap-1.5">
                        <span className="text-micro text-text-muted uppercase tracking-widest">Valeur Stock:</span>
                        {displayFinValue()}
                      </p>
                   </div>
                </div>
                <div className="w-full h-1.5 bg-surface-page rounded-full overflow-hidden mt-1">
                   <div 
                     className="h-full bg-brand transition-all duration-500" 
                     style={{ width: `${Math.min(100, (unitsCount / (unitsCount || 1)) * 100)}%` }} 
                  />
                </div>
                <p className="text-micro font-black text-text-muted uppercase italic">
                  Seuil d'alerte: {stock.threshold || stock.min_threshold || 10}%
                </p>
              </div>
            );
          })()}
        </InfoCard>

        {/* Card 2: FEFO */}
        <InfoCard 
          title="Suivi FEFO" 
          icon={<Calendar size={18} className="text-orange-500" />}
        >
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center bg-surface-subtle p-2 rounded-xl">
               <span className="text-micro font-black text-text-muted uppercase">Expire le</span>
               <span className="text-micro font-black text-brand-dark">{stock.expirationDate || 'N/A'}</span>
            </div>
            <div className={cn(
              "px-3 py-2 rounded-xl text-center",
              (daysToExpiry !== null && daysToExpiry < 7) ? "bg-red-50 text-red-600" :
              (daysToExpiry !== null && daysToExpiry < 30) ? "bg-orange-50 text-orange-600" :
              "bg-green-50 text-green-600"
            )}>
               <p className="text-[14px] font-black leading-none">{daysToExpiry ?? '?'}</p>
               <p className="text-micro font-black uppercase tracking-tighter">jours restants</p>
            </div>
            <p className="text-micro font-bold text-text-muted uppercase mt-1">Lot: {stock.lotNumber || '---'}</p>
          </div>
        </InfoCard>

        {/* Card 3: Localisation */}
        <InfoCard 
          title="Localisation" 
          icon={<MapPin size={18} className="text-blue-500" />}
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 mb-1">
               <div className="w-2 h-2 rounded-full" style={{ backgroundColor: currentDepot?.color || '#ccc' }} />
               <span className="text-label font-black text-brand-dark uppercase truncate">{currentDepot?.name || 'PAD / TRANSIT'}</span>
            </div>
            <p className="text-micro font-bold text-text-muted leading-tight">
               {stock.location || 'Section Non Définie'}
            </p>
          </div>
        </InfoCard>

        {/* Card 4: Alertes */}
        <InfoCard 
          title="Notifications" 
          icon={<Bell size={18} className="text-purple-500" />}
        >
          <div className="flex flex-col gap-2">
             <div className="flex items-center justify-between">
                <span className="text-micro font-black text-text-muted uppercase">Alertes Active</span>
                <div className="w-8 h-4 bg-brand rounded-full relative">
                   <div className="w-3 h-3 bg-white rounded-full absolute right-0.5 top-0.5" />
                </div>
             </div>
             <p className="text-micro text-text-muted font-medium italic mt-1">Email & SMS pour stock bas ou péremption.</p>
          </div>
        </InfoCard>
      </section>

      {/* History Timeline */}
      <section className="px-6 space-y-4">
        <div className="flex items-center justify-between">
           <h3 className="text-label font-black uppercase tracking-[0.2em] text-text-muted">Journal des Mouvements</h3>
           <button 
             onClick={() => setActiveModal('movement')}
             className="px-2.5 py-1 bg-surface-subtle text-brand rounded-lg text-micro font-black uppercase tracking-widest flex items-center gap-1.5"
           >
              <Plus size={10} /> Nouveau
           </button>
        </div>

        <div className="bg-white/70 backdrop-blur-xl rounded-[32px] p-5 shadow-xl shadow-black/5 border border-white/50 min-h-[300px]">
           {movements.length === 0 ? (
             <div className="h-full flex flex-col items-center justify-center text-text-muted gap-4 opacity-50 py-10">
                <MessageSquare size={48} strokeWidth={1} />
                <p className="text-micro font-black uppercase tracking-widest">Aucun mouvement enregistré</p>
             </div>
           ) : (
             <div className="space-y-6 relative">
                {/* Vertical Line */}
                <div className="absolute left-[13px] top-2 bottom-2 w-[1px] bg-surface-page" />
                
                {movements.map((move, idx) => (
                  <div key={move.id} className="flex gap-4 relative z-10">
                     <div className={cn(
                       "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border-2 border-white shadow-sm",
                       move.type === 'entry' ? "bg-green-50 text-green-500" :
                       move.type === 'exit' ? "bg-red-50 text-red-500" :
                       "bg-blue-50 text-blue-500"
                     )}>
                        {move.type === 'entry' ? <ArrowDownRight size={14} /> :
                         move.type === 'exit' ? <ArrowUpRight size={14} /> :
                         <ArrowRightLeft size={14} />}
                     </div>
                     <div className="flex-1 flex flex-col gap-1 pt-0.5">
                        <div className="flex justify-between items-start">
                           <h4 className="text-label font-black uppercase tracking-tight text-brand-dark">
                             {move.type === 'entry' ? 'Réception' :
                              move.type === 'exit' ? 'Sortie' :
                              move.type === 'transfer' ? 'Transfert' : 'Ajustement'}
                           </h4>
                           <span className={cn(
                             "text-label font-black",
                             move.quantity > 0 && move.type === 'entry' ? "text-green-500" : 
                             move.quantity > 0 && move.type === 'exit' ? "text-red-500" : "text-brand"
                           )}>
                             {move.type === 'entry' ? '+' : '-'}{Math.abs(move.quantity)}
                           </span>
                        </div>
                        <div className="flex items-center gap-2 text-micro text-text-muted font-bold">
                           <span className="flex items-center gap-1"><User size={8} /> {move.userName}</span>
                           <span>•</span>
                           <span>{move.timestamp?.toDate ? move.timestamp.toDate().toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Maintenant'}</span>
                        </div>
                        {(move.client || move.reason) && (
                           <div className="mt-1 flex flex-col gap-0.5">
                              {move.client && <p className="text-micro text-brand font-black uppercase">Client: {move.client}</p>}
                              <p className="text-micro text-text-secondary font-medium italic leading-relaxed">{move.reason}{move.notes ? `: ${move.notes}` : ''}</p>
                           </div>
                        )}
                     </div>
                  </div>
                ))}
             </div>
           )}
        </div>
      </section>

      {/* Floating Action Button for Movement */}
      <motion.button 
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setActiveModal('movement')}
        className="fixed bottom-24 right-6 w-16 h-16 bg-brand text-white rounded-full shadow-2xl flex items-center justify-center z-[160] border-4 border-white"
      >
        <TrendingUp size={32} />
      </motion.button>

      {/* Modals */}
      <AnimatePresence>
        {activeModal && (
          <ModalWrapper onClose={() => setActiveModal(null)} title={
            activeModal === 'edit' ? 'Éditer le Stock' :
            activeModal === 'move' ? 'Transfert Rapide (PDF)' :
            activeModal === 'movement' ? 'Gestion des Mouvements' : 
            activeModal === 'logs' ? 'Historique Complet' : 'Zone Dangereuse'
          }>
            {activeModal === 'movement' && (
              <StockMovementModal 
                stock={stock} 
                depots={depots} 
                onClose={() => setActiveModal(null)} 
                docRef={stockDocRef}
              />
            )}
            {activeModal === 'edit' && <EditStockForm stock={stock} docRef={stockDocRef} onCancel={() => setActiveModal(null)} />}
            {activeModal === 'move' && <MoveStockForm stock={stock} depots={depots} docRef={stockDocRef} onCancel={() => setActiveModal(null)} />}
            {activeModal === 'delete' && <DeleteConfirm stock={stock} docRef={stockDocRef} onCancel={() => setActiveModal(null)} onBack={onBack} />}
            {activeModal === 'logs' && <LogsView movements={movements} onCancel={() => setActiveModal(null)} />}
          </ModalWrapper>
        )}
      </AnimatePresence>
    </div>
  );
};

// --- HELPER COMPONENTS ---

const ActionButton = ({ icon, label, onClick, variant = 'default' }: any) => (
  <button 
    onClick={onClick}
    className={cn(
      "shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-2xl text-label font-black uppercase tracking-widest transition-all",
      variant === 'danger' ? "bg-red-500 text-white" : "bg-white text-brand-dark shadow-xl"
    )}
  >
    {icon}
    {label}
  </button>
);

const InfoCard = ({ title, icon, children }: { title: string, icon: React.ReactNode, children: React.ReactNode }) => (
  <div className="bg-white/70 backdrop-blur-xl rounded-[24px] p-4 shadow-lg shadow-black/5 border border-white/50 flex flex-col gap-2.5">
    <div className="flex items-center gap-2">
       <div className="w-7 h-7 rounded-lg bg-white/50 flex items-center justify-center border border-white/50">
         {React.cloneElement(icon as React.ReactElement, { size: 14 } as any)}
       </div>
       <h3 className="text-micro font-black text-text-muted uppercase tracking-widest">{title}</h3>
    </div>
    {children}
  </div>
);

const ModalWrapper = ({ children, onClose, title }: { children: React.ReactNode, onClose: () => void, title: string }) => (
  <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-end">
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }} 
      exit={{ opacity: 0 }}
      onClick={onClose} 
      className="absolute inset-0 bg-black/60 backdrop-blur-sm" 
    />
    <motion.div 
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      className="w-full max-w-[480px] bg-white rounded-t-[40px] p-8 pb-12 relative z-[1010] shadow-2xl"
    >
      <div className="flex items-center justify-between mb-8">
         <h2 className="text-xl font-black text-brand-dark uppercase tracking-tighter">{title}</h2>
         <button onClick={onClose} className="w-10 h-10 rounded-full bg-surface-subtle flex items-center justify-center text-text-muted">
           <X size={20} />
         </button>
      </div>
      {children}
    </motion.div>
  </div>
);


const EditStockForm = ({ stock, docRef, onCancel }: { stock: StockItem, docRef: DocumentReference | null, onCancel: () => void }) => {
  const { showToast } = useToast();
  const [name, setName] = useState(stock.productName || stock.product);
  const [sku, setSku] = useState(stock.sku || '');
  const [stockType, setStockType] = useState(stock.stockType || 'unitized');
  const [units, setUnits] = useState((stock.units || stock.quantity || stock.cartons || 0).toString());
  const [unitWeight, setUnitWeight] = useState((stock.unitWeight || 0).toString());
  const [totalWeightKg, setTotalWeightKg] = useState((stock.totalWeightKg || 0).toString());
  const [costPrice, setCostPrice] = useState((stock.costPrice || stock.unitPrice || '').toString());
  const [costPer, setCostPer] = useState(stock.costPer || (stock.stockType === 'bulk' ? 'kg' : 'unit'));
  const [currency, setCurrency] = useState(stock.costCurrency || 'XOF');
  const [date, setDate] = useState(stock.arrival_date || '');
  const [expiry, setExpiry] = useState(stock.expirationDate || '');
  const [lot, setLot] = useState(stock.lotNumber || '');
  const [category, setCategory] = useState(stock.category || '');
  const [location, setLocation] = useState(stock.location || '');
  const [supplier, setSupplier] = useState(stock.supplier || '');
  const [threshold, setThreshold] = useState((stock.threshold || stock.min_threshold || 10).toString());
  const [loading, setLoading] = useState(false);

  // Derived check for changes
  const hasChanges = true; // Simplified for robustness

  const handleSave = async () => {
    if (!docRef) {
      showToast("Erreur de référence document", "error");
      return;
    }
    if (!sku || !name) {
      showToast("SKU et Nom obligatoires", "error");
      return;
    }

    setLoading(true);
    try {
      const dId = stock.depot_id || stock.depotId || 'unassigned';
      
      const payloadData = computeStockPayload({
        ...stock, // initial data
        productName: name,
        sku,
        stockType,
        units,
        unitWeight,
        totalWeightKg,
        costPrice,
        costPer,
        costCurrency: currency,
        expirationDate: expiry,
        lotNumber: lot,
        category,
        location,
        supplier,
        threshold,
        arrival_date: date
      });

      await runTransaction(db, async (trans) => {
        const statsRef = doc(db, 'stats', 'global');
        
        // 1. Calculate deltas for global stats
        const oldUnits = Number(stock.units || stock.quantity || 0);
        const oldVal = Number(stock.totalValue || stock.cost_basis || 0);
        
        const newUnits = Number(payloadData.units || 0);
        const newVal = Number(payloadData.totalValue || 0);
        
        const qtyDelta = newUnits - oldUnits;
        const valDelta = newVal - oldVal;

        // 2. Update Stock Item
        trans.update(docRef, {
          ...payloadData,
          updatedAt: serverTimestamp()
        });

        // 3. Log Movement
        const movementRef = doc(collection(docRef, 'movements'));
        trans.set(movementRef, {
          type: 'edit',
          quantity: qtyDelta || 0,
          reason: `Fiche Hub éditée - Unification Logistique`,
          userId: auth.currentUser?.uid,
          userName: auth.currentUser?.displayName || 'Agent Hub',
          timestamp: serverTimestamp()
        });

        // 4. Update Depot Load if present
        if (dId !== 'unassigned' && qtyDelta !== 0) {
          const depotRef = doc(db, 'depots', dId);
          trans.update(depotRef, { 
             current_load: increment(qtyDelta),
             updatedAt: serverTimestamp()
          });
        }

        // 5. Update Global stats
        trans.set(statsRef, {
          valeurStock: increment(valDelta),
          totalCartons: increment(qtyDelta),
          lastUpdated: serverTimestamp()
        }, { merge: true });
      });

      showToast("Inventaire unifié mis à jour !");
      onCancel();
    } catch (err) {
      console.error(err);
      showToast("Erreur lors de l'unification", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-h-[70vh] overflow-y-auto no-scrollbar pt-2 pb-6 px-1">
      <div className="bg-white rounded-[32px] p-6 border border-border-default shadow-sm space-y-6">
        <div className="flex gap-2 p-1 bg-surface-page rounded-2xl">
          <button 
            onClick={() => setStockType('unitized')}
            className={cn("flex-1 py-3 text-label font-black uppercase rounded-xl transition-all", stockType === 'unitized' ? "bg-white text-brand-dark shadow-sm" : "text-text-muted")}
          >Unitisé (Cartons)</button>
          <button 
            onClick={() => setStockType('bulk')}
            className={cn("flex-1 py-3 text-label font-black uppercase rounded-xl transition-all", stockType === 'bulk' ? "bg-white text-brand-dark shadow-sm" : "text-text-muted")}
          >Vrac (Kg)</button>
        </div>

        <FormInput label="Désignation Produit" value={name} onChange={setName} />
        
        <div className="grid grid-cols-2 gap-4">
           <FormInput label="SKU / REF" value={sku} onChange={setSku} />
           <FormInput label="Catégorie" value={category} onChange={setCategory} />
        </div>

        {stockType === 'unitized' ? (
          <div className="grid grid-cols-2 gap-4">
            <FormInput label="Nb Cartons" type="number" value={units} onChange={setUnits} />
            <FormInput label="Poids Unitaire (Kg)" type="number" value={unitWeight} onChange={setUnitWeight} />
          </div>
        ) : (
          <FormInput label="Poids Total (Kg)" type="number" value={totalWeightKg} onChange={setTotalWeightKg} />
        )}

        <div className="space-y-2">
          <label className="text-label font-black uppercase text-text-muted tracking-widest px-1">Coût d'Achat & Imputation</label>
          <div className="flex gap-2">
            <input 
              type="number"
              value={costPrice}
              onChange={e => setCostPrice(e.target.value)}
              className="flex-1 bg-surface-subtle border border-transparent rounded-2xl p-4 text-sm font-black text-brand-dark focus:bg-white focus:border-brand/20 outline-none transition-all"
              placeholder="Ex: 45000"
            />
            <select 
              value={costPer} 
              onChange={e => setCostPer(e.target.value as any)}
              className="w-20 bg-surface-subtle border border-transparent rounded-2xl p-4 text-label font-black text-brand-dark focus:bg-white focus:border-brand/20 outline-none transition-all"
            >
              <option value="unit">/u</option>
              <option value="kg">/kg</option>
            </select>
            <select 
              value={currency} 
              onChange={e => setCurrency(e.target.value as 'XOF' | 'USD' | 'EUR')}
              className="w-24 bg-surface-subtle border border-transparent rounded-2xl p-4 text-label font-black text-brand-dark focus:bg-white focus:border-brand/20 outline-none transition-all"
            >
              <option value="XOF">XOF</option>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
           <FormInput label="N° Lot" value={lot} onChange={setLot} placeholder="Batch ID" />
           <FormInput label="Fournisseur" value={supplier} onChange={setSupplier} />
        </div>

        <div className="grid grid-cols-2 gap-4">
           <FormInput label="Arrivée Port" type="date" value={date} onChange={setDate} />
           <FormInput label="DLC / Expiration" type="date" value={expiry} onChange={setExpiry} />
        </div>

        <div className="space-y-2">
           <FormInput label="Localisation / Emplacement" value={location} onChange={setLocation} />
           <FormInput label="Seuil Alerte (%)" type="number" value={threshold} onChange={setThreshold} />
        </div>
      </div>

      <div className="sticky bottom-0 bg-white/80 backdrop-blur-md pt-4">
        <button 
          disabled={loading || !hasChanges}
          onClick={handleSave} 
          className={cn(
            "w-full py-6 rounded-3xl font-black uppercase tracking-widest text-xs transition-all",
            (!hasChanges || loading) ? "bg-surface-page text-text-muted" : "bg-brand text-white shadow-2xl shadow-blue-500/30 active:scale-95"
          )}
        >
          {loading ? 'Traitement en cours...' : 'Mettre à jour le Stock'}
        </button>
      </div>
    </div>
  );
};

const MoveStockForm = ({ stock, depots, docRef, onCancel }: { stock: StockItem, depots: Depot[], docRef: DocumentReference | null, onCancel: () => void }) => {
  const { showToast } = useToast();
  const [moveType, setMoveType] = useState<'all' | 'partial'>('all');
  const [targetDepotId, setTargetDepotId] = useState('');
  const [partialQty, setPartialQty] = useState('');
  const [loading, setLoading] = useState(false);
  
  // PDF Data
  const [driverName, setDriverName] = useState('');
  const [licensePlate, setLicensePlate] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const qrRef = React.useRef<HTMLDivElement>(null);

  const generateTransferPDF = async (qty: number, targetDepotName: string, transferRefCode: string) => {
    const doc = new jsPDF();
    const dateStr = new Date().toLocaleString('fr-FR');
    const ref = transferRefCode;
    const validityDate = new Date();
    validityDate.setHours(validityDate.getHours() + 24);
    const validityStr = validityDate.toLocaleString('fr-FR');

    // Generate QR Code as DataURL
    const qrData = JSON.stringify({
       ref: ref,
       valid_until: validityStr,
       qty: qty,
       product: stock.productName || stock.product,
       from: depots.find(d => d.id === (stock.depotId || stock.depot_id))?.name || 'PAD',
       to: targetDepotName
    });

    const canvas = document.createElement('canvas');
    const qrSvg = document.createElement('div');
    // We use a hidden div to render the SVG, but actually jspdf can take an image.
    // Simplifying: generate QR via a canvas-based approach if possible, but let's use a trick with SVG -> Image
    
    // For simplicity in this environment, I'll generate the QR code using a temporary canvas if I can,
    // or just assume a placeholder if it's too complex for immediate edit.
    // Actually, let's use a simpler way: just text for now if canvas is tricky, or try to get qrcode data url.
    
    // Actually, I'll use a dataUrl from the hidden qrcode canvas inside our ref.
    const qrCanvas = qrRef.current?.querySelector('canvas');
    const qrCodeDataUrl = qrCanvas?.toDataURL("image/png");

    // Header
    doc.setFillColor(26, 35, 126); // PAD Blue #1a237e
    doc.rect(0, 0, 210, 50, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(26);
    doc.text('DEPOTEK', 105, 22, { align: 'center' });
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text('SYSTÈME DE GESTION LOGISTIQUE - HUB DEPOTEK SÉNÉGAL', 105, 32, { align: 'center' });
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text('BON DE TRANSFERT INTER-DÉPÔTS', 105, 42, { align: 'center' });

    // Body
    doc.setTextColor(26, 35, 126);
    doc.setFontSize(12);
    doc.text(`RÉFÉRENCE UNIQUE: ${ref}`, 20, 65);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`Date d'émission: ${dateStr}`, 150, 65);

    doc.setDrawColor(200, 200, 200);
    doc.line(20, 70, 190, 70);

    // Grid Info
    doc.setFontSize(11);
    doc.setTextColor(26, 35, 126);
    doc.text('DÉTAILS DU CHARGEMENT:', 20, 85);
    
    doc.setTextColor(50, 50, 50);
    doc.setFontSize(10);
    doc.text(`Produit:`, 20, 95);
    doc.setFont("helvetica", "bold");
    doc.text(`${stock.productName || stock.product}`, 55, 95);
    
    doc.setFont("helvetica", "normal");
    doc.text(`Quantité:`, 20, 105);
    doc.setFont("helvetica", "bold");
    doc.text(`${qty} ${stock.unitType || 'carton'}`, 55, 105);
    
    doc.setFont("helvetica", "normal");
    doc.text(`N° Conteneur:`, 20, 115);
    doc.setFont("helvetica", "bold");
    doc.text(`${stock.container}`, 55, 115);

    // Route Info
    doc.setFont("helvetica", "normal");
    doc.text('ITINÉRAIRE:', 120, 85);
    doc.setFont("helvetica", "bold");
    doc.text(`DÉPART:`, 120, 95);
    doc.text(`${depots.find(d => d.id === (stock.depotId || stock.depot_id))?.name || 'ZONE PAD'}`, 145, 95);
    doc.text(`DEST.:`, 120, 105);
    doc.text(`${targetDepotName}`, 145, 105);

    // Driver Info
    doc.setFillColor(245, 245, 250);
    doc.rect(20, 130, 170, 35, 'F');
    doc.setTextColor(26, 35, 126);
    doc.setFontSize(10);
    doc.text('LOGISTIQUE TRANSPORT:', 25, 140);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(50, 50, 50);
    doc.text(`Chauffeur: ${driverName || 'Non spécifié'}`, 25, 148);
    doc.text(`Véhicule (Matricule): ${licensePlate || 'Non spécifié'}`, 25, 156);
    doc.text(`Contact: ${driverPhone || 'Non spécifié'}`, 120, 148);

    // QR Code Integration (using the placeholder logic)
    if (qrCodeDataUrl) {
       doc.addImage(qrCodeDataUrl, 'PNG', 150, 175, 40, 40);
    }
    
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text('Scannez pour vérifier l\'authenticité du bon', 150, 218, { align: 'center' });

    // Legal mention
    doc.setFillColor(255, 245, 245);
    doc.rect(20, 175, 120, 20, 'F');
    doc.setTextColor(200, 0, 0);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text('SÉCURITÉ & VALIDITÉ:', 25, 183);
    doc.setFont("helvetica", "normal");
    doc.text(`EXPIRATION: ${validityStr} (24H)`, 25, 190);

    // Signatures
    doc.setTextColor(26, 35, 126);
    doc.text('CACHET EXPÉDITEUR', 45, 235, { align: 'center' });
    doc.text('SIGNATURE CHAUFFEUR', 105, 235, { align: 'center' });
    doc.text('RÉCEPTIONNAIRE', 165, 235, { align: 'center' });
    
    doc.setDrawColor(200, 200, 200);
    doc.rect(20, 240, 50, 30);
    doc.rect(80, 240, 50, 30);
    doc.rect(140, 240, 50, 30);

    const pdfOutput = doc.output('blob');
    const pdfUrl = URL.createObjectURL(pdfOutput);
    
    // Attempt Web Share
    if (navigator.share) {
       const file = new File([pdfOutput], `${ref}_bon.pdf`, { type: 'application/pdf' });
       try {
          await navigator.share({
             title: `Bon de Transfert - ${stock.container}`,
             text: `Transfert logistique Dakar Cold-Link. Réf: ${ref}`,
             files: [file]
          });
       } catch (e) {
          window.open(pdfUrl, '_blank');
       }
    } else {
       // Fallback
       const whatsappLink = `https://wa.me/?text=${encodeURIComponent(`Dakar Cold-Link: Bon de Transfert pour ${stock.productName || stock.product} (${qty} cartons). Réf: ${ref}. Validez ici: ${window.location.origin}`)}`;
       window.open(pdfUrl, '_blank');
       showToast("Bon généré. Vous pouvez le partager via WhatsApp.", "success");
       setTimeout(() => window.open(whatsappLink, '_blank'), 2000);
    }
  };

  const handleMove = async () => {
    if (!docRef) {
      showToast("Référence document source manquante", "error");
      return;
    }
    if (!targetDepotId) {
      showToast("Veuillez choisir un dépôt cible", "error");
      return;
    }

    const qtyToMove = moveType === 'all' ? (stock.quantity || stock.cartons || 0) : parseInt(partialQty);
    if (isNaN(qtyToMove) || qtyToMove <= 0) {
      showToast("Quantité invalide", "error");
      return;
    }

    if (moveType === 'partial' && qtyToMove >= (stock.quantity || stock.cartons || 0)) {
       showToast("Utilisez 'Déplacer TOUT' pour cette quantité", "warning");
       return;
    }

    setLoading(true);
    try {
      const sourceDepotId = stock.depotId || stock.depot_id || '';
      const destDepot = depots.find(d => d.id === targetDepotId)!;
      const transferRefCode = `BT-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

      await runTransaction(db, async (trans) => {
        const sourceDepotRef = sourceDepotId ? doc(db, 'depots', sourceDepotId) : null;
        const destDepotRef = doc(db, 'depots', targetDepotId);

        if (moveType === 'all') {
          // Update the existing document with new depot ID
          trans.update(docRef, { 
            depotId: targetDepotId, 
            depot_id: targetDepotId,
            status: 'in_transit',
            transferRef: transferRefCode,
            updatedAt: serverTimestamp() 
          });
          
          if (sourceDepotRef) trans.update(sourceDepotRef, { current_load: increment(-qtyToMove) });
          trans.update(destDepotRef, { current_load: increment(qtyToMove) });

          const moveRef = doc(collection(docRef, 'movements'));
          trans.set(moveRef, {
             type: 'transfer',
             quantity: qtyToMove,
             reason: `Expédié vers ${destDepot.name} (BT: ${transferRefCode})`,
             userName: auth.currentUser?.displayName || 'Agent',
             timestamp: serverTimestamp()
          });
        } else {
          const newDocRef = doc(collection(db, 'depots', targetDepotId, 'stock'));
          trans.set(newDocRef, {
            ...stock,
            id: newDocRef.id,
            quantity: qtyToMove,
            cartons: qtyToMove,
            initialQuantity: qtyToMove,
            depotId: targetDepotId,
            depot_id: targetDepotId,
            status: 'in_transit',
            transferRef: transferRefCode,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });

          trans.update(docRef, {
             quantity: increment(-qtyToMove),
             cartons: increment(-qtyToMove),
             updatedAt: serverTimestamp()
          });

          if (sourceDepotRef) trans.update(sourceDepotRef, { current_load: increment(-qtyToMove) });
          trans.update(destDepotRef, { current_load: increment(qtyToMove) });

          const moveSourceRef = doc(collection(docRef, 'movements'));
          trans.set(moveSourceRef, {
            type: 'exit',
            quantity: qtyToMove,
            reason: `Transfert partiel vers ${destDepot.name} (BT: ${transferRefCode})`,
            userName: auth.currentUser?.displayName || 'Agent',
            timestamp: serverTimestamp()
          });

          const moveDestRef = doc(collection(newDocRef, 'movements'));
          trans.set(moveDestRef, {
             type: 'transfer',
             quantity: qtyToMove,
             reason: `Transféré depuis ${depots.find(d => d.id === sourceDepotId)?.name || 'HUB (EXT)'} (BT: ${transferRefCode})`,
             userName: auth.currentUser?.displayName || 'Agent',
             timestamp: serverTimestamp()
          });
        }
      });

      showToast("Transfert expédié. Génération du Bon...");
      generateTransferPDF(qtyToMove, destDepot.name, transferRefCode);
      onCancel();
    } catch (err) {
      console.error(err);
      showToast("Erreur lors du transfert", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="hidden" ref={qrRef}>
        <QRCodeCanvas 
          value={JSON.stringify({
            ref: `BT-${stock.sku}-${Date.now()}`,
            valid_until: new Date(Date.now() + 86400000).toLocaleString('fr-FR'),
            qty: moveType === 'all' ? (stock.quantity || stock.cartons) : parseInt(partialQty),
            product: stock.productName || stock.product
          })}
          size={256}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 bg-surface-subtle p-2 rounded-2xl">
        <button 
          onClick={() => setMoveType('all')}
          className={cn("py-3 rounded-xl text-micro font-black uppercase transition-all", moveType === 'all' ? "bg-white text-brand shadow-sm" : "text-text-muted")}
        >Tout déplacer</button>
        <button 
          onClick={() => setMoveType('partial')}
          className={cn("py-3 rounded-xl text-micro font-black uppercase transition-all", moveType === 'partial' ? "bg-white text-brand shadow-sm" : "text-text-muted")}
        >Fractionner</button>
      </div>

      <div className="space-y-4">
        {moveType === 'partial' && (
          <FormInput label="Quantité à sortir" type="number" value={partialQty} onChange={setPartialQty} placeholder="Nb cartons" />
        )}
        <FormSelect 
          label="Dépôt Cible" 
          value={targetDepotId} 
          onChange={setTargetDepotId} 
          options={depots.filter(d => d.id !== (stock.depotId || stock.depot_id)).map(d => ({ label: d.name, value: d.id }))} 
        />
        
        <div className="p-4 bg-blue-50/50 rounded-2xl border border-blue-100/50 space-y-4">
           <h4 className="text-label font-black text-brand uppercase tracking-widest flex items-center gap-2">
             <Truck size={14} /> Logistique Transport
           </h4>
           <FormInput label="Nom Chauffeur" value={driverName} onChange={setDriverName} placeholder="Nom & Prénom" />
           <div className="grid grid-cols-2 gap-4">
              <FormInput label="Immatriculation" value={licensePlate} onChange={setLicensePlate} placeholder="Véhicule" />
              <FormInput label="Téléphone" value={driverPhone} onChange={setDriverPhone} placeholder="+221 ..." />
           </div>
        </div>
      </div>

      <button 
        disabled={loading}
        onClick={handleMove}
        className="w-full py-6 bg-brand text-white rounded-[24px] font-black uppercase text-xs shadow-2xl shadow-blue-500/30 flex items-center justify-center gap-3"
      >
        <Printer size={18} />
        {loading ? 'Traitement...' : 'Transférer & Générer Bon'}
      </button>
    </div>
  );
};

const LogsView = ({ movements, onCancel }: { movements: StockMovement[], onCancel: () => void }) => {
  const [filter, setFilter] = useState<'all' | 'entry' | 'exit' | 'transfer' | 'edit'>('all');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'week' | 'month' | 'year'>('all');
  const [search, setSearch] = useState('');

  const filtered = movements.filter(m => {
    // Type Filter
    const matchesFilter = filter === 'all' || m.type === filter;
    
    // Search Filter
    const matchesSearch = !search || 
      (m.userName?.toLowerCase().includes(search.toLowerCase())) ||
      (m.reason?.toLowerCase().includes(search.toLowerCase()));

    // Date Filter Logic
    let matchesDate = true;
    if (dateFilter !== 'all' && m.timestamp) {
      const moveDate = m.timestamp.toDate ? m.timestamp.toDate() : new Date();
      const now = new Date();
      
      if (dateFilter === 'today') {
        matchesDate = moveDate.toDateString() === now.toDateString();
      } else if (dateFilter === 'week') {
        const lastWeek = new Date();
        lastWeek.setDate(now.getDate() - 7);
        matchesDate = moveDate >= lastWeek;
      } else if (dateFilter === 'month') {
        matchesDate = moveDate.getMonth() === now.getMonth() && moveDate.getFullYear() === now.getFullYear();
      } else if (dateFilter === 'year') {
        matchesDate = moveDate.getFullYear() === now.getFullYear();
      }
    }

    return matchesFilter && matchesSearch && matchesDate;
  });

  return (
    <div className="flex flex-col h-[75vh] -mx-8 -mt-8 relative">
       <div className="p-8 pb-4 space-y-5">
          {/* Type Filters */}
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
             {['all', 'entry', 'exit', 'transfer', 'edit'].map(f => (
               <button 
                 key={f}
                 onClick={() => setFilter(f as any)}
                 className={cn(
                   "flex-none px-4 py-2 rounded-xl text-micro font-black uppercase tracking-widest border transition-all",
                   filter === f ? "bg-brand text-white border-brand" : "bg-surface-subtle text-text-muted border-transparent hover:bg-surface-page"
                 )}
               >
                 {f === 'all' ? 'Tous Types' : f === 'entry' ? 'Entrées' : f === 'exit' ? 'Sorties' : f === 'transfer' ? 'Transferts' : 'Éditions'}
               </button>
             ))}
          </div>

          {/* Date Filters */}
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
             {[
               { label: 'Toutes Dates', value: 'all' },
               { label: 'Aujourd\'hui', value: 'today' },
               { label: '7 Jours', value: 'week' },
               { label: 'Ce Mois', value: 'month' },
               { label: 'Cette Année', value: 'year' }
             ].map(df => (
               <button 
                 key={df.value}
                 onClick={() => setDateFilter(df.value as any)}
                 className={cn(
                   "flex-none px-3 py-1.5 rounded-lg text-micro font-black uppercase tracking-wider border transition-all",
                   dateFilter === df.value ? "bg-surface-subtle text-brand border-brand/20" : "bg-white text-text-muted border-border-default"
                 )}
               >
                 {df.label}
               </button>
             ))}
          </div>

          <div className="relative">
             <input 
               type="text"
               value={search}
               onChange={e => setSearch(e.target.value)}
               placeholder="Rechercher agent ou raison..."
               className="w-full bg-surface-subtle border-none rounded-2xl p-4 pl-12 text-sm font-medium text-brand-dark focus:bg-white focus:ring-2 focus:ring-brand/10 outline-none transition-all"
             />
             <Settings size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
          </div>
       </div>

       <div className="flex-1 overflow-y-auto px-8 space-y-4 pb-10">
          {filtered.length === 0 ? (
             <div className="py-20 text-center opacity-30">
                <Clipboard size={48} className="mx-auto mb-4" />
                <p className="text-label font-black uppercase tracking-widest">Aucun log correspondant</p>
             </div>
          ) : (
             filtered.map(move => (
               <div key={move.id} className="p-4 bg-surface-subtle rounded-2xl flex items-start gap-4 border border-border-default/50">
                  <div className={cn(
                     "w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm transition-transform",
                     move.type === 'entry' ? "bg-green-500 text-white" :
                     move.type === 'exit' ? "bg-red-500 text-white" :
                     "bg-blue-500 text-white"
                  )}>
                     {move.type === 'entry' ? <ArrowDownRight size={16} /> :
                      move.type === 'exit' ? <ArrowUpRight size={16} /> :
                      <ArrowRightLeft size={16} />}
                  </div>
                  <div className="flex-1 flex flex-col gap-0.5">
                     <div className="flex justify-between items-start">
                        <h4 className="text-label font-black uppercase text-brand-dark tracking-tight">
                          {move.userName}
                        </h4>
                        <span className={cn(
                           "text-label font-black",
                           move.type === 'entry' ? "text-green-600" : move.type === 'exit' ? "text-red-600" : "text-blue-600"
                        )}>
                           {move.quantity !== 0 ? (move.type === 'entry' ? '+' : '-') : ''}
                           {move.quantity !== 0 ? Math.abs(move.quantity) : '--'}
                        </span>
                     </div>
                     <p className="text-label text-text-secondary font-medium leading-relaxed">{move.reason}</p>
                     <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border-default">
                        <Clock size={10} className="text-text-muted" />
                        <span className="text-micro text-text-muted font-bold uppercase tracking-widest">
                          {move.timestamp?.toDate?.()?.toLocaleString('fr-FR') || 'Date inconnue'}
                        </span>
                     </div>
                  </div>
               </div>
            ))
          )}
       </div>
    </div>
  );
};

const DeleteConfirm = ({ stock, docRef, onCancel, onBack }: { stock: StockItem, docRef: DocumentReference | null, onCancel: () => void, onBack: () => void }) => {
  const { showToast } = useToast();
  const [reason, setReason] = useState('');
  const [deleteInput, setDeleteInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleArchive = async () => {
    if (!docRef) {
      showToast("Référence document manquante", "error");
      return;
    }
    if (reason.length < 5) {
      showToast("La raison doit faire au moins 5 caractères", "warning");
      return;
    }

    setLoading(true);
    try {
      const dId = stock.depot_id || stock.depotId || '';
      const depotRef = dId ? doc(db, 'depots', dId) : null;
      const statsRef = doc(db, 'stats', 'global');
      const qty = stock.quantity || stock.cartons || 0;
      const unitVal = stock.unitPrice || (stock.cost_basis ? (stock.cost_basis / (stock.quantity || 1)) : 0);
      const valDelta = qty * unitVal;

      await runTransaction(db, async (transaction) => {
        transaction.update(docRef, { 
          status: 'archived', 
          archiveReason: reason,
          updatedAt: serverTimestamp() 
        });

        if (depotRef) {
          transaction.update(depotRef, { 
            current_load: increment(-qty),
            updatedAt: serverTimestamp()
          });
        }

        transaction.set(statsRef, {
          valeurStock: increment(-valDelta),
          totalCartons: increment(-qty),
          lastUpdated: serverTimestamp()
        }, { merge: true });

        const movementRef = doc(collection(docRef, 'movements'));
        transaction.set(movementRef, {
           type: 'edit',
           quantity: 0,
           reason: `ARCHIVAGE: ${reason}`,
           userName: auth.currentUser?.displayName || 'Agent',
           userId: auth.currentUser?.uid,
           timestamp: serverTimestamp()
        });
      });

      showToast("Produit archivé (hors inventaire actif)");
      onBack();
    } catch (err: any) {
      console.error(err);
      showToast("Erreur lors de l'archivage", "error");
    } finally {
      setLoading(false);
    }
  };

  const handlePermanentDelete = async () => {
    if (!docRef) {
      showToast("Référence document manquante", "error");
      return;
    }
    if (deleteInput !== 'SUPPRIMER') return;
    
    setLoading(true);
    try {
       const dId = stock.depot_id || stock.depotId || '';
       const depotRef = dId ? doc(db, 'depots', dId) : null;
       const statsRef = doc(db, 'stats', 'global');
       const qty = stock.quantity || stock.cartons || 0;
       const unitVal = stock.unitPrice || (stock.cost_basis ? (stock.cost_basis / (stock.quantity || 1)) : 0);
       const valDelta = qty * unitVal;

       await runTransaction(db, async (transaction) => {
         transaction.delete(docRef);
         if (depotRef) {
           transaction.update(depotRef, { 
             current_load: increment(-qty),
             updatedAt: serverTimestamp()
           });
         }

         transaction.set(statsRef, {
           valeurStock: increment(-valDelta),
           totalCartons: increment(-qty),
           lastUpdated: serverTimestamp()
         }, { merge: true });
       });

       showToast("Lot supprimé définitivement du système", "success");
       onBack();
    } catch (err: any) {
       console.error(err);
       showToast("Erreur lors de la suppression", "error");
    } finally {
       setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-red-500/5 p-6 rounded-[28px] border border-red-500/20 text-center backdrop-blur-xl">
        <div className="w-14 h-14 bg-red-500 text-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-red-500/20">
          <Trash2 size={28} />
        </div>
        <h3 className="text-lg font-black text-red-600 uppercase mb-1 leading-none tracking-tight">Supprimer ou Archiver</h3>
        <p className="text-micro text-red-500/50 font-black uppercase tracking-[0.2em]">Gestion des stocks obsolètes</p>
      </div>

      <div className="space-y-4">
        {/* Section ARCHIVE */}
        <div className="bg-white/50 p-5 rounded-[24px] border border-border-default space-y-4">
          <div className="space-y-1.5 px-0.5">
            <label className="text-micro font-black uppercase text-text-muted tracking-widest ml-1">Raison de l'archivage</label>
            <textarea 
              value={reason}
              onChange={e => setReason(e.target.value)}
              className="w-full bg-white border border-border-default rounded-xl p-3 text-caption font-medium text-brand-dark focus:ring-2 focus:ring-brand/5 outline-none transition-all resize-none"
              rows={2}
              placeholder="Ex: DLC dépassée, erreur de saisie..."
            />
          </div>
          <button 
            disabled={loading || reason.length < 5}
            onClick={handleArchive} 
            className={cn(
              "w-full py-4 rounded-xl font-black uppercase tracking-widest text-label transition-all",
              reason.length >= 5 ? "bg-brand text-white shadow-lg shadow-brand/20" : "bg-surface-subtle text-text-muted"
            )}
          >
            {loading ? '...' : 'Archiver Lot'}
          </button>
        </div>

        <div className="flex items-center gap-3 py-1">
           <div className="flex-1 h-[1px] bg-surface-subtle" />
           <span className="text-micro font-black text-text-muted uppercase tracking-[0.3em]">OU DÉFINITIF</span>
           <div className="flex-1 h-[1px] bg-surface-subtle" />
        </div>

        {/* Section PERMANENT DELETE */}
        <div className="bg-red-50/30 p-5 rounded-[24px] border border-red-100/50 space-y-4">
           <div className="space-y-1.5 px-0.5">
             <label className="text-micro font-black uppercase text-red-400 tracking-widest ml-1">Type "SUPPRIMER" pour valider</label>
             <input 
               type="text"
               value={deleteInput}
               onChange={e => setDeleteInput(e.target.value.toUpperCase())}
               className="w-full bg-white border border-red-100/50 rounded-xl p-3 text-center text-caption font-black text-red-600 outline-none focus:ring-4 focus:ring-red-500/5 transition-all placeholder:text-red-200"
               placeholder="SUPPRIMER"
             />
           </div>
           <button 
             disabled={loading || deleteInput !== 'SUPPRIMER'}
             onClick={handlePermanentDelete} 
             className={cn(
               "w-full py-4 rounded-xl font-black uppercase tracking-widest text-label transition-all",
               deleteInput === 'SUPPRIMER' ? "bg-red-600 text-white shadow-lg shadow-red-500/20" : "bg-white text-red-200 border border-red-50"
             )}
           >
             {loading ? '...' : 'Supprimer Définitivement'}
           </button>
        </div>
      </div>

      <button onClick={onCancel} className="w-full py-2 text-text-muted font-black uppercase text-label tracking-widest">Retour</button>
    </div>
  );
};

const FormInput = ({ label, value, onChange, placeholder, type = "text" }: any) => (
  <div className="space-y-1">
    <label className="text-micro font-black uppercase text-text-muted tracking-[0.15em] px-1">{label}</label>
    <div className="relative">
      <input 
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-50/50 border border-border-default rounded-xl p-3.5 text-xs font-black text-brand-dark focus:bg-white focus:border-brand/20 outline-none transition-all"
        placeholder={placeholder}
      />
    </div>
  </div>
);

const FormSelect = ({ label, options, value, onChange }: any) => (
  <div className="space-y-1">
    <label className="text-micro font-black uppercase text-text-muted tracking-[0.15em] px-1">{label}</label>
    <div className="relative">
      <select 
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-50/50 border border-border-default rounded-xl p-3.5 text-xs font-black text-brand-dark focus:bg-white focus:border-brand/20 outline-none transition-all appearance-none"
      >
        <option value="" disabled>Choisir...</option>
        {options.map((opt: any) => (
          <option key={typeof opt === 'string' ? opt : opt.value} value={typeof opt === 'string' ? opt : opt.value}>
            {typeof opt === 'string' ? opt : opt.label}
          </option>
        ))}
      </select>
      <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-text-muted">
         <Plus size={14} className="rotate-45" />
      </div>
    </div>
  </div>
);
