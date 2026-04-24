
import React, { useMemo, useEffect, useState } from 'react';
import { 
  TrendingUp, 
  PieChart as PieIcon, 
  Package,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
  Box,
  Ship,
  Building2,
  LayoutDashboard,
  AlertCircle,
  Clock,
  Zap,
  Plus,
  ArrowDown,
  ArrowUp,
  Search,
  CheckCircle2,
  Calendar,
  Truck,
  ShieldCheck,
  MoreVertical,
  Activity,
  Anchor,
  AlertTriangle,
  Lightbulb,
  ArrowRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { computeStockState } from '../lib/stockService';
import { db, auth } from '../lib/firebase';
import { collection, query, onSnapshot, collectionGroup, where, orderBy, limit, Timestamp } from 'firebase/firestore';
import { Depot, StockItem } from '../types';
import { useDepots, useStock } from './StockHome';

interface LogEntry {
  id: string;
  type: string;
  message: string;
  user: string;
  timestamp: any;
  quantity?: number;
  product?: string;
  container?: string;
}

interface TrackingDoc {
  id: string;
  containerId: string;
  carrier: string;
  status: string;
  eta: string;
}

export const Dashboard = ({ onNavigate }: { onNavigate: (screen: string) => void }) => {
  const { data: depots } = useDepots();
  const { lots: allStock } = useStock('all');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tracking, setTracking] = useState<TrackingDoc[]>([]);
  const [todayVolume, setTodayVolume] = useState(0);
  const [isFabOpen, setIsFabOpen] = useState(false);
  const todayKey = new Date().toDateString();

  // 1. DATA: LIVE MOVEMENTS
  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'logs'), orderBy('timestamp', 'desc'), limit(10));
    const unsub = onSnapshot(q, (snap) => {
      setLogs(snap.docs.map(d => ({ id: d.id, ...d.data() } as LogEntry)));
    });
    return () => unsub();
  }, []);

  // 2. DATA: TODAY'S VOLUME (Auto-refresh on day change)
  useEffect(() => {
    if (!auth.currentUser) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const q = query(collection(db, 'logs'), where('timestamp', '>=', today));
    const unsub = onSnapshot(q, (snap) => {
      const vol = snap.docs.reduce((acc, d) => {
        const data = d.data();
        return acc + (Number(data.quantity) || 0);
      }, 0);
      setTodayVolume(vol);
    });
    return () => unsub();
  }, [todayKey]);

  // 3. DATA: TRACKING (Incoming containers)
  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'tracking'), limit(10));
    const unsub = onSnapshot(q, (snap) => {
      setTracking(snap.docs.map(d => ({ id: d.id, ...d.data() } as TrackingDoc)));
    });
    return () => unsub();
  }, []);

  // 4. LOGIC: SMART INSIGHTS
  const smartInsights = useMemo(() => {
    const insights = [];
    const saturatedDepots = depots.filter(d => ((d.current_load || 0) / (d.capacity_cartons || 1)) > 0.85);
    const incomingSoon = tracking.filter(t => (t.status || '').toLowerCase().includes('port') || (t.status || '').toLowerCase().includes('arrivé'));

    if (saturatedDepots.length > 0 && incomingSoon.length > 0) {
      insights.push({
        id: 'clash',
        title: `Risque de Blocage HUB`,
        desc: `${saturatedDepots[0].name} saturé + ${incomingSoon.length} conteneurs arrivant.`,
        suggested: 'Action: Libérer de l\'espace immédiatement.',
        type: 'danger'
      });
    }

    const valueAtRisk = allStock.reduce((acc, s) => {
      const { daysToExpiry } = computeStockState(s);
      if (daysToExpiry === null || daysToExpiry >= 30) return acc;
      return acc + (s.costBasis || 0);
    }, 0);

    if (valueAtRisk > 1000000) {
      insights.push({
        id: 'value',
        title: 'Capital à Risque FEFO',
        desc: `${(valueAtRisk / 1000000).toFixed(1)} mFCFA arrivent à expiration.`,
        suggested: 'Action: Planifier sorties prioritaires.',
        type: 'warning'
      });
    }

    return insights;
  }, [depots, tracking, allStock]);

  // 5. LOGIC: REQUIRED ACTIONS (Actionable)
  const requiredActions = useMemo(() => {
    const actions = [];

    // FEFO Urgency — < 7 days to expiry maps to CRITICAL (state machine)
    const fefoUrgent = allStock.filter(s => {
      const { daysToExpiry } = computeStockState(s);
      return daysToExpiry !== null && daysToExpiry < 7;
    });

    if (fefoUrgent.length > 0) {
      actions.push({
        id: 'fefo',
        title: 'Lots Critiques (<7j)',
        desc: `${fefoUrgent.length} lots expirent d'ici dimanche.`,
        suggested: 'Action : Prioriser sortie FEFO',
        severity: 'critical',
        icon: <AlertCircle />,
        cta: 'Voir Lots',
        action: () => onNavigate('inventaire')
      });
    }

    // Capacity Warning
    const fullDepots = depots.filter(d => ((d.current_load || 0) / (d.capacity_cartons || 1)) > 0.95);
    if (fullDepots.length > 0) {
      actions.push({
        id: 'capacity',
        title: 'Alerte Saturation',
        desc: `${fullDepots[0].name} dépasse sa limite nominale.`,
        suggested: 'Action : Transférer vers Dépôt Sec',
        severity: 'warning',
        icon: <AlertTriangle />,
        cta: 'Gérer',
        action: () => onNavigate('depots')
      });
    }

    // New Incoming
    if (tracking.length > 0) {
      actions.push({
        id: 'tracking',
        title: 'Arrivées Maritimes',
        desc: `${tracking.length} conteneurs approchent du HUB.`,
        suggested: 'Action : Vérifier bons de sortie',
        severity: 'info',
        icon: <Ship />,
        cta: 'Suivi',
        action: () => onNavigate('entrees')
      });
    }

    return actions;
  }, [allStock, depots, tracking]);

  const stats = useMemo(() => {
    const totalV = allStock.reduce((acc, s) => acc + (Number(s.cost_basis) || 0), 0);
    
    // Average saturation
    const totalCap = depots.reduce((acc, d) => acc + (Number(d.capacity_cartons) || 0), 0);
    const totalL = depots.reduce((acc, d) => acc + (Number(d.current_load) || 0), 0);
    const avgSat = totalCap > 0 ? (totalL / totalCap) * 100 : 0;

    // FEFO Status — count items at CRITICAL/EXPIRED or expiring within a month
    const urgentCount = allStock.filter(s => {
      const { daysToExpiry, healthStatus } = computeStockState(s);
      if (daysToExpiry === null) return healthStatus === 'CRITICAL' || healthStatus === 'EXPIRED';
      return daysToExpiry < 30;
    }).length;
    const fefoHealth = allStock.length > 0 ? 100 - (Math.min((urgentCount / allStock.length) * 100, 100)) : 100;

    return {
      totalValue: totalV,
      averageSaturation: avgSat,
      fefoHealth,
      urgentCount
    };
  }, [allStock, depots]);

  return (
    <div className="h-full bg-surface-page max-w-[480px] mx-auto font-sans overflow-hidden relative flex flex-col text-brand-dark">
      {/* HEADER: COMMAND CENTER */}
      <header className="flex-none bg-gradient-to-br from-ocean-dark to-ocean-primary p-3 rounded-b-xl shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-80 h-80 bg-white/10 rounded-full -mr-40 -mt-40 blur-3xl opacity-50" />
        <div className="flex items-center justify-between relative z-10">
           <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-white/10 backdrop-blur-xl rounded-lg flex items-center justify-center text-white border border-white/20 shadow-inner">
                 <Activity size={16} className="text-white" />
              </div>
              <div>
                <h1 className="text-lg font-black text-white tracking-tighter uppercase leading-none">CENTRE</h1>
                <p className="text-micro font-black text-white/40 uppercase tracking-[0.2em] mt-1">DEPOTEK HUB</p>
              </div>
           </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar overscroll-contain px-4 py-4 space-y-5 pb-32">
        
        {/* 4 STRATEGIC WIDGETS (TEMPS RÉEL) - Détachés du header */}
        <section className="grid grid-cols-2 gap-2 -mt-8 relative z-30">
           {/* Widget 1: Volume Today */}
           <div className="bg-white/70 backdrop-blur-xl p-3 rounded-xl shadow-xl shadow-black/5 border border-white/50 flex flex-col gap-1.5 min-h-[70px]">
              <div className="flex items-center justify-between">
                 <div className="w-6 h-6 bg-blue-500/10 text-blue-600 rounded-lg flex items-center justify-center">
                    <Zap size={12} />
                 </div>
                 <p className="text-micro font-black text-text-muted uppercase tracking-widest leading-none">Passage</p>
              </div>
              <div>
                <h2 className="text-base font-black text-brand-dark tracking-tighter leading-none">
                  {todayVolume} <span className="text-micro text-text-muted capitalize font-bold">ctn</span>
                </h2>
                <p className="text-micro font-black text-blue-600/60 uppercase tracking-[0.15em] mt-1">Aujourd'hui</p>
              </div>
           </div>
           
           {/* Widget 2: Global Value */}
           <div className="bg-white/70 backdrop-blur-xl p-3 rounded-xl shadow-xl shadow-black/5 border border-white/50 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                 <div className="w-6 h-6 bg-emerald-500/10 text-emerald-600 rounded-lg flex items-center justify-center">
                    <TrendingUp size={12} />
                 </div>
                 <p className="text-micro font-black text-text-muted uppercase tracking-widest leading-none">Valeur</p>
              </div>
              <div>
                <h2 className="text-base font-black text-brand-dark tracking-tighter leading-none">
                  {(stats.totalValue / 1000000).toFixed(1)}M
                </h2>
                <p className="text-micro font-black text-emerald-600/60 uppercase tracking-[0.15em] mt-1">FCFA (WMS)</p>
              </div>
           </div>

           {/* Widget 3: Saturation */}
           <div className="bg-white/70 backdrop-blur-xl p-3 rounded-xl shadow-xl shadow-black/5 border border-white/50 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                 <div className="w-6 h-6 bg-amber-500/10 text-amber-600 rounded-lg flex items-center justify-center">
                    <Building2 size={12} />
                 </div>
                 <p className="text-micro font-black text-text-muted uppercase tracking-widest leading-none">Espace</p>
              </div>
              <div>
                <div className="flex items-end gap-1 leading-none">
                  <h2 className="text-base font-black text-brand-dark tracking-tighter">
                    {Math.round(stats.averageSaturation)}%
                  </h2>
                </div>
                <div className="mt-1 h-1 w-full bg-slate-200/50 rounded-full overflow-hidden">
                   <div 
                     className={cn("h-full transition-all duration-1000", stats.averageSaturation > 90 ? "bg-red-500" : "bg-amber-500")} 
                     style={{ width: `${Math.min(stats.averageSaturation, 100)}%` }} 
                   />
                </div>
              </div>
           </div>

           {/* Widget 4: État FEFO */}
           <div className="bg-white/70 backdrop-blur-xl p-3 rounded-xl shadow-xl shadow-black/5 border border-white/50 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                 <div className="w-6 h-6 bg-purple-500/10 text-purple-600 rounded-lg flex items-center justify-center">
                    <ShieldCheck size={12} />
                 </div>
                 <p className="text-micro font-black text-text-muted uppercase tracking-widest leading-none">Qualité</p>
              </div>
              <div>
                <div className="flex items-center gap-1 leading-none">
                  <h2 className={cn(
                    "text-base font-black tracking-tighter",
                    stats.fefoHealth < 80 ? "text-orange-500" : "text-brand-dark"
                  )}>
                    {Math.round(stats.fefoHealth)}%
                  </h2>
                </div>
                <p className="text-micro font-black text-purple-600/60 uppercase tracking-[0.15em] mt-1">Santé FEFO</p>
              </div>
           </div>
        </section>

        {/* PRIORITE DU JOUR */}
        <section className="space-y-2">
           <div className="flex items-center gap-2 px-1">
             <div className="w-1.5 h-1.5 bg-brand rounded-full" />
             <h3 className="text-micro font-black text-brand-dark uppercase tracking-[0.2em]">Priorité du Jour</h3>
           </div>
           <div className="bg-brand-dark/95 backdrop-blur-xl p-3 rounded-xl shadow-xl shadow-ocean-dark/10 relative overflow-hidden group border border-white/10">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/5 rounded-full blur-2xl group-hover:scale-125 transition-transform" />
              <div className="flex items-start gap-3 relative z-10">
                 <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center text-white shrink-0">
                    <Anchor size={16} />
                 </div>
                 <div className="flex-1">
                    <h4 className="text-white font-black text-caption uppercase tracking-tight">Dépotage MSC Prévu</h4>
                    <p className="text-white/60 text-micro font-medium mt-1 leading-relaxed">2 conteneurs MSC attendus au HUB avant 16h.</p>
                    <div className="flex gap-2 mt-2">
                       <button onClick={() => onNavigate('entrees')} className="flex items-center gap-1.5 text-micro font-black text-white bg-white/10 px-2.5 py-1.5 rounded-lg uppercase tracking-widest border border-white/10 hover:bg-white hover:text-brand-dark transition-all">
                          Action <ArrowRight size={10} />
                       </button>
                       <button 
                         onClick={async () => {
                           const res = await fetch('/api/test-push', { method: 'POST' });
                           if (res.ok) alert("Test envoyé!");
                         }}
                         className="text-micro font-black text-white/30 uppercase hover:text-white transition-colors"
                       >
                         Diag 📡
                       </button>
                    </div>
                 </div>
              </div>
           </div>
        </section>

        {/* SMART INSIGHTS */}
        {smartInsights.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between px-1">
               <h3 className="text-micro font-black text-text-muted uppercase tracking-[0.2em]">Smart Insights</h3>
               <Lightbulb size={12} className="text-yellow-500 animate-pulse opacity-50" />
            </div>
            <div className="space-y-2">
               {smartInsights.map(insight => (
                 <div key={insight.id} className={cn(
                   "p-3 rounded-xl backdrop-blur-xl border border-white/50 shadow-md flex flex-col gap-1 relative overflow-hidden",
                   insight.type === 'danger' ? "bg-red-500/5" : "bg-orange-500/5"
                 )}>
                    <div className="flex items-center gap-1.5">
                       <Zap size={12} className={insight.type === 'danger' ? "text-red-500" : "text-orange-500"} />
                       <h5 className={cn("text-micro font-black uppercase tracking-tight", insight.type === 'danger' ? "text-red-900" : "text-orange-900")}>
                         {insight.title}
                       </h5>
                    </div>
                    <p className="text-micro font-medium text-text-secondary leading-tight">{insight.desc}</p>
                    <div className={cn("text-micro font-black uppercase tracking-widest mt-0.5", insight.type === 'danger' ? "text-red-500" : "text-orange-500")}>
                      {insight.suggested}
                    </div>
                 </div>
               ))}
            </div>
          </section>
        )}

        {/* ACTIONS REQUISES (Actionable Cards) */}
        <section className="space-y-3">
           <div className="flex items-center justify-between px-1">
             <h3 className="text-micro font-black text-text-muted uppercase tracking-[0.2em]">Actions Requises</h3>
           </div>
           <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1">
              {requiredActions.map(action => (
                <motion.div 
                  key={action.id}
                  style={{ borderRadius: '12px' }}
                  className={cn(
                    "flex-none w-[180px] p-3 border shadow-lg flex flex-col gap-2 relative overflow-hidden bg-white/70 backdrop-blur-xl",
                    action.severity === 'critical' ? "border-red-100 shadow-red-500/5" :
                    action.severity === 'warning' ? "border-orange-100 shadow-orange-500/5" :
                    "border-white/50 shadow-black/5"
                  )}
                >
                   <div className="flex items-start justify-between">
                      <div className={cn(
                        "w-8 h-8 rounded-lg flex items-center justify-center shadow-lg",
                        action.severity === 'critical' ? "bg-red-500 text-white shadow-red-500/30" :
                        action.severity === 'warning' ? "bg-orange-500 text-white shadow-orange-500/30" :
                        "bg-brand text-white shadow-brand/30"
                      )}>
                         {React.cloneElement(action.icon as React.ReactElement, { size: 16 } as any)}
                      </div>
                      <div className={cn(
                        "px-1.5 py-0.5 rounded text-micro font-black uppercase tracking-widest",
                        action.severity === 'critical' ? "bg-red-50 text-red-500" : "bg-surface-subtle text-text-muted"
                      )}>
                        {action.severity === 'critical' ? 'Urgent' : 'Info'}
                      </div>
                   </div>
                   
                   <div className="min-h-[50px]">
                      <h4 className={cn(
                         "text-label font-black uppercase tracking-tight mb-0.5",
                         action.severity === 'critical' ? "text-red-600" :
                         action.severity === 'warning' ? "text-orange-600" :
                         "text-brand-dark"
                      )}>{action.title}</h4>
                      <p className="text-micro font-medium text-text-secondary leading-tight mb-1">{action.desc}</p>
                   </div>
                   
                   <button 
                     onClick={action.action}
                     className={cn(
                       "w-full py-2 rounded-lg text-micro font-black uppercase tracking-widest transition-all",
                       action.severity === 'critical' ? "bg-red-500 text-white shadow-lg" :
                       "bg-brand-dark text-white shadow-lg"
                     )}
                   >
                     {action.cta}
                   </button>
                </motion.div>
              ))}
           </div>
        </section>

        {/* SATURATION DEPOTS NORMALIZED */}
        <section className="space-y-3">
           <div className="flex items-center justify-between px-1">
              <h3 className="text-micro font-black text-text-muted uppercase tracking-[0.2em]">Occupation Dépôts</h3>
              <Building2 size={12} className="text-brand opacity-30" />
           </div>
           <div className="bg-white/70 backdrop-blur-xl p-2.5 space-y-2 shadow-lg border border-white/50" style={{ borderRadius: '16px' }}>
              {depots.map(depot => {
                const rawSaturation = ((depot.current_load || 0) / (depot.capacity_cartons || 1)) * 100;
                const saturationProgress = Math.min(Math.round(rawSaturation), 100);
                const isFull = rawSaturation >= 95;

                return (
                  <div key={depot.id} className="bg-white/50 p-3 border border-white/50" style={{ borderRadius: '12px' }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                         <div className="w-2 h-2 rounded-full" style={{ backgroundColor: depot.color }} />
                         <span className="text-micro font-black text-brand-dark uppercase tracking-tight">{depot.name}</span>
                      </div>
                      <span className={cn(
                        "text-micro font-black tracking-tight",
                        isFull ? "text-red-600" : "text-text-muted"
                      )}>{Math.round(rawSaturation)}%</span>
                    </div>
                    <div className="h-1 w-full bg-surface-subtle rounded-full overflow-hidden">
                       <motion.div 
                         initial={{ width: 0 }}
                         animate={{ width: `${saturationProgress}%` }}
                         className={cn("h-full rounded-full", isFull ? "bg-red-500" : "bg-brand")}
                       />
                    </div>
                  </div>
                );
              })}
           </div>
        </section>

        {/* FLUX D'ACTIVITÉ SMART FEED */}
        <section className="space-y-3">
           <div className="flex items-center justify-between px-1">
              <h3 className="text-micro font-black text-text-muted uppercase tracking-[0.2em]">Flux Live</h3>
              <Clock size={12} className="text-brand opacity-20" />
           </div>
           <div className="space-y-2">
              {logs.slice(0, 6).map(log => {
                const isUrgent = (log.message || '').toLowerCase().includes('urgent') || (log.type || '').includes('CRITICAL');
                
                return (
                  <div key={log.id} className="flex items-start gap-3 p-3 bg-white/70 backdrop-blur-xl border border-white/50 shadow-sm" style={{ borderRadius: '14px' }}>
                     <div className={cn(
                       "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 shadow-sm",
                       isUrgent ? "bg-red-50 text-red-500" : "bg-surface-subtle text-text-muted"
                     )}>
                        {isUrgent ? <AlertCircle size={14} /> : <Activity size={14} />}
                     </div>
                     <div className="flex-1 min-w-0 pt-0.5">
                        <div className="flex justify-between items-start">
                           <h5 className="text-label font-bold text-brand-dark uppercase tracking-tight truncate pr-2">
                             {log.message}
                           </h5>
                           <span className="text-micro font-black text-text-muted">
                             {log.timestamp?.toDate ? new Date(log.timestamp.toDate()).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '...'}
                           </span>
                        </div>
                        <p className="text-micro font-black text-brand/50 uppercase tracking-widest mt-0.5">
                           {log.user} • {log.container || 'HUB'}
                        </p>
                     </div>
                  </div>
                );
              })}
           </div>
        </section>

      </main>

      {/* FAB: ACTION CENTER */}
      <div className="fixed bottom-24 right-6 flex flex-col items-end gap-3 z-[160]">
         <AnimatePresence>
            {isFabOpen && (
               <motion.div 
                 initial={{ opacity: 0, y: 10, scale: 0.9 }}
                 animate={{ opacity: 1, y: 0, scale: 1 }}
                 exit={{ opacity: 0, y: 10, scale: 0.9 }}
                 className="flex flex-col items-end gap-4 mb-3"
               >
                  <FabOption label="Sortie" icon={<ArrowUpRight size={20} />} onClick={() => onNavigate('MovementForm')} color="bg-orange-500" />
                  <FabOption label="Entrée" icon={<ArrowDownRight size={20} />} onClick={() => onNavigate('MovementForm')} color="bg-brand" />
                  <FabOption label="Rechercher" icon={<Search size={20} />} onClick={() => onNavigate('Scan')} color="bg-brand-dark" />
               </motion.div>
            )}
         </AnimatePresence>

         <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setIsFabOpen(!isFabOpen)}
            className={cn(
              "w-16 h-16 rounded-full shadow-[0_15px_40px_rgba(26,35,126,0.3)] flex items-center justify-center border-[5px] border-white transition-all shadow-xl",
              isFabOpen ? "bg-brand-dark text-white rotate-45" : "bg-brand text-white"
            )}
         >
            <Plus size={32} strokeWidth={3} />
         </motion.button>
      </div>
    </div>
  );
};

const FabOption = ({ label, icon, onClick, color }: any) => (
  <motion.button 
    whileHover={{ x: -4 }}
    onClick={onClick}
    className="flex items-center gap-3 group"
  >
     <span className="px-3 py-1.5 bg-white shadow-xl rounded-xl text-label font-black text-brand-dark uppercase tracking-widest border border-border-default opacity-0 group-hover:opacity-100 transition-opacity">
        {label}
     </span>
     <div className={cn("w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-xl shadow-black/5", color)}>
        {icon}
     </div>
  </motion.button>
);
