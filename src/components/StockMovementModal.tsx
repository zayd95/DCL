
import React, { useState, useMemo } from 'react';
import { 
  X, 
  ArrowDownRight, 
  ArrowUpRight, 
  ArrowRightLeft, 
  Settings2,
  Package,
  MapPin,
  Zap,
  Truck,
  Users,
  Calendar,
  AlertTriangle,
  ChevronRight,
  TrendingDown,
  Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { applyMovement, applyTransfer } from '../lib/stockService';
import { db, auth } from '../lib/firebase';
import {
  doc,
  runTransaction,
  serverTimestamp,
  increment,
  collection,
  query,
  where,
  getDocs,
  DocumentReference,
} from 'firebase/firestore';
import { useToast } from '../context/ToastContext';
import { StockItem, Depot, StockMovement } from '../types';

type MoveMode = 'entry' | 'exit' | 'transfer' | 'adjustment';

interface StockMovementModalProps {
  stock: StockItem;
  depots: Depot[];
  onClose: () => void;
  onSuccess?: () => void;
  docRef?: DocumentReference | null;
}

export const StockMovementModal = ({ stock, depots, onClose, onSuccess, docRef }: StockMovementModalProps) => {
  const { showToast } = useToast();
  const [mode, setMode] = useState<MoveMode>('exit');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('Vente');
  const [targetDepotId, setTargetDepotId] = useState('');
  const [client, setClient] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);

  const currentDepot = useMemo(() => {
    return depots.find(d => d.id === stock.depotId);
  }, [depots, stock]);

  const availableDepots = useMemo(() => {
    return depots.filter(d => d.id !== stock.depotId);
  }, [depots, stock]);

  const isValid = useMemo(() => {
    const qty = parseInt(quantity);
    if (isNaN(qty) || qty <= 0) return false;
    if ((mode === 'exit' || mode === 'transfer') && qty > stock.quantity) return false;
    if (mode === 'transfer' && !targetDepotId) return false;
    if (mode === 'exit' && !client) return false;
    return true;
  }, [mode, quantity, targetDepotId, client, stock]);

  const handleAction = async () => {
    if (!isValid) return;
    setLoading(true);

    try {
      const amount     = parseInt(quantity);
      const sourceDepotId = stock.depotId;
      const userName   = auth.currentUser?.displayName || 'Agent DEPOTEK';
      const userId     = auth.currentUser?.uid || 'anon';

      // costPrice per unit; fall back to proportional calculation from costBasis
      const unitValue = stock.costPrice ?? (stock.quantity > 0 ? stock.costBasis / stock.quantity : 0);
      const valDelta  = amount * unitValue;

      await runTransaction(db, async (transaction) => {
        const sourceStockRef = docRef || doc(db, 'depots', sourceDepotId, 'stock', stock.id);
        const sourceDepotRef = doc(db, 'depots', sourceDepotId);
        const statsRef       = doc(db, 'stats', 'global');

        // 1. NON-TRANSFER: applyMovement handles source directly
        // 2. TRANSFER: applyTransfer owns both legs — never call raw applyMovement for transfers
        if (mode === 'transfer') {
          const destDepotRef  = doc(db, 'depots', targetDepotId);
          const destStockSnap = await getDocs(query(
            collection(db, 'depots', targetDepotId, 'stock'),
            where('sku', '==', stock.sku || 'N/A'),
          ));
          const transferWeight = stock.totalWeightKg > 0
            ? (stock.totalWeightKg / stock.quantity) * amount
            : 0;
          const destStockRef = destStockSnap.empty
            ? doc(collection(db, 'depots', targetDepotId, 'stock'))
            : destStockSnap.docs[0].ref;

          await applyTransfer(
            transaction,
            sourceStockRef, sourceDepotRef,
            destStockRef,   destDepotRef,
            {
              amount,
              costDelta:        valDelta,
              userId,
              userName,
              currentDepotName: currentDepot?.name,
              notes:            notes || undefined,
              isNewLot:         destStockSnap.empty,
              destCreatePayload: destStockSnap.empty ? {
                sku:            stock.sku,
                productName:    stock.productName,
                category:       stock.category,
                supplier:       stock.supplier,
                container:      stock.container,
                lotNumber:      stock.lotNumber,
                depotId:        targetDepotId,
                stockType:      stock.stockType,
                unitType:       stock.unitType,
                unitWeight:     stock.unitWeight,
                totalWeightKg:  transferWeight,
                costPrice:      stock.costPrice,
                costPer:        stock.costPer,
                costCurrency:   stock.costCurrency,
                arrivalDate:    stock.arrivalDate,
                agingDays:      stock.agingDays,
                fefoScore:      stock.fefoScore,
                expirationDate: stock.expirationDate,
                productionDate: stock.productionDate,
                status:         'in_transit',
                threshold:      stock.threshold,
                sourceDoc:      stock.sourceDoc,
                transferRef:    stock.transferRef,
              } : undefined,
            },
          );
        } else {
          const isDebit  = mode === 'exit';
          const qtyDelta = isDebit ? -amount : amount;
          const costDelta = isDebit ? -valDelta : valDelta;

          await applyMovement(transaction, sourceStockRef, sourceDepotRef, {
            type:          mode,
            quantityDelta: qtyDelta,
            costDelta,
            reason,
            client:        mode === 'exit' ? client : undefined,
            notes:         notes || undefined,
            userId,
            userName,
          });
        }

        // 3. GLOBAL STATS — transfers don't change totals (only location)
        if (mode === 'exit') {
          transaction.set(statsRef, {
            valeurStock:  increment(-valDelta),
            totalCartons: increment(-amount),
            lastUpdated:  serverTimestamp(),
          }, { merge: true });
        } else if (mode === 'entry' || mode === 'adjustment') {
          transaction.set(statsRef, {
            valeurStock:  increment(valDelta),
            totalCartons: increment(amount),
            lastUpdated:  serverTimestamp(),
          }, { merge: true });
        }
      });

      showToast(`Mouvement ${mode.toUpperCase()} validé sur DEPOTEK`);
      onSuccess?.();
      onClose();
    } catch (err: any) {
      console.error(err);
      showToast("Erreur lors de la transaction logistique", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* MODE TABS */}
      <div className="flex bg-surface-subtle p-1 rounded-2xl border border-border-default">
        <ModeTab active={mode === 'entry'} label="Entrée" icon={<ArrowDownRight size={14} />} onClick={() => setMode('entry')} color="bg-green-500" />
        <ModeTab active={mode === 'exit'} label="Sortie" icon={<ArrowUpRight size={14} />} onClick={() => setMode('exit')} color="bg-red-500" />
        <ModeTab active={mode === 'transfer'} label="Transfert" icon={<ArrowRightLeft size={14} />} onClick={() => setMode('transfer')} color="bg-blue-500" />
        <ModeTab active={mode === 'adjustment'} label="Ajust." icon={<Settings2 size={14} />} onClick={() => setMode('adjustment')} color="bg-amber-500" />
      </div>

      <div className="space-y-4">
        {/* QUANTITY */}
        <div className="space-y-2">
          <label className="text-label font-black uppercase text-text-muted tracking-widest px-1">Quantité (Cartons)</label>
          <div className="relative">
            <Zap size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
            <input 
              type="number"
              value={quantity}
              placeholder="0"
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full bg-surface-subtle border border-transparent rounded-2xl p-4 pl-12 text-lg font-black text-text-primary outline-none focus:bg-white focus:border-border-focus/20 transition-all"
            />
            {mode !== 'entry' && (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-label font-black text-text-muted uppercase">
                Dispo: {stock.quantity}
              </span>
            )}
          </div>
        </div>

        {/* TRANSFER TARGET */}
        <AnimatePresence>
          {mode === 'transfer' && (
            <motion.div 
               initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
               className="space-y-2 overflow-hidden"
            >
              <label className="text-label font-black uppercase text-text-muted tracking-widest px-1">Dépôt Destination</label>
              <div className="relative">
                <MapPin size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
                <select 
                  value={targetDepotId}
                  onChange={(e) => setTargetDepotId(e.target.value)}
                  className="w-full bg-surface-subtle border border-transparent rounded-2xl p-4 pl-12 text-sm font-black text-text-primary outline-none appearance-none focus:bg-white"
                >
                  <option value="">Sélectionner Dépôt...</option>
                  {availableDepots.map(d => (
                    <option key={d.id} value={d.id}>{d.name} ({d.type})</option>
                  ))}
                </select>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* CUSTOMER (EXIT) */}
        <AnimatePresence>
          {mode === 'exit' && (
            <motion.div 
               initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
               className="space-y-2 overflow-hidden"
            >
              <label className="text-label font-black uppercase text-text-muted tracking-widest px-1">Importateur / Client</label>
              <div className="relative">
                <Users size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
                <input 
                  type="text"
                  value={client}
                  placeholder="Nom du Client"
                  onChange={(e) => setClient(e.target.value)}
                  className="w-full bg-surface-subtle border border-transparent rounded-2xl p-4 pl-12 text-sm font-black text-text-primary outline-none focus:bg-white"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* REASON & NOTES */}
        <div className="grid grid-cols-2 gap-4">
           <div className="space-y-2">
              <label className="text-label font-black uppercase text-text-muted tracking-widest px-1">Motif</label>
              <select 
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full bg-surface-subtle border border-transparent rounded-2xl p-4 text-xs font-black text-text-primary outline-none appearance-none"
              >
                {mode === 'exit' ? (
                  ['Vente', 'Perte / Cassé', 'Retour Fournisseur', 'Échantillon'].map(r => <option key={r} value={r}>{r}</option>)
                ) : mode === 'transfer' ? (
                  ['Optimisation Espace', 'Urgence Commande', 'Maintenance Dépôt'].map(r => <option key={r} value={r}>{r}</option>)
                ) : (
                  ['Réassort', 'Erreur Inventaire', 'Régularisation'].map(r => <option key={r} value={r}>{r}</option>)
                )}
              </select>
           </div>
           <div className="space-y-2">
              <label className="text-label font-black uppercase text-text-muted tracking-widest px-1">Note Libérale</label>
              <input 
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Obs..."
                className="w-full bg-surface-subtle border border-transparent rounded-2xl p-4 text-xs font-black text-text-primary outline-none"
              />
           </div>
        </div>
      </div>

      {/* SUMMARY */}
      <div className="bg-brand-ink rounded-3xl p-5 text-white flex items-center justify-between shadow-xl">
        <div className="flex flex-col">
           <span className="text-micro font-black text-white/40 uppercase tracking-[0.2em] mb-1">Résumé Opération</span>
           <div className="flex items-center gap-2">
              <div className={cn("w-2 h-2 rounded-full", mode === 'entry' ? "bg-green-500" : mode === 'exit' ? "bg-red-500" : "bg-blue-500")} />
              <p className="font-black text-sm uppercase">
                {mode === 'entry' ? 'ENTRÉE' : mode === 'exit' ? 'SORTIE' : mode === 'transfer' ? 'TRANSFERT' : 'AJUSTEMENT'}
                <span className="mx-2 text-white/20">|</span>
                {quantity || '0'} CTN
              </p>
           </div>
        </div>
        <div className="text-right">
           {mode === 'transfer' && targetDepotId && (
             <div className="flex items-center gap-2 text-blue-400">
                <span className="text-micro font-black uppercase">Vers:</span>
                <span className="text-label font-black uppercase">{depots.find(d => d.id === targetDepotId)?.name}</span>
             </div>
           )}
           {mode === 'exit' && client && (
             <div className="flex items-center gap-2 text-red-500">
                <span className="text-micro font-black uppercase">Client:</span>
                <span className="text-label font-black uppercase truncate max-w-[80px]">{client}</span>
             </div>
           )}
        </div>
      </div>

      {/* SUBMIT */}
      <button 
        disabled={loading || !isValid}
        onClick={handleAction}
        className={cn(
          "w-full py-6 rounded-3xl font-black uppercase tracking-widest text-sm flex items-center justify-center gap-3 transition-all active:scale-95 shadow-2xl",
          !isValid ? "bg-surface-subtle text-text-muted" : "bg-brand text-white shadow-brand/30"
        )}
      >
        {loading ? (
          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        ) : (
          <>
            {mode === 'entry' && <ArrowDownRight size={20} />}
            {mode === 'exit' && <ArrowUpRight size={20} />}
            {mode === 'transfer' && <ArrowRightLeft size={20} />}
            {mode === 'adjustment' && <Settings2 size={20} />}
            VALIDER {mode.toUpperCase()} DEPOTEK
          </>
        )}
      </button>
    </div>
  );
};

const ModeTab = ({ active, label, icon, onClick, color }: any) => (
  <button 
    onClick={onClick}
    className={cn(
      "flex-1 flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl transition-all",
      active ? `${color} text-white shadow-lg scale-[1.05] z-10` : "text-text-muted hover:text-text-secondary"
    )}
  >
    {icon}
    <span className="text-micro font-black uppercase tracking-widest">{label}</span>
  </button>
);
