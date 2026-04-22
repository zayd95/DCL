
import React, { useState, useMemo, useEffect } from 'react';
import { 
  collection, 
  onSnapshot, 
  query, 
  orderBy, 
  where,
  collectionGroup,
  limit,
  getDocs
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { 
  Plus, 
  Box, 
  Package, 
  Settings, 
  FileText, 
  Scan, 
  MapPin, 
  ChevronRight,
  TrendingUp,
  AlertCircle,
  Building2,
  MoreVertical,
  Bell,
  Ship,
  Navigation,
  ArrowUpRight,
  ArrowDownRight,
  PieChart as PieIcon,
  X,
  Triangle,
  Search
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { Depot, StockItem } from '../types';
import Fuse from 'fuse.js';

// --- HOOKS ---

export function useUnreadAlerts() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'alerts'), where('read', '==', false));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setCount(snapshot.size);
    }, (err) => {
      console.warn("Unread alerts listener error", err);
    });
    return () => unsubscribe();
  }, []);

  return count;
}

export function useDepots() {
  const [data, setData] = useState<Depot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'depots'), orderBy('created_at', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Depot));
      setData(items);
      setLoading(false);
    }, (err) => {
      console.warn("Depots listener error", err);
    });
    return () => unsubscribe();
  }, []);

  return { data, loading };
}

export function useStock(depotId: string | 'all') {
  const [lots, setLots] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth.currentUser) return;
    setLoading(true);
    
    // Using simple collectionGroup query to avoid index management issues
    // Client-side filtering is efficient enough for the Hub's scale
    const q = query(collectionGroup(db, 'stock'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      let items = snapshot.docs.map(doc => {
        const data = doc.data();
        const dId = data.depotId || data.depot_id || 'unassigned';
        return { 
          id: doc.id, 
          ...data,
          cartons: data.cartons || data.quantity || 0,
          product: data.product || data.productName || 'Sans nom',
          depot_id: dId,
          stockType: data.stockType || 'unitized',
          unitWeight: data.unitWeight || 0
        } as StockItem;
      });

      // Filter by depot if not 'all'
      if (depotId !== 'all') {
        items = items.filter(i => i.depot_id === depotId);
      }

      // Filtering out archived items
      setLots(items.filter(i => i.status !== 'archived'));
      setLoading(false);
    }, (error) => {
      console.error("Firestore Error in useStock:", error);
      setLoading(false);
    });
    return () => unsubscribe();
  }, [depotId]);

  return { lots, loading };
}

// --- COMPONENTS ---

