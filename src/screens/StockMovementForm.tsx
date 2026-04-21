
import React, { useState, useEffect, useMemo } from 'react';
import { 
  ChevronLeft, 
  ArrowDownRight, 
  ArrowUpRight, 
  Package, 
  MapPin, 
  Truck, 
  Zap, 
  CheckCircle2, 
  ChevronRight,
  TrendingDown,
  Building2,
  Calendar,
  User,
  History,
  AlertTriangle,
  Users
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, computeStockPayload } from '../lib/utils';
import { db, auth } from '../lib/firebase';
import { 
  collection, 
  query, 
  orderBy, 
  onSnapshot, 
  doc, 
  runTransaction, 
  serverTimestamp, 
  increment,
  collectionGroup,
  where
} from 'firebase/firestore';
import { useToast } from '../context/ToastContext';
import { Depot, StockItem } from '../types';
import { useDepots } from './StockHome';

type MovementType = 'Standard' | 'Transfert' | 'Retour' | 'Ajustement';

export const StockMovementForm = ({ onBack }: { onBack: () => void }) => {
  const [activeTab, setActiveTab] = useState<'ENTREE' | 'SORTIE'>('ENTREE');
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();
  const { data: depots } = useDepots();
  const [allAvailableStock, setAllAvailableStock] = useState<StockItem[]>([]);

  // Form States
  const [entryForm, setEntryForm] = useState({
    stockId: 'NEW', // 'NEW' or existing stock ID
    product: '',
    quantity: '',
    depotId: '',
    unitPrice: '',
    currency: 'XOF',
    type: 'Standard' as MovementType,
    container: '',
    expirationDate: ''
  });

  const [exitForm, setExitForm] = useState({
    depotId: '',
    lotId: '',
    quantity: '',
    customer: '',
    type: 'Standard' as MovementType
  });

  // Fetch all stocks for lookups
  useEffect(() => {
    const q = query(collectionGroup(db, 'stock'), where('status', '==', 'stored'));
    const unsub = onSnapshot(q, (snap) => {
      setAllAvailableStock(snap.docs.map(d => ({ id: d.id, ...d.data() } as StockItem)));
    });
    return () => unsub();
  }, []);

  // Filter stocks based on selected depot in Entry/Exit
  const filteredStocks = useMemo(() => {
    const targetDepotId = activeTab === 'ENTREE' ? entryForm.depotId : exitForm.depotId;
    if (!targetDepotId) return [];
    return allAvailableStock.filter(s => (s.depotId === targetDepotId || s.depot_id === targetDepotId));
  }, [allAvailableStock, entryForm.depotId, exitForm.depotId, activeTab]);

  const selectedLotForExit = useMemo(() => {
    return allAvailableStock.find(s => s.id === exitForm.lotId);
  }, [allAvailableStock, exitForm.lotId]);

  const isExitValid = useMemo(() => {
    if (!exitForm.lotId || !exitForm.quantity || !exitForm.customer) return false;
    const qty = Number(exitForm.quantity);
    if (isNaN(qty) || qty <= 0) return false;
    if (selectedLotForExit && qty > (selectedLotForExit.quantity || 0)) return false;
    return true;
  }, [exitForm, selectedLotForExit]);

  const entryValue = useMemo(() => {
    const q = Number(entryForm.quantity) || 0;
    const p = Number(entryForm.unitPrice) || 0;
    return q * p;
  }, [entryForm.quantity, entryForm.unitPrice]);

  const exitValue = useMemo(() => {
    if (!exitForm.lotId) return 0;
    const selectedLot = filteredStocks.find(s => s.id === exitForm.lotId);
    if (!selectedLot) return 0;
    const q = Number(exitForm.quantity) || 0;
    const p = selectedLot.unitPrice || (selectedLot.cost_basis ? (selectedLot.cost_basis / (selectedLot.quantity || 1)) : 0);
    return q * p;
  }, [exitForm.quantity, exitForm.lotId, filteredStocks]);
  const handleEntrySubmit = async () => {
    const isNew = entryForm.stockId === 'NEW';
    if (!entryForm.depotId || !entryForm.quantity) {
      showToast("Dépôt et quantité requis", "error");
      return;
    }

    if (!entryForm.unitPrice) {
      showToast("Le prix d'achat est obligatoire", "error");
      return;
    }

    if (isNew && !entryForm.product) {
      showToast("Le nom du produit est requis", "error");
      return;
    }

    setLoading(true);
    try {
      const qty = Number(entryForm.quantity);
      const userName = auth.currentUser?.displayName || 'Agent';
      const userId = auth.currentUser?.uid;

      await runTransaction(db, async (transaction) => {
        let stockRef;
        let finalProduct = entryForm.product;
        let finalPrice = Number(entryForm.unitPrice);
        
        if (isNew) {
          stockRef = doc(collection(db, 'depots', entryForm.depotId, 'stock'));
          const payload = computeStockPayload({
            productName: entryForm.product,
            units: qty,
            container: entryForm.container || 'LO-NEW',
            depotId: entryForm.depotId,
            costPrice: finalPrice,
            costCurrency: entryForm.currency,
            expirationDate: entryForm.expirationDate || null,
            status: 'stored'
          });
          transaction.set(stockRef, {
            ...payload,
            id: stockRef.id,
            aging_days: 0,
            fefo_score: 100,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            createdBy: userId
          });
        } else {
          stockRef = doc(db, 'depots', entryForm.depotId, 'stock', entryForm.stockId);
          const stockDoc = await transaction.get(stockRef);
          if (!stockDoc.exists()) throw new Error("Stock introuvable");
          
          const currentData = stockDoc.data() as any;
          finalProduct = currentData.productName || currentData.product;
          
          // Use computeStockPayload to calculate new totals for update too
          const updatedPayload = computeStockPayload({
            ...currentData,
            units: (Number(currentData.units || currentData.quantity || 0) + qty).toString(),
            costPrice: finalPrice // Update price to latest
          });

          transaction.update(stockRef, {
            ...updatedPayload,
            updatedAt: serverTimestamp()
          });
        }

        const valueDelta = qty * finalPrice;

        // Update Depot Load
        transaction.update(doc(db, 'depots', entryForm.depotId), {
          current_load: increment(qty),
          updatedAt: serverTimestamp()
        });

        // Global Stats
        transaction.set(doc(db, 'stats', 'global'), {
          valeurStock: increment(valueDelta),
          totalCartons: increment(qty),
          lastUpdated: serverTimestamp()
        }, { merge: true });

        // Log
        transaction.set(doc(collection(db, 'logs')), {
          type: `ENTREE_${entryForm.type.toUpperCase()}`,
          message: `${entryForm.type} : ${finalProduct} (+${qty} CTN) ajouté par ${userName} dans ${depots.find(d => d.id === entryForm.depotId)?.name}`,
          userId,
          timestamp: serverTimestamp(),
          quantity: qty,
          details: { ...entryForm, value: valueDelta }
        });
      });

      showToast("Transaction validée sur DEPOTEK", "success");
      onBack();
    } catch (err) {
      console.error(err);
      showToast("Erreur transactionnelle", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleExitSubmit = async () => {
    if (!isExitValid || !selectedLotForExit) return;

    setLoading(true);
    try {
      const qty = Number(exitForm.quantity);
      const userName = auth.currentUser?.displayName || 'Agent';
      const userId = auth.currentUser?.uid;
      const dId = exitForm.depotId;

      await runTransaction(db, async (transaction) => {
        const stockRef = doc(db, 'depots', dId, 'stock', exitForm.lotId);
        const unitVal = selectedLotForExit.unitPrice || (selectedLotForExit.cost_basis / selectedLotForExit.quantity);
        const valDelta = qty * unitVal;

        transaction.update(stockRef, {
          quantity: increment(-qty),
          cartons: increment(-qty),
          cost_basis: increment(-valDelta),
          updatedAt: serverTimestamp()
        });

        transaction.update(doc(db, 'depots', dId), {
          current_load: increment(-qty),
          updatedAt: serverTimestamp()
        });

        transaction.set(doc(db, 'stats', 'global'), {
          valeurStock: increment(-valDelta),
          totalCartons: increment(-qty),
          lastUpdated: serverTimestamp()
        }, { merge: true });

        transaction.set(doc(collection(db, 'logs')), {
          type: `SORTIE_${exitForm.type.toUpperCase()}`,
          message: `${exitForm.type} : Sortie de ${selectedLotForExit.product} (-${qty} CTN) pour ${exitForm.customer} validée par ${userName}`,
          userId,
          timestamp: serverTimestamp(),
          quantity: qty,
          details: { ...exitForm, valueDeducted: valDelta }
        });
      });

      showToast("Stock déduit et logs archivés", "success");
      onBack();
    } catch (err) {
      console.error(err);
      showToast("Échec de la transaction de sortie", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen bg-[#F8FAFC] max-w-[480px] mx-auto relative flex flex-col font-sans overflow-hidden">
      {/* HEADER PREMIUM */}
      <header className="bg-ocean-dark p-6 rounded-b-[40px] shadow-xl relative overflow-hidden sticky top-0 z-50">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl p-6" />
        <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-4">
            <button onClick={onBack} className="p-2 bg-white/10 rounded-xl text-white backdrop-blur-md">
              <ChevronLeft size={24} />
            </button>
            <h1 className="text-xl font-black text-white uppercase tracking-tighter">Gestion Inventaire</h1>
          </div>
          <div className="w-10 h-10 bg-ocean-soft rounded-2xl flex items-center justify-center text-ocean-primary shadow-xl">
             <History size={20} />
          </div>
        </div>

        {/* TAB SELECTOR */}
        <div className="mt-8 flex bg-white/5 p-1.5 rounded-[2rem] border border-white/10 relative z-10">
           <button 
             onClick={() => setActiveTab('ENTREE')}
             className={cn(
               "flex-1 py-4 rounded-[1.8rem] text-xs font-black uppercase tracking-widest transition-all",
               activeTab === 'ENTREE' ? "bg-white text-ocean-dark shadow-xl" : "text-white/40"
             )}
           >
              Entrée / Ajout
           </button>
           <button 
             onClick={() => setActiveTab('SORTIE')}
             className={cn(
               "flex-1 py-4 rounded-[1.8rem] text-xs font-black uppercase tracking-widest transition-all",
               activeTab === 'SORTIE' ? "bg-white text-ocean-dark shadow-xl" : "text-white/40"
             )}
           >
              Sortie / Bon
           </button>
        </div>
      </header>

      <main className="flex-1 p-6 space-y-6 overflow-y-auto no-scrollbar pb-32">
        {activeTab === 'ENTREE' ? (
          <motion.div 
            initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}
            className="space-y-6"
          >
             <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100 space-y-5">
                <div className="space-y-2">
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">CHOISIR DÉPÔT *</label>
                  <select 
                    value={entryForm.depotId} 
                    onChange={e => setEntryForm(p => ({ ...p, depotId: e.target.value, stockId: 'NEW' }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-5 text-[15px] font-black text-slate-900 outline-none focus:ring-4 focus:ring-ocean-primary/5 shadow-sm"
                  >
                    <option value="">Sélectionner un dépôt...</option>
                    {depots.map(d => (
                      <option key={d.id} value={d.id}>{d.name} ({d.current_load} CTN)</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">CHOISIR STOCK *</label>
                  <select 
                    disabled={!entryForm.depotId}
                    value={entryForm.stockId} 
                    onChange={e => setEntryForm(p => ({ ...p, stockId: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-5 text-[15px] font-black text-slate-900 outline-none disabled:opacity-50 shadow-sm"
                  >
                    <option value="NEW">+ NOUVEAU PRODUIT</option>
                    {filteredStocks.map(s => (
                      <option key={s.id} value={s.id}>{s.product} (Lot: {s.id.slice(-4)})</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <InputGroup 
                    label="Prix Unitaire *" 
                    icon={<TrendingDown size={14} />} 
                    value={entryForm.unitPrice} 
                    inputMode="decimal"
                    onChange={v => setEntryForm(p => ({ ...p, unitPrice: v }))} 
                    type="number"
                    placeholder="Montant"
                  />
                  <div className="space-y-2">
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Devise</label>
                    <select 
                      value={entryForm.currency} 
                      onChange={e => setEntryForm(p => ({ ...p, currency: e.target.value }))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-5 text-[15px] font-black text-slate-900 outline-none shadow-sm"
                    >
                      <option value="XOF">FCFA (XOF)</option>
                      <option value="EUR">EURO (EUR)</option>
                      <option value="USD">DOLLAR (USD)</option>
                    </select>
                  </div>
                </div>

                <AnimatePresence mode="wait">
                  {entryForm.stockId === 'NEW' && (
                    <motion.div 
                      key="new-stock-fields"
                      initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                      className="space-y-4 overflow-hidden"
                    >
                       <InputGroup 
                        label="Nom du Produit *" 
                        icon={<Package size={14} />} 
                        value={entryForm.product} 
                        onChange={v => setEntryForm(p => ({ ...p, product: v }))} 
                        placeholder="Ex: Buffalo Meat Grade A"
                      />
                      <InputGroup 
                        label="Échéance (Optionnel)" 
                        icon={<Calendar size={14} />} 
                        value={entryForm.expirationDate} 
                        onChange={v => setEntryForm(p => ({ ...p, expirationDate: v }))} 
                        type="date"
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
                
                <div className="grid grid-cols-2 gap-4">
                   <InputGroup 
                    label="Quantité (CTN) *" 
                    icon={<Zap size={14} />} 
                    value={entryForm.quantity} 
                    inputMode="numeric"
                    onChange={v => setEntryForm(p => ({ ...p, quantity: v }))} 
                    type="number"
                    placeholder="0"
                  />
                   <div className="space-y-2">
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Motif</label>
                    <select 
                      value={entryForm.type} 
                      onChange={e => setEntryForm(p => ({ ...p, type: e.target.value as any }))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-5 text-[15px] font-black text-slate-900 outline-none shadow-sm"
                    >
                      {['Standard', 'Transfert', 'Retour', 'Ajustement'].map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <InputGroup 
                  label="Conteneur / Référence" 
                  icon={<Truck size={14} />} 
                  value={entryForm.container} 
                  autoCapitalize="characters"
                  onChange={v => setEntryForm(p => ({ ...p, container: v.toUpperCase() }))} 
                  placeholder="MSC-..."
                />

                {/* Real-time Value Preview */}
                {(Number(entryForm.quantity) > 0 && Number(entryForm.unitPrice) > 0) && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="bg-ocean-soft/30 rounded-2xl p-4 border border-ocean-soft flex items-center justify-between"
                  >
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black text-ocean-primary uppercase tracking-widest mb-1">Valeur de l'opération</span>
                      <span className="text-sm font-black text-ocean-dark">
                        {entryValue.toLocaleString()} <span className="text-[10px] opacity-40">{entryForm.currency}</span>
                      </span>
                    </div>
                    <div className="text-right">
                      <div className="flex items-center gap-1 text-[10px] font-bold text-slate-400 capitalize">
                        <span>{entryForm.quantity} CTN</span>
                        <span className="opacity-30">@</span>
                        <span>{entryForm.unitPrice}</span>
                      </div>
                    </div>
                  </motion.div>
                )}
             </div>

             <button 
               onClick={handleEntrySubmit}
               disabled={loading}
               className="w-full py-7 bg-ocean-primary text-white rounded-[2.5rem] font-black uppercase text-xs tracking-widest shadow-2xl shadow-ocean-primary/30 flex items-center justify-center gap-3 transition-all active:scale-95"
             >
                {loading ? <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ArrowDownRight size={24} />}
                Valider Entrée DEPOTEK
             </button>
          </motion.div>
        ) : (
          <motion.div 
            initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
            className="space-y-6"
          >
             <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100 space-y-6">
                <div className="space-y-2">
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">CHOISIR DÉPÔT *</label>
                  <select 
                    value={exitForm.depotId} 
                    onChange={e => setExitForm(p => ({ ...p, depotId: e.target.value, lotId: '' }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-5 text-[15px] font-black text-slate-900 outline-none shadow-sm"
                  >
                    <option value="">Sélectionner un dépôt...</option>
                    {depots.map(d => (
                      <option key={d.id} value={d.id}>{d.name} ({d.current_load} CTN)</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">SÉLECTIONNER LOT *</label>
                  <select 
                    disabled={!exitForm.depotId}
                    value={exitForm.lotId} 
                    onChange={e => setExitForm(p => ({ ...p, lotId: e.target.value }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-5 text-[15px] font-black text-slate-900 outline-none disabled:opacity-50 shadow-sm"
                  >
                    <option value="">Choisir un produit en rayon...</option>
                    {filteredStocks.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.product} - Dispo: {s.quantity} CTN
                      </option>
                    ))}
                  </select>
                </div>

                <InputGroup 
                  label="Client / Destinataire *" 
                  icon={<Users size={14} />} 
                  value={exitForm.customer} 
                  onChange={v => setExitForm(p => ({ ...p, customer: v }))} 
                  placeholder="Ex: Client Dakar"
                />

                <div className="grid grid-cols-2 gap-4">
                  <InputGroup 
                    label="Qté à sortir *" 
                    icon={<Zap size={14} />} 
                    value={exitForm.quantity} 
                    inputMode="numeric"
                    onChange={v => setExitForm(p => ({ ...p, quantity: v }))} 
                    type="number"
                    placeholder="0"
                  />
                  <div className="space-y-2">
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">Motif</label>
                    <select 
                      value={exitForm.type} 
                      onChange={e => setExitForm(p => ({ ...p, type: e.target.value as any }))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-5 text-[15px] font-black text-slate-900 outline-none shadow-sm"
                    >
                       {['Standard', 'Transfert', 'Retour', 'Ajustement'].map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Stock Warning UI */}
                {selectedLotForExit && Number(exitForm.quantity) > (selectedLotForExit.quantity || 0) && (
                  <div className="p-4 bg-red-50 rounded-2xl border border-red-100 flex items-center gap-3 text-red-600">
                    <AlertTriangle size={18} />
                    <span className="text-[10px] font-black uppercase">Stock Insuffisant (Max: {selectedLotForExit.quantity})</span>
                  </div>
                )}
             </div>

            {/* Real-time Value Preview (Exit) */}
            {(Number(exitForm.quantity) > 0 && exitValue > 0) && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-red-50/50 rounded-2xl p-5 border border-red-100 flex items-center justify-between mt-2"
              >
                <div className="flex flex-col">
                  <span className="text-[10px] font-black text-red-500 uppercase tracking-widest mb-1">Impact Financier</span>
                  <span className="text-sm font-black text-red-700">
                    - {exitValue.toLocaleString()} <span className="text-[10px] opacity-40">XOF</span>
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-1">Lot: {exitForm.lotId?.slice(-4)}</span>
                  <div className="text-[10px] font-bold text-slate-400 italic">
                    Déduction auto
                  </div>
                </div>
              </motion.div>
            )}

             <button 
                onClick={handleExitSubmit}
                disabled={loading || !isExitValid}
                className={cn(
                  "w-full py-7 rounded-[2.5rem] font-black uppercase text-xs tracking-widest shadow-2xl flex items-center justify-center gap-3 transition-all active:scale-95",
                  isExitValid ? "bg-orange-500 text-white shadow-orange-500/30" : "bg-slate-100 text-slate-300 cursor-not-allowed"
                )}
             >
                {loading ? <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <TrendingDown size={24} />}
                Émettre Bon de Sortie
             </button>
          </motion.div>
        )}

        <div className="p-6 bg-slate-900 rounded-[32px] shadow-2xl text-white relative overflow-hidden mt-8">
           <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16 blur-xl" />
           <div className="relative z-10 flex items-center gap-4">
              <div className="w-14 h-14 bg-white/10 rounded-2xl flex items-center justify-center border border-white/10 shadow-inner">
                 <User size={24} className="text-white/60" />
              </div>
              <div>
                 <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.3em] block mb-0.5">Agent Certifié</span>
                 <p className="text-base font-black tracking-tight">{auth.currentUser?.displayName || 'Agent DEPOTEK'}</p>
                 <p className="text-[11px] font-bold text-ocean-primary uppercase tracking-widest">Opérateur DEPOTEK Hub 1</p>
              </div>
           </div>
        </div>
      </main>
    </div>
  );
};

const InputGroup = ({ label, icon, value, onChange, placeholder, type = "text", inputMode, autoCapitalize }: any) => (
    <div className="space-y-2 flex-1">
       <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest ml-1">{label}</label>
       <div className="relative">
          <div className="absolute left-5 top-1/2 -translate-y-1/2 text-ocean-primary opacity-50">
             {icon}
          </div>
          <input 
             type={type}
             value={value}
             inputMode={inputMode}
             autoCapitalize={autoCapitalize}
             onChange={(e) => onChange(e.target.value)}
             placeholder={placeholder}
             className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-5 pl-14 text-[15px] font-black text-slate-900 outline-none focus:ring-4 focus:ring-ocean-primary/5 transition-all placeholder:text-slate-300 shadow-sm"
          />
       </div>
    </div>
);
