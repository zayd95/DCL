import React, { useState, useEffect } from 'react';
import { 
  Bell, 
  ChevronLeft, 
  Trash2, 
  CheckCircle2, 
  AlertTriangle, 
  Info, 
  Filter, 
  Search,
  Clock,
  MoreVertical,
  X,
  Box,
  Ship,
  Building2,
  PieChart as PieIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { db, auth } from '../lib/firebase';
import { 
  collection, 
  onSnapshot, 
  query, 
  orderBy, 
  updateDoc, 
  doc, 
  deleteDoc,
  where
} from 'firebase/firestore';
import { useToast } from '../context/ToastContext';
import { useUnreadAlerts } from './StockHome';

export const Notifications = ({ onBack, onNavigate }: { onBack: () => void, onNavigate: (screen: string) => void }) => {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning'>('all');
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();
  const unreadAlerts = useUnreadAlerts();

  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'alerts'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setAlerts(items);
      setLoading(false);
    }, (err) => {
      console.warn("Alerts listener error:", err);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const markAsRead = async (id: string) => {
    try {
      await updateDoc(doc(db, 'alerts', id), { read: true });
    } catch (err) {
      showToast("Erreur de mise à jour", "error");
    }
  };

  const deleteAlert = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'alerts', id));
      showToast("Alerte supprimée", "success");
    } catch (err) {
      showToast("Erreur de suppression", "error");
    }
  };

  const filteredAlerts = alerts.filter(a => filter === 'all' || a.level === filter);

  return (
    <div className="h-screen bg-surface-page max-w-[480px] mx-auto relative flex flex-col font-sans overflow-hidden">
      <header className="bg-brand-dark p-6 rounded-b-[40px] shadow-xl relative overflow-hidden sticky top-0 z-50 flex-none">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl p-6" />
        <div className="flex items-center justify-between relative z-10 mb-6">
          <button onClick={onBack} className="p-2 bg-white/10 rounded-xl text-white transition-colors">
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-xl font-black text-white uppercase tracking-tight">ALERTE CENTRE</h1>
          <div className="w-10" />
        </div>

        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 relative z-10">
          {['all', 'critical', 'warning'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f as any)}
              className={cn(
                "px-6 py-2.5 rounded-2xl text-label font-black uppercase tracking-widest transition-all whitespace-nowrap",
                filter === f ? "bg-white text-brand-dark shadow-lg" : "bg-white/10 text-white/50 border border-white/5"
              )}
            >
              {f === 'all' ? 'Toutes' : f === 'critical' ? ' 🔥 Critiques' : '⚠️ Vigilance'}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 p-6 space-y-4 pb-32 overflow-y-auto no-scrollbar scroll-smooth">
        {loading ? (
          <div className="py-20 text-center text-text-muted">
            <div className="w-10 h-10 border-4 border-border-default border-t-ocean-primary rounded-full animate-spin mx-auto mb-4" />
            <p className="text-label font-black uppercase tracking-widest">Récupération des alertes...</p>
          </div>
        ) : filteredAlerts.length === 0 ? (
          <div className="py-20 text-center opacity-20">
            <Bell size={80} className="mx-auto mb-6" />
            <p className="text-sm font-black uppercase tracking-widest">Aucune alerte en attente</p>
          </div>
        ) : (
          filteredAlerts.map((alert) => (
            <motion.div
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              key={alert.id}
              className={cn(
                "bg-white/70 backdrop-blur-xl p-4 rounded-[24px] border border-white/50 shadow-lg shadow-black/5 relative overflow-hidden transition-all",
                alert.read ? "opacity-60 grayscale-[0.5]" : "shadow-blue-500/5",
                alert.level === 'critical' && !alert.read ? "bg-red-500/5 border-red-200/50" : ""
              )}
            >
              {!alert.read && (
                <div className={cn(
                  "absolute top-0 right-0 w-2 h-2 rounded-bl-lg",
                  alert.level === 'critical' ? "bg-red-500" : "bg-brand"
                )} />
              )}
              
              <div className="flex gap-3.5">
                <div className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-inner",
                  alert.level === 'critical' ? "bg-red-50 text-red-500" : "bg-blue-50 text-brand"
                )}>
                  {alert.level === 'critical' ? <AlertTriangle size={18} /> : <Info size={18} />}
                </div>

                <div className="flex-1">
                  <div className="flex justify-between items-start mb-0.5">
                    <h3 className="text-body font-black text-brand-dark uppercase tracking-tight leading-tight pr-4">
                      {alert.title}
                    </h3>
                    <p className="text-micro font-bold text-text-muted whitespace-nowrap">
                      {alert.createdAt?.toDate ? alert.createdAt.toDate().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '...'}
                    </p>
                  </div>
                  <p className="text-caption text-text-secondary font-medium leading-normal mb-3">
                    {alert.body}
                  </p>

                  <div className="flex items-center justify-between gap-3 border-t border-white/50 pt-2.5">
                     <div className="flex items-center gap-1 text-micro font-black text-text-muted uppercase tracking-widest">
                        <Clock size={10} /> 
                        {alert.createdAt?.toDate ? alert.createdAt.toDate().toLocaleDateString('fr-FR') : 'Date...'}
                     </div>
                     <div className="flex gap-1.5">
                        {!alert.read && (
                          <button 
                            onClick={() => markAsRead(alert.id)}
                            className="bg-green-500 text-white px-2.5 py-1 rounded-lg text-micro font-black uppercase tracking-widest shadow-sm"
                          >
                            Lu
                          </button>
                        )}
                        <button 
                          onClick={() => deleteAlert(alert.id)}
                          className="bg-gray-50/50 text-text-muted p-1.5 rounded-lg border border-border-default/50"
                        >
                          <Trash2 size={10} />
                        </button>
                     </div>
                  </div>
                </div>
              </div>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
};