const StockCard = React.memo(({ id, container, product, cartons, status, aging_days, depot_name, cost_basis, sku, stockType, unitWeight, totalWeightKg, userRole, onClick }: any) => {
  const isFefoUrgent = aging_days > 90;
  const canSeeFinancials = userRole === "admin" || userRole === "manager";

  // Robust quantity logic for display
  const unitsCount = Number(cartons || 0);
  const uWeight = Number(unitWeight || 0);
  const displayTotalWeight = stockType === 'bulk' 
    ? (Number(totalWeightKg) || 0)
    : (unitsCount * uWeight || Number(totalWeightKg) || 0);

  const displayValue = () => {
    if (!canSeeFinancials) return "•••• XOF 🔒";
    if (!cost_basis || Number(cost_basis) === 0) return "Non défini";
    const val = Number(cost_basis);
    if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
    return val.toLocaleString();
  };

  const getStatusLabel = (s: string) => {
    switch(s) {
      case 'quay_pad': return 'AU QUAI';
      case 'stored': return 'EN STOCK';
      case 'in_transit': return 'TRANSIT';
      default: return 'LIVRÉ';
    }
  };

  const getStatusColorClass = (s: string) => {
    switch(s) {
      case 'quay_pad': return 'border-accent-gold/50';
      case 'stored': return 'border-brand/50';
      default: return 'border-success/50';
    }
  };

  const getProductIcon = (p: string) => {
    const product = p.toUpperCase();
    if (product.includes('BUFFALO') || product.includes('MEAT')) return '🥩';
    if (product.includes('WOOD') || product.includes('PLYWOOD')) return '🪵';
    return '📦';
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={cn(
        "p-3 bg-white/70 backdrop-blur-xl rounded-xl border-l-[4px] shadow-lg shadow-black/5 flex flex-col gap-2 transition-all border border-white/50",
        isFefoUrgent ? "bg-red-500/5 border-red-200/50" : getStatusColorClass(status)
      )}
    >
      <div className="flex justify-between items-start">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="text-lg">{getProductIcon(product)}</span>
          <h4 className="text-caption font-black text-brand-dark truncate uppercase tracking-tight">
            {product}
          </h4>
        </div>
        <div className={cn(
          "px-2 py-0.5 rounded text-micro font-black tracking-widest",
          isFefoUrgent ? "bg-red-500 text-white" : "bg-white/50 text-text-secondary border border-border-default"
        )}>
          {isFefoUrgent ? "⚠️ FEFO" : getStatusLabel(status)}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-col overflow-hidden">
           <div className="flex items-center gap-1.5">
             <span className="text-micro font-mono font-bold text-text-muted uppercase tracking-tight truncate">{container}</span>
             {sku && (
               <span className="text-micro font-black bg-surface-subtle text-text-muted px-1 rounded truncate tracking-tighter">SKU: {sku}</span>
             )}
           </div>
           <div className="flex items-center gap-1 text-micro font-black text-text-muted uppercase tracking-widest mt-0.5">
              <MapPin size={9} className="text-brand/40" /> {depot_name}
           </div>
        </div>
        {stockType === 'bulk' && (
          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-purple-50 text-purple-500 rounded text-micro font-black uppercase">
            Vr
          </div>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2 border-t border-white/50 pt-2 mt-0.5">
        <div className="flex flex-col col-span-2">
           <span className="text-micro font-black text-text-muted uppercase tracking-wider">Inventaire Actuel</span>
           <div className="flex flex-col">
             <span className="text-caption font-black text-brand-dark uppercase">
               {stockType === 'bulk' ? `${displayTotalWeight.toLocaleString()} KG` : `${unitsCount.toLocaleString()} CTN`}
             </span>
             {stockType === 'unitized' && displayTotalWeight > 0 && (
               <span className="text-micro font-bold text-text-muted uppercase tracking-tight">
                 {displayTotalWeight.toLocaleString()} KG TOTAL
               </span>
             )}
             {stockType === 'bulk' && (
               <span className="text-micro font-bold text-text-muted uppercase tracking-tight italic">
                 {container ? `Origine: ${container}` : "1 Container"}
               </span>
             )}
           </div>
        </div>
        <div className="flex flex-col">
           <span className="text-micro font-black text-text-muted uppercase tracking-wider">Âge</span>
           <span className="text-label font-black text-brand-dark uppercase">{aging_days}j</span>
        </div>
        <div className="flex flex-col items-end">
           <span className="text-micro font-black text-text-muted uppercase tracking-wider">Valeur</span>
           <span className={cn(
             "text-label font-black uppercase",
             canSeeFinancials ? "text-brand" : "text-text-muted"
           )}>
             {displayValue()}
           </span>
        </div>
      </div>
    </motion.div>
  );
});
StockCard.displayName = 'StockCard';

const SyncIndicator = () => {
  const [lastSync, setLastSync] = useState(new Date().toLocaleTimeString());
  
  return (
    <div className="flex items-center gap-1.5 mt-0.5">
       <div className="w-1 h-1 bg-status-success rounded-full animate-pulse shadow-md" />
       <span className="text-micro font-black text-white/40 uppercase tracking-widest leading-none">HUB • {lastSync}</span>
    </div>
  );
};

export const StockHome = ({ onNavigate, onSelectStock }: { onNavigate: (screen: string) => void, onSelectStock?: (id: string, depotId?: string) => void }) => {
  const [selectedDepotId, setSelectedDepotId] = useState<'all' | string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showNotifications, setShowNotifications] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  const unreadAlerts = useUnreadAlerts();
  
  const { data: depots, loading: depotsLoading } = useDepots();
  const { lots: stock, loading: stockLoading } = useStock(selectedDepotId);

  const [userRole, setUserRole] = useState<string | null>(null);

  useEffect(() => {
    const fetchUserRole = async () => {
      if (auth.currentUser) {
        try {
          const userDoc = await getDocs(query(collection(db, 'users'), where('uid', '==', auth.currentUser.uid)));
          if (!userDoc.empty) {
            setUserRole(userDoc.docs[0].data().role);
          }
        } catch (e) {
          console.error("Error fetching user role:", e);
        }
      }
    };
    fetchUserRole();
  }, []);

  // Fetch recent alerts for bottom sheet
  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'alerts'), orderBy('timestamp', 'desc'), limit(10));
    const unsub = onSnapshot(q, (snap) => {
      setAlerts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return () => unsub();
  }, []);

  const stats = useMemo(() => {
    return stock.reduce((acc, lot) => {
      const q = Number(lot.cartons || lot.quantity || 0) || 0;
      const unitP = Number(lot.unitPrice || 0) || 0;
      const val = Number(lot.cost_basis || (q * unitP) || 0) || 0;
      const isUrgent = (Number(lot.aging_days) || 0) > 90;
      
      return {
        totalCartons: acc.totalCartons + q,
        totalValue: acc.totalValue + val,
        alerts: acc.alerts + (isUrgent ? 1 : 0)
      };
    }, {totalCartons: 0, totalValue: 0, alerts: 0});
  }, [stock]);

  const filteredStock = useMemo(() => {
    if (!searchQuery.trim()) return stock;
    
    const fuse = new Fuse(stock, {
      keys: ['product', 'productName', 'sku', 'container', 'lotNumber'],
      threshold: 0.3,
      distance: 100
    });
    
    return fuse.search(searchQuery).map(result => result.item);
  }, [stock, searchQuery]);


  return (
    <div className="h-full bg-surface-page max-w-[480px] mx-auto relative flex flex-col font-sans overflow-hidden">
      
      {/* 1. HEADER FIXE */}
      <header className="flex-none h-[130px] bg-gradient-to-br from-ocean-dark to-ocean-primary p-4 rounded-b-xl flex flex-col justify-between shadow-xl overflow-hidden relative">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl p-6" />
        <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-2">
             <div className="w-8 h-8 bg-white rounded-xl flex items-center justify-center text-brand-dark shadow-xl">
                <Package size={18} />
             </div>
             <div className="flex flex-col">
                <h1 className="text-lg font-black text-white tracking-tighter uppercase leading-none">DEPOTEK</h1>
                <SyncIndicator />
             </div>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setShowNotifications(true)}
              className="w-8 h-8 bg-white/10 backdrop-blur-md rounded-xl border border-white/20 flex items-center justify-center relative active:scale-90 transition-transform"
            >
              <Bell className="text-white" size={16} />
              {unreadAlerts > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-micro font-black rounded-full flex items-center justify-center border border-brand-dark shadow-lg">
                  {unreadAlerts}
                </span>
              )}
            </button>
            <button 
              onClick={() => onNavigate('Settings')}
              className="w-8 h-8 bg-white/10 backdrop-blur-md rounded-xl border border-white/20 flex items-center justify-center overflow-hidden active:scale-95 transition-transform"
            >
              {auth.currentUser?.photoURL ? (
                <img src={auth.currentUser.photoURL} alt="User" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <Settings className="text-white/40" size={16} />
              )}
            </button>
          </div>
        </div>

        {/* Depot Selector */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1 h-10 relative z-10">
          <button 
            onClick={() => setSelectedDepotId('all')}
            className={cn(
              "flex-none px-4 py-1.5 rounded-lg text-micro font-black uppercase tracking-widest transition-all",
              selectedDepotId === 'all' 
                ? "bg-white text-brand-dark shadow-xl" 
                : "bg-white/10 text-white border border-white/10"
            )}
          >
            Tous
          </button>
          
          {depots.map(depot => (
            <div key={depot.id} className="relative flex-none">
              <button 
                onClick={() => setSelectedDepotId(depot.id)}
                className={cn(
                  "px-4 py-1.5 rounded-lg text-micro font-black uppercase tracking-widest transition-all flex items-center gap-2",
                  selectedDepotId === depot.id 
                    ? "bg-white text-brand-dark shadow-xl" 
                    : "bg-white/10 text-white border border-white/10"
                )}
              >
                {depot.name}
                <span className={cn(
                  "px-1.5 py-0.5 rounded text-micro font-black",
                  selectedDepotId === depot.id ? "bg-brand-dark text-white" : "bg-white/20 text-white"
                )}>
                  {depot.current_load || 0}
                </span>
              </button>
              {selectedDepotId === depot.id && (
                <button 
                  onClick={() => onNavigate('depots')}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-brand text-white rounded-full flex items-center justify-center shadow-lg border border-white"
                >
                  <MoreVertical size={8} />
                </button>
              )}
            </div>
          ))}

          <button 
            onClick={() => onNavigate('depots')}
            className="flex-none w-8 h-8 border-2 border-dashed border-white/20 rounded-xl flex items-center justify-center text-white/40 hover:bg-white/5 transition-colors"
          >
            <Settings size={14} />
          </button>
        </div>
      </header>

      {/* 2. MAIN SCROLLABLE CONTENT */}
      <main className="flex-1 overflow-y-auto no-scrollbar overscroll-contain pb-32">
        {/* KPI CARDS */}
        <section className="px-4 relative -mt-8 z-[110] mb-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 bg-white/70 backdrop-blur-xl p-3 rounded-xl shadow-xl shadow-black/5 border border-white/50 flex items-center justify-between">
              <div>
                <p className="text-micro font-black text-text-muted uppercase tracking-[0.2em] mb-0.5">Valeur Totale</p>
                <h2 className="text-lg font-black text-brand tracking-tighter">
                  {(stats.totalValue / 1000000).toFixed(2)} <span className="text-micro font-black text-text-muted uppercase">mfcfa</span>
                </h2>
              </div>
              <div className="w-8 h-8 bg-surface-subtle rounded-lg flex items-center justify-center text-brand shadow-inner">
                 <TrendingUp size={16} />
              </div>
            </div>
            
            <div className="bg-white/70 backdrop-blur-xl p-3 rounded-xl shadow-xl shadow-black/5 border border-white/50 flex flex-col justify-center min-h-[60px]">
               <p className="text-micro font-black text-text-muted uppercase tracking-widest mb-0.5">Inventaire</p>
               <h3 className="text-base font-black text-brand-dark tracking-tighter">{stats.totalCartons} <span className="text-micro uppercase opacity-40">ctn</span></h3>
            </div>

            <div className={cn(
              "p-3 rounded-xl shadow-xl border flex flex-col justify-center min-h-[60px] backdrop-blur-xl transition-all",
              stats.alerts > 0 ? "bg-red-500/5 border-red-200/50 text-red-600" : "bg-white/70 border-white/50 text-text-muted"
            )}>
               <p className="text-micro font-black uppercase tracking-widest mb-0.5">Alertes</p>
               <h3 className={cn(
                  "text-base font-black tracking-tighter",
                  stats.alerts > 0 ? "text-red-500" : "text-text-muted"
               )}>{stats.alerts} <span className="text-micro uppercase opacity-40">FEFO</span></h3>
            </div>
          </div>
        </section>

        {/* SEARCH BAR */}
        <section className="px-4 mb-4">
           <div className="relative group">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-brand transition-colors">
                 <Search size={16} />
              </div>
              <input 
                 type="text"
                 placeholder="Chercher Container, SKU, Produit..."
                 value={searchQuery}
                 onChange={(e) => setSearchQuery(e.target.value)}
                 className="w-full bg-white/70 backdrop-blur-xl border border-white/50 rounded-xl p-3.5 pl-12 text-caption font-black text-brand-dark placeholder:text-text-muted outline-none focus:ring-4 focus:ring-brand/5 transition-all shadow-lg shadow-black/5"
              />
              {searchQuery && (
                <button 
                  onClick={() => setSearchQuery('')}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-text-muted hover:text-brand-dark"
                >
                  <X size={14} />
                </button>
              )}
           </div>
        </section>

        {/* STOCK LIST */}
        <section className="px-4 space-y-3">
          <div className="flex items-center justify-between px-1">
             <h3 className="text-label font-black uppercase tracking-[0.2em] text-text-muted">
               {searchQuery ? `Résultats (${filteredStock.length})` : 'Inventaire Actif'}
             </h3>
          </div>

          <div className="space-y-2.5">
             {stockLoading ? (
               <div className="py-20 flex flex-col items-center justify-center text-text-muted gap-3">
                 <div className="w-8 h-8 border-4 border-border-default border-t-ocean-primary rounded-full animate-spin" />
                 <p className="text-micro font-black uppercase tracking-[0.3em]">Synchro...</p>
               </div>
             ) : filteredStock.length === 0 ? (
               <div className="py-20 flex flex-col items-center justify-center text-gray-200">
                 <Package size={64} strokeWidth={1} className="opacity-10 mb-4" />
                 <h4 className="text-xs font-black text-text-muted uppercase">
                   {searchQuery ? 'Aucun résultat' : 'Vide'}
                 </h4>
                 {!searchQuery && (
                   <button onClick={() => onNavigate('AddStock')} className="mt-3 px-4 py-1.5 bg-surface-subtle rounded-lg text-micro font-black text-brand-dark uppercase tracking-widest">Initialiser</button>
                 )}
               </div>
             ) : (
               filteredStock.map(lot => (
                  <StockCard 
                     key={lot.id}
                     id={lot.id}
                     container={lot.container}
                     product={lot.productName || lot.product}
                     cartons={lot.cartons || lot.quantity}
                     status={lot.status}
                     aging_days={lot.aging_days}
                     depot_name={depots.find(d => d.id === (lot.depot_id || lot.depotId))?.name || 'CENTRE'}
                     cost_basis={lot.cost_basis || lot.totalValue}
                     sku={lot.sku}
                     stockType={lot.stockType}
                     unitWeight={lot.unitWeight}
                     totalWeightKg={lot.totalWeightKg}
                     userRole={userRole}
                     onClick={() => onSelectStock?.(lot.id, lot.depot_id || lot.depotId)}
                  />
                ))
             )}
          </div>
        </section>
      </main>

      {/* NOTIFICATIONS BOTTOM SHEET */}
      <AnimatePresence>
        {showNotifications && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowNotifications(false)}
              className="fixed inset-0 bg-brand-dark/60 backdrop-blur-sm z-[200]"
            />
            <motion.div 
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-white rounded-t-[40px] z-[210] shadow-2xl p-6 min-h-[60vh] flex flex-col pt-10"
            >
               {/* Handle icon */}
               <div className="absolute top-4 left-1/2 -translate-x-1/2 w-12 h-1 bg-slate-200 rounded-full" />
               
               <div className="flex items-center justify-between mb-8">
                  <h2 className="text-xl font-black text-brand-dark tracking-tighter uppercase">Notifications</h2>
                  <button 
                    onClick={() => setShowNotifications(false)}
                    className="w-10 h-10 bg-surface-subtle rounded-2xl flex items-center justify-center text-text-muted"
                  >
                    <X size={20} />
                  </button>
               </div>

               <div className="flex-1 overflow-y-auto space-y-4 no-scrollbar pb-10">
                  {alerts.length === 0 ? (
                    <div className="py-20 flex flex-col items-center justify-center text-text-muted">
                      <Bell size={64} strokeWidth={1} className="opacity-20 mb-4" />
                      <p className="text-label font-black uppercase tracking-widest">Aucune alerte</p>
                    </div>
                  ) : (
                    alerts.map(alert => (
                      <motion.button 
                        key={alert.id}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => {
                          if (alert.stockId) onSelectStock?.(alert.stockId, alert.depotId);
                          setShowNotifications(false);
                        }}
                        className={cn(
                          "w-full p-5 rounded-3xl border text-left flex items-start gap-4 transition-all",
                          alert.read ? "bg-white border-border-default" : "bg-blue-50/50 border-blue-100"
                        )}
                      >
                         <div className={cn(
                           "w-12 h-12 rounded-2xl flex items-center justify-center shrink-0",
                           alert.severity === 'critical' ? "bg-red-100 text-red-600" : "bg-surface-subtle text-brand"
                         )}>
                            {alert.severity === 'critical' ? <AlertCircle size={24} /> : <Triangle size={20} />}
                         </div>
                         <div className="space-y-1">
                            <h4 className="text-body font-black text-brand-dark leading-tight">{alert.title}</h4>
                            <p className="text-caption font-medium text-text-secondary line-clamp-2">{alert.message}</p>
                            <span className="text-micro font-bold text-text-muted uppercase block mt-1">
                               {alert.timestamp?.toDate ? new Date(alert.timestamp.toDate()).toLocaleString('fr-FR') : 'Date inconnue'}
                            </span>
                         </div>
                      </motion.button>
                    ))
                  )}
               </div>

               <button 
                 onClick={() => onNavigate('Notifications')}
                 className="w-full py-5 bg-brand text-white rounded-3xl font-black uppercase text-label tracking-widest shadow-xl shadow-brand/20"
               >
                 Voir tout l'historique
               </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* FAB - Add Stock */}
      <motion.button 
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => onNavigate('AddStock')}
        className="fixed bottom-24 right-6 w-16 h-16 bg-brand text-white rounded-full shadow-2xl shadow-blue-500/40 flex items-center justify-center z-[160] border-4 border-white"
      >
        <Plus size={32} strokeWidth={3} />
      </motion.button>
    </div>
  );
};
