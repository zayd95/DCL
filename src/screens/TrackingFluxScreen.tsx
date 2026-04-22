
import React, { useState, useEffect } from 'react';
import { 
  Search, 
  Settings, 
  Ship, 
  Anchor, 
  AlertTriangle, 
  ChevronRight, 
  Layers, 
  MapPin, 
  MoreVertical,
  Activity,
  Warehouse,
  Compass,
  ChevronDown,
  Navigation
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { trackingService, TrackingData, Milestone } from '../services/trackingService';
import { collection, onSnapshot, query, orderBy, Timestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';

type SearchType = 'AUTO' | 'CONTAINER' | 'BL' | 'BOOKING';
type FilterType = 'all' | 'transit' | 'arrived' | 'alerts';

export function TrackingFluxScreen({ onBack }: { onBack: () => void }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('AUTO');
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [isSearching, setIsSearching] = useState(false);
  const [trackings, setTrackings] = useState<TrackingData[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // --- DATA LOADING ---

  useEffect(() => {
    const q = query(collection(db, 'tracking'), orderBy('lastSync', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TrackingData));
      setTrackings(items);
    });
    return () => unsubscribe();
  }, []);

  // --- SEARCH LOGIC ---

  const handleSearch = async () => {
    if (!searchTerm.trim()) return;
    setIsSearching(true);
    const result = await trackingService.trackNewReference(searchTerm.trim());
    setIsSearching(false);
    if (!result) {
      alert("Référence non trouvée ou erreur API.");
    }
  };

  const detectedType = trackingService.detectReferenceType(searchTerm);

  // --- FILTERS ---

  const filteredTrackings = trackings.filter(t => {
    if (activeFilter === 'transit') return t.statut === 'in_transit' || t.statut === 'at_port';
    if (activeFilter === 'arrived') return t.statut === 'arrived' || t.statut === 'discharged' || t.statut === 'customs_clearance';
    if (activeFilter === 'alerts') return t.requiresAttention;
    return true;
  });

  const alertCount = trackings.filter(t => t.requiresAttention).length;

  return (
    <div className="min-h-screen bg-surface-page pb-32">
      {/* HEADER */}
      <div className="bg-gradient-to-br from-ocean-primary to-ocean-dark p-8 pb-14 rounded-b-[40px] shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl p-6" />
        <div className="flex items-center justify-between text-white mb-8 relative z-10">
          <button onClick={onBack} className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center backdrop-blur-md">
            <ChevronRight className="rotate-180" size={20} />
          </button>
          <h1 className="text-xl font-black uppercase tracking-[0.2em]">Tracking Flux</h1>
          <button className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center backdrop-blur-md">
            <Settings size={20} />
          </button>
        </div>

        {/* SEARCH SECTION */}
        <div className="space-y-4 relative z-10">
          <div className="relative group">
            <input 
              type="text" 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="N° Conteneur, BL, ou Booking..."
              className="w-full bg-white px-14 py-5 rounded-[1.75rem] text-sm font-bold text-slate-800 focus:ring-4 focus:ring-white/20 outline-none shadow-xl"
            />
            <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-text-muted" size={20} />
            <button 
              onClick={handleSearch}
              disabled={isSearching}
              className="absolute right-5 top-1/2 -translate-y-1/2 bg-brand text-white px-5 py-2.5 rounded-2xl font-black text-label uppercase tracking-widest active:scale-95 transition-all flex items-center gap-2"
            >
              {isSearching ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'Tracker'}
            </button>
          </div>

          <div className="flex gap-2 overflow-x-auto no-scrollbar py-1">
            {['AUTO', 'CONTAINER', 'BL', 'BOOKING'].map((type) => (
              <button 
                key={type}
                onClick={() => setSearchType(type as SearchType)}
                className={cn(
                  "px-6 py-2 rounded-full text-micro font-black uppercase tracking-widest border transition-all whitespace-nowrap",
                  searchType === type 
                    ? "bg-white text-brand border-white shadow-lg" 
                    : "bg-white/10 text-white/60 border-white/10"
                )}
              >
                {type} {detectedType === type && searchType === 'AUTO' && '•'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* FILTER TABS */}
      <div className="px-6 -mt-6">
        <div className="bg-white p-2 rounded-[2rem] shadow-xl flex gap-1">
          <FilterTab active={activeFilter === 'all'} onClick={() => setActiveFilter('all')} icon={<Layers size={18} />} label="Tous" />
          <FilterTab active={activeFilter === 'transit'} onClick={() => setActiveFilter('transit')} icon={<Ship size={18} />} label="En Transit" />
          <FilterTab active={activeFilter === 'arrived'} onClick={() => setActiveFilter('arrived')} icon={<Anchor size={18} />} label="Arrivés" />
          <FilterTab 
            active={activeFilter === 'alerts'} 
            onClick={() => setActiveFilter('alerts')} 
            icon={<AlertTriangle size={18} />} 
            label="Alertes" 
            badge={alertCount > 0 ? alertCount : undefined}
          />
        </div>
      </div>

      {/* LIVE INDICATOR */}
      <div className="flex justify-end px-8 mt-6">
        <div className="flex items-center gap-2 bg-green-50 px-3 py-1 rounded-full border border-green-100">
          <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
          <span className="text-micro font-black text-green-700 uppercase tracking-widest">Live DEPOTEK GPS </span>
        </div>
      </div>

      {/* TRACKING LIST */}
      <div className="px-6 mt-6 space-y-6">
        {filteredTrackings.map((track) => (
          <TrackingCard 
            key={track.id} 
            data={track} 
            isExpanded={expandedId === track.id}
            onToggle={() => setExpandedId(expandedId === track.id ? null : track.id || null)}
          />
        ))}

        {filteredTrackings.length === 0 && (
          <div className="py-20 text-center space-y-4">
            <div className="w-20 h-20 bg-surface-subtle rounded-[2rem] flex items-center justify-center mx-auto text-text-muted">
              <Navigation size={40} className="opacity-20 translate-y-1" />
            </div>
            <p className="text-sm font-black text-text-muted uppercase tracking-[0.2em]">Aucun flux détecté</p>
          </div>
        )}
      </div>
    </div>
  );
}

const FilterTab = ({ active, icon, label, onClick, badge }: any) => (
  <button 
    onClick={onClick}
    className={cn(
      "flex-1 py-3.5 rounded-[1.5rem] flex flex-col items-center gap-1 transition-all relative",
      active ? "bg-brand text-white shadow-lg" : "text-text-muted hover:bg-surface-subtle"
    )}
  >
    {icon}
    <span className="text-micro font-black uppercase tracking-widest">{label}</span>
    {badge && (
      <span className="absolute top-1.5 right-1.5 bg-red-500 text-white text-micro font-black w-4 h-4 rounded-full flex items-center justify-center border-2 border-white">
        {badge}
      </span>
    )}
  </button>
);

const TrackingCard = ({ data, isExpanded, onToggle }: { data: TrackingData, isExpanded: boolean, onToggle: () => void }) => {
  const statusColor = {
    pending: 'bg-surface-subtle text-text-secondary',
    in_transit: 'bg-orange-50 text-orange-500',
    arrived: 'bg-green-50 text-green-500',
    at_port: 'bg-blue-50 text-blue-500',
    customs_clearance: 'bg-purple-50 text-purple-600',
    discharged: 'bg-teal-50 text-teal-600',
    alert: 'bg-red-50 text-red-500'
  };

  const statusLabel = {
    pending: 'En attente',
    in_transit: 'En transit',
    arrived: 'Arrivé au port',
    at_port: 'Au Port (DEPOTEK)',
    customs_clearance: 'Dédouanement',
    discharged: 'Dépoté',
    alert: '⚠️ Alerte'
  };

  return (
    <div className="bg-white rounded-[2.5rem] border border-border-default shadow-sm overflow-hidden p-6 relative">
      {data.requiresAttention && (
        <div className="absolute top-0 right-0 bg-red-500 text-white px-6 py-1.5 rounded-bl-[1.5rem] text-micro font-black uppercase tracking-widest flex items-center gap-2">
           <AlertTriangle size={12} /> Requiert attention
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div className="bg-brand/5 px-4 py-2 rounded-2xl">
          <span className="text-sm font-black text-brand uppercase tracking-tighter">{data.numeroConteneur}</span>
        </div>
        <div className={cn("px-4 py-2 rounded-2xl flex items-center gap-2", statusColor[data.statut])}>
          <div className={cn("w-1.5 h-1.5 rounded-full", data.statut === 'arrived' ? 'bg-green-500 animate-pulse' : 'bg-current')} />
          <span className="text-label font-black uppercase tracking-widest">{statusLabel[data.statut]}</span>
        </div>
      </div>

      <div className="mb-8 relative px-2">
        <div className="flex justify-between items-end mb-4">
            <div className="text-left">
              <p className="text-micro font-black text-text-muted uppercase tracking-widest mb-1">Chargement</p>
              <p className="text-xs font-black text-slate-800 uppercase tracking-tight">{data.portChargement}</p>
            </div>
            <div className="text-right">
              <p className="text-micro font-black text-text-muted uppercase tracking-widest mb-1">Déchargement</p>
              <p className="text-xs font-black text-slate-800 uppercase tracking-tight">{data.portDechargement}</p>
            </div>
        </div>

        {/* PROGRESS BAR */}
        <div className="h-2 bg-surface-subtle rounded-full relative">
          <motion.div 
            initial={{ width: 0 }}
            animate={{ width: data.statut === 'arrived' || data.statut === 'customs_clearance' || data.statut === 'discharged' ? '100%' : '60%' }}
            className={cn(
              "h-full rounded-full transition-all duration-1000",
              data.statut === 'arrived' ? 'bg-green-500' : 'bg-brand'
            )}
          />
          <div className="absolute top-1/2 left-[60%] -translate-y-1/2 -translate-x-1/2 transition-all duration-1000" style={{ left: data.statut === 'arrived' || data.statut === 'customs_clearance' || data.statut === 'discharged' ? '95%' : '60%' }}>
            <div className="bg-white w-8 h-8 rounded-full border-2 border-border-default shadow-lg flex items-center justify-center text-brand">
              <Ship size={16} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
         <div className="bg-surface-subtle p-4 rounded-[1.5rem]">
            <p className="text-micro font-black text-text-muted uppercase tracking-[0.1em] mb-1">Carrier</p>
            <p className="text-caption font-black text-text-primary uppercase">{data.carrier}</p>
         </div>
         <div className="bg-surface-subtle p-4 rounded-[1.5rem]">
            <p className="text-micro font-black text-text-muted uppercase tracking-[0.1em] mb-1">ETA Estimée</p>
            <p className="text-caption font-black text-brand">
              {data.dateETA instanceof Timestamp ? data.dateETA.toDate().toLocaleDateString('fr-FR') : 'Calendrier DEPOTEK...'}
            </p>
         </div>
      </div>

      <button 
        onClick={onToggle}
        className="w-full py-4 border-t border-dashed border-border-default flex items-center justify-center gap-2 text-label font-black text-text-muted uppercase tracking-[0.3em] hover:text-brand transition-colors"
      >
        Voir Historique <ChevronDown size={14} className={cn("transition-transform", isExpanded && "rotate-180")} />
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
             <div className="pt-8 space-y-8 pl-4 pb-4">
                {data.historiqueMilestones.map((m, i) => (
                  <div key={i} className="flex gap-10 relative">
                    {/* TIMELINE LINE */}
                    {i < data.historiqueMilestones.length - 1 && (
                      <div className="absolute left-6 top-8 bottom-0 w-[2px] bg-surface-subtle" />
                    )}
                    
                    <div className={cn(
                      "w-12 h-12 rounded-2xl flex items-center justify-center relative z-10 transition-all",
                      i === 0 ? "bg-brand text-white shadow-xl scale-110" : "bg-white text-text-muted border border-border-default shadow-sm"
                    )}>
                      {i === 0 && <div className="absolute inset-0 bg-brand/20 rounded-2xl animate-ping" />}
                      <MilestoneIcon type={m.status} />
                    </div>

                    <div className="flex-1">
                      <p className="text-label font-black text-text-muted uppercase tracking-widest mb-1">{m.timestamp}</p>
                      <p className="text-body font-black text-slate-800 uppercase tracking-tight">{m.description}</p>
                      <div className="flex items-center gap-1.5 mt-2">
                        <MapPin size={10} className="text-text-muted" />
                        <span className="text-micro font-bold text-text-muted uppercase tracking-widest">{m.location}</span>
                      </div>
                    </div>
                  </div>
                ))}
             </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const MilestoneIcon = ({ type }: { type: string }) => {
  const t = type.toLowerCase();
  if (t.includes('gate') || t.includes('warehouse')) return <Warehouse size={22} />;
  if (t.includes('loaded')) return <Ship size={22} />;
  if (t.includes('departed')) return <Compass size={22} />;
  if (t.includes('transship')) return <Activity size={22} />;
  if (t.includes('arrived')) return <Anchor size={22} />;
  if (t.includes('discharged')) return <Navigation size={22} />;
  return <Ship size={22} />;
};
