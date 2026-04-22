
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Building2, 
  MoreVertical, 
  Plus, 
  Edit2, 
  Copy, 
  Trash2, 
  ChevronLeft,
  Search,
  MapPin,
  Box,
  AlertCircle,
  Scan,
  FileText,
  Navigation,
  Ship,
  Bell,
  PieChart as PieIcon
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useDepots } from './StockHome';
import { depotService } from '../services/depotService';
import { Depot } from '../types';
import { useToast } from '../context/ToastContext';

export const DepotManager = ({ onBack, onNavigate }: { onBack: () => void, onNavigate: (screen: string) => void }) => {
  const { data: depots, loading } = useDepots();
  const { showToast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDepot, setEditingDepot] = useState<Depot | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState<string | null>(null);
  const [deleteInput, setDeleteInput] = useState('');

  const filteredDepots = depots.filter(d => 
    d.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    d.code?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleDelete = async (id: string) => {
    const depot = depots.find(d => d.id === id);
    if (depot && (depot.current_load || 0) > 0) {
      showToast("Impossible de supprimer : ce dépôt contient encore du stock.", "error");
      setIsDeleteConfirmOpen(null);
      return;
    }

    if (deleteInput !== 'SUPPRIMER') return;
    try {
      await depotService.delete(id);
      showToast("Dépôt supprimé avec succès", 'error');
      setIsDeleteConfirmOpen(null);
      setDeleteInput('');
    } catch (err) {
      showToast("Erreur lors de la suppression", 'error');
    }
  };

  const handleDuplicate = async (id: string) => {
    try {
      await depotService.duplicate(id);
      showToast("Dépôt dupliqué");
    } catch (err) {
      showToast("Erreur lors de la duplication", 'error');
    }
  };

  return (
    <div className="h-screen bg-surface-page flex flex-col max-w-[480px] mx-auto relative overflow-hidden font-sans">
      <header className="bg-brand-dark p-6 rounded-b-[32px] shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl text-white" />
        <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="p-2 bg-white/10 rounded-xl text-white transition-all active:scale-95">
              <ChevronLeft size={20} />
            </button>
            <div>
              <h1 className="text-xl font-black text-white tracking-tight uppercase leading-none">DÉPÔTS</h1>
              <p className="text-micro font-black text-white/50 uppercase tracking-widest mt-1">DEPOTEK HUB</p>
            </div>
          </div>
          <button 
            onClick={() => { setEditingDepot(null); setIsModalOpen(true); }}
            className="w-10 h-10 bg-white text-brand rounded-xl flex items-center justify-center shadow-lg active:scale-90 transition-all"
          >
            <Plus size={20} />
          </button>
        </div>
      </header>

      <div className="p-5 space-y-4 flex-1 overflow-y-auto pb-40">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
          <input 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Rechercher dépôt..."
            className="w-full bg-white/50 backdrop-blur-sm border border-white rounded-xl p-3.5 pl-11 text-xs font-black outline-none focus:ring-4 focus:ring-brand/5 shadow-sm transition-all placeholder:text-text-muted"
          />
        </div>

        <div className="space-y-3">
          {loading ? (
            <div className="py-20 flex justify-center text-gray-200">
               <div className="w-8 h-8 border-4 border-border-default border-t-ocean-primary rounded-full animate-spin" />
            </div>
          ) : filteredDepots.length === 0 ? (
            <div className="py-20 text-center opacity-20">
              <Building2 size={64} className="mx-auto mb-4" />
              <p className="text-xs font-black uppercase tracking-widest text-brand-ink">Aucun dépôt trouvé</p>
            </div>
          ) : (
            filteredDepots.map(depot => (
              <DepotItem 
                key={depot.id} 
                depot={depot} 
                onEdit={() => { setEditingDepot(depot); setIsModalOpen(true); }}
                onDelete={() => setIsDeleteConfirmOpen(depot.id)}
                onDuplicate={() => handleDuplicate(depot.id)}
              />
            ))
          )}
        </div>
      </div>

      <DepotModal 
        isOpen={isModalOpen} 
        onClose={() => { setIsModalOpen(false); setEditingDepot(null); }}
        editingDepot={editingDepot}
      />

      <AnimatePresence>
        {isDeleteConfirmOpen && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsDeleteConfirmOpen(null)} className="fixed inset-0 bg-brand-ink/80 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="w-full max-w-[340px] bg-white rounded-[32px] p-8 z-[310] shadow-2xl space-y-6">
              <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto">
                <AlertCircle size={32} />
              </div>
              <div className="text-center">
                <h3 className="text-lg font-black text-brand-ink tracking-tight">Supprimer le dépôt ?</h3>
                <p className="text-xs text-red-400 font-bold bg-red-50 p-3 rounded-xl mt-3">ZONE DE DANGER : Cette action est irréversible.</p>
                <p className="text-xs text-text-muted mt-4 italic">Tapez <span className="font-black text-red-500">SUPPRIMER</span> pour confirmer.</p>
              </div>
              <input 
                value={deleteInput}
                onChange={e => setDeleteInput(e.target.value.toUpperCase())}
                placeholder="SUPPRIMER"
                className="w-full bg-surface-subtle border border-red-100 rounded-2xl p-4 text-center font-black outline-none focus:border-red-500 uppercase"
              />
              <div className="flex gap-4">
                <button onClick={() => setIsDeleteConfirmOpen(null)} className="flex-1 py-4 text-text-muted font-black uppercase text-label">Annuler</button>
                <button 
                  onClick={() => handleDelete(isDeleteConfirmOpen)}
                  disabled={deleteInput !== 'SUPPRIMER'}
                  className={cn(
                    "flex-1 py-4 rounded-2xl font-black uppercase text-label transition-all",
                    deleteInput === 'SUPPRIMER' ? "bg-red-500 text-white shadow-lg shadow-red-500/20" : "bg-surface-page text-text-muted"
                  )}
                >
                  Supprimer
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const DepotItem = ({ depot, onEdit, onDelete, onDuplicate }: any) => {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="bg-white/70 backdrop-blur-xl p-3.5 rounded-[20px] border border-white/50 shadow-lg shadow-black/5 flex items-center justify-between group active:scale-[0.98] transition-all relative">
      <div className="flex items-center gap-3 flex-1">
        <div 
          className="w-9 h-9 rounded-xl flex items-center justify-center text-white shadow-lg"
          style={{ backgroundColor: depot.color }}
        >
          <Building2 size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-caption font-black text-brand-ink uppercase tracking-tight truncate">{depot.name}</h4>
            <span className="px-1.5 py-0.5 bg-white/50 text-text-muted text-micro font-black rounded-md border border-border-default uppercase tracking-widest whitespace-nowrap">{depot.code || 'NA'}</span>
          </div>
          <div className="flex items-center gap-2.5 mt-0.5 opacity-60">
            <span className="text-micro font-black text-text-muted uppercase flex items-center gap-0.5"><MapPin size={7} /> CENTRE DEPOTEK</span>
            <span className="text-micro font-black text-text-muted uppercase flex items-center gap-0.5"><Box size={7} /> {depot.capacity_cartons} CTN</span>
          </div>
          <p className={cn(
            "text-micro font-black uppercase tracking-widest mt-2 px-2 py-0.5 rounded-full w-fit",
            depot.type === 'frozen' ? "bg-blue-500/10 text-blue-500" : depot.type === 'cold' ? "bg-cyan-500/10 text-cyan-500" : "bg-orange-500/10 text-orange-500"
          )}>
            {depot.type === 'frozen' ? '❄️ CONGELÉ' : depot.type === 'cold' ? '❄️ FROID' : '☀️ SEC'}
          </p>
        </div>
      </div>

      <div className="relative flex items-center gap-1.5">
        {(depot.current_load || 0) === 0 && (
          <button 
            onClick={() => onDelete()}
            className="w-8 h-8 flex items-center justify-center bg-red-50 text-red-400 rounded-lg hover:bg-red-500 hover:text-white transition-all active:scale-90"
            title="Supprimer Dépôt Vide"
          >
            <Trash2 size={14} />
          </button>
        )}
        <button 
          onClick={() => setShowMenu(!showMenu)}
          className="w-8 h-8 flex items-center justify-center bg-gray-50/50 rounded-lg text-text-muted hover:text-brand transition-all active:scale-90"
        >
          <MoreVertical size={14} />
        </button>

        <AnimatePresence>
          {showMenu && (
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setShowMenu(false)} />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 10 }}
                className="absolute right-0 top-14 w-44 bg-white rounded-2xl shadow-2xl border border-border-default p-2 z-[70] flex flex-col gap-1 overflow-hidden"
              >
                <MenuAction icon={<Edit2 size={14} />} label="Modifier" onClick={() => { onEdit(); setShowMenu(false); }} />
                <MenuAction icon={<Copy size={14} />} label="Dupliquer" onClick={() => { onDuplicate(); setShowMenu(false); }} />
                <div className="h-px bg-surface-subtle mx-2 my-1" />
                <MenuAction icon={<Trash2 size={14} />} label="Supprimer" danger onClick={() => { onDelete(); setShowMenu(false); }} />
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

const MenuAction = ({ icon, label, onClick, danger }: any) => (
  <button 
    onClick={onClick}
    className={cn(
      "flex items-center gap-3 w-full p-3 rounded-xl text-label font-black uppercase tracking-widest transition-colors",
      danger ? "text-red-500 hover:bg-red-50" : "text-brand-ink hover:bg-surface-subtle"
    )}
  >
    {icon} {label}
  </button>
);

const DepotModal = ({ isOpen, onClose, editingDepot }: { isOpen: boolean, onClose: () => void, editingDepot: Depot | null }) => {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState<'frozen' | 'cold' | 'dry'>('frozen');
  const [capacity, setCapacity] = useState('5000');
  const [color, setColor] = useState('#0066FF');

  const colors = ['#0066FF', '#10B981', '#FF6B6B', '#FFB800', '#7C3AED', '#EC4899'];

  React.useEffect(() => {
    if (editingDepot) {
      setName(editingDepot.name);
      setCode(editingDepot.code || '');
      setType(editingDepot.type || 'frozen');
      setCapacity(String(editingDepot.capacity_cartons));
      setColor(editingDepot.color);
    } else {
      setName('');
      setCode('');
      setType('frozen');
      setCapacity('5000');
      setColor('#0066FF');
    }
  }, [editingDepot, isOpen]);

  const handleSubmit = async () => {
    if (!name || !code) {
      showToast("Veuillez remplir le nom et le code", "error");
      return;
    }
    const payload: any = {
      name,
      code: code.toUpperCase(),
      type,
      capacity_cartons: parseInt(capacity),
      color,
      location: { lat: 14.7167, lng: -17.4677 }
    };

    try {
      if (editingDepot) {
        await depotService.update(editingDepot.id, payload);
      } else {
        await depotService.create(payload);
      }
      showToast("Données sauvegardées avec succès !");
      onClose();
    } catch (err: any) {
      console.error(err);
      if (err.message?.includes('offline') || err.message?.includes('network')) {
        showToast("Erreur de connexion : Sync différée", "warning");
        onClose();
      } else {
        showToast("Erreur lors de l'enregistrement", 'error');
      }
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[200] flex items-end justify-center">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 bg-brand-ink/60 backdrop-blur-sm" />
          <motion.div 
            initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
            className="w-full max-w-[480px] bg-white rounded-t-[40px] p-8 z-[210] shadow-2xl flex flex-col gap-6 max-h-[90vh] overflow-y-auto no-scrollbar"
          >
            <div className="w-12 h-1.5 bg-surface-page rounded-full mx-auto" />
            <h3 className="text-xl font-black text-brand-ink tracking-tight">{editingDepot ? 'Modifier le Dépôt' : 'Nouveau Dépôt'}</h3>
            
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-label font-black uppercase text-text-muted tracking-widest px-2">Nom</label>
                  <input value={name} onChange={e => setName(e.target.value)} placeholder="Almadi 3" className="w-full bg-surface-subtle border border-border-default rounded-2xl p-4 text-sm font-black outline-none focus:ring-4 focus:ring-blue-500/10" />
                </div>
                <div className="space-y-1">
                  <label className="text-label font-black uppercase text-text-muted tracking-widest px-2">Code</label>
                  <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="DKR-A3" className="w-full bg-surface-subtle border border-border-default rounded-2xl p-4 text-sm font-black outline-none" />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-label font-black uppercase text-text-muted tracking-widest px-2">Type de Stockage</label>
                <div className="grid grid-cols-3 gap-2">
                  {['frozen', 'cold', 'dry'].map((t: any) => (
            <button 
              key={t}
              onClick={() => setType(t)}
              className={cn(
                "py-3 rounded-xl text-micro font-black uppercase tracking-widest transition-all",
                type === t ? "bg-brand-dark text-white shadow-lg" : "bg-surface-subtle text-text-muted"
              )}
            >
              {t === 'frozen' ? 'Congelé' : t === 'cold' ? 'Froid' : 'Sec'}
            </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-label font-black uppercase text-text-muted tracking-widest px-2">Capacité Max (CTN)</label>
                <input type="number" value={capacity} onChange={e => setCapacity(e.target.value)} className="w-full bg-surface-subtle border border-border-default rounded-2xl p-4 text-sm font-black outline-none" />
              </div>

              <div className="space-y-1">
                <label className="text-label font-black uppercase text-text-muted tracking-widest px-2">Couleur Accent</label>
                <div className="flex gap-2.5 px-1 py-2 overflow-x-auto no-scrollbar">
                  {colors.map(c => (
                    <button 
                      key={c}
                      onClick={() => setColor(c)}
                      className={cn(
                        "w-9 h-9 flex-none rounded-full border-4 transition-all",
                        color === c ? "border-[#0A2540] scale-110" : "border-transparent"
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <button onClick={handleSubmit} className="w-full py-5 bg-brand text-white rounded-2xl font-black uppercase tracking-widest text-xs shadow-xl shadow-brand/20 active:scale-95 transition-all mt-4">
              {editingDepot ? 'Mettre à jour' : 'Créer le Dépôt'}
            </button>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
