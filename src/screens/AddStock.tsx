
import React, { useState, useEffect, useMemo } from 'react';
import { 
  collection, 
  addDoc, 
  serverTimestamp, 
  query, 
  where, 
  getDocs,
  runTransaction,
  doc,
  increment,
  collectionGroup
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { 
  ChevronLeft, 
  Package, 
  Calendar, 
  MapPin, 
  Scan, 
  AlertTriangle,
  Info,
  Warehouse,
  Check,
  ChevronRight,
  ClipboardList
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, computeStockPayload } from '../lib/utils';
import { createMovement } from '../lib/stockService';
import { useDepots } from './StockHome';
import { useToast } from '../context/ToastContext';

export const AddStock = ({ onBack }: { onBack: () => void }) => {
  const { data: depots } = useDepots();
  const { showToast } = useToast();
  
  const [loading, setLoading] = useState(false);
  const [showDepotModal, setShowDepotModal] = useState(false);
  const [newDepotName, setNewDepotName] = useState('');

  // Form State
  const [formData, setFormData] = useState({
    productName: '',
    sku: '',
    category: '🥩 Viande',
    unit: 'Carton',
    productionDate: '',
    expirationDate: '',
    lotNumber: '',
    supplier: '',
    depotId: '',
    location: '',
    quantity: '', // Used for units (count)
    unitPrice: '', // To be replaced by costPrice logic
    currency: 'XOF', // To be replaced by costCurrency
    threshold: 10,
    container: '',
    
    // NEW FIELDS
    stockType: 'unitized' as 'unitized' | 'bulk',
    units: '',
    unitWeight: '',
    totalWeightKg: '',
    costPrice: '',
    costPer: 'unit' as 'unit' | 'kg',
    costCurrency: 'XOF'
  });

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

  const categories = [
    '🥩 Viande',
    '🐟 Poisson',
    '🍗 Volaille',
    '🧊 Surgelé',
    '📦 Sec'
  ];

  const units = ['Carton', 'Kg', 'Unité', 'Palette'];

  // Auto-calculate expiration based on category
  useEffect(() => {
    if (formData.productionDate) {
      const prodDate = new Date(formData.productionDate);
      if (isNaN(prodDate.getTime())) return;

      let monthsToAdd = 12; // Default
      if (formData.category.includes('Viande')) monthsToAdd = 6;
      else if (formData.category.includes('Poisson')) monthsToAdd = 3;
      else if (formData.category.includes('Volaille')) monthsToAdd = 6;
      else if (formData.category.includes('Surgelé')) monthsToAdd = 12;
      else if (formData.category.includes('Sec')) monthsToAdd = 24;

      const expDate = new Date(prodDate);
      expDate.setMonth(prodDate.getMonth() + monthsToAdd);
      
      setFormData(prev => ({ 
        ...prev, 
        expirationDate: expDate.toISOString().split('T')[0] 
      }));
    }
  }, [formData.category, formData.productionDate]);

  // Auto-fill logic for SKU
  useEffect(() => {
    const checkSku = async () => {
      if (formData.sku.length >= 3) {
        // Look up globally for auto-fill (product name, category, unit)
        const q = query(
          collectionGroup(db, "stock"), 
          where("sku", "==", formData.sku)
        );
        const snapshot = await getDocs(q);
        if (!snapshot.empty) {
          const existing = snapshot.docs[0].data();
          // Ask if user wants to autofill? 
          // For now, let's just do it if fields are empty to avoid annoying confirmation
          setFormData(prev => ({
            ...prev,
            productName: prev.productName || existing.productName || existing.product || '',
            category: prev.category || existing.category || '',
            unit: prev.unit || existing.unit || ''
          }));
        }
      }
    };
    const timer = setTimeout(checkSku, 500);
    return () => clearTimeout(timer);
  }, [formData.sku]);

  // Auto-calculation logic for Weight/Units
  useEffect(() => {
    if (formData.stockType === 'unitized' && formData.unitWeight && Number(formData.unitWeight) > 0 && formData.totalWeightKg) {
      const calculatedUnits = Math.floor(Number(formData.totalWeightKg) / Number(formData.unitWeight));
      if (calculatedUnits > 0 && calculatedUnits.toString() !== formData.units) {
        setFormData(prev => ({ ...prev, units: calculatedUnits.toString() }));
      }
    }
  }, [formData.unitWeight, formData.totalWeightKg, formData.stockType]);

  // Container Weight Lookup
  useEffect(() => {
    const fetchContainerData = async () => {
      if (formData.container.length >= 6) {
        const q = query(collection(db, 'tracking'), where('numeroConteneur', '==', formData.container));
        const snap = await getDocs(q);
        if (!snap.empty) {
          const cData = snap.docs[0].data();
          if (cData.totalWeightKg || cData.poidsTotal) {
            const weight = cData.totalWeightKg || cData.poidsTotal;
            setFormData(prev => ({ ...prev, totalWeightKg: weight.toString() }));
            showToast("Poids du conteneur récupéré !");
          }
        }
      }
    };
    const timer = setTimeout(fetchContainerData, 800);
    return () => clearTimeout(timer);
  }, [formData.container]);

  const isValid = useMemo(() => {
    // 1. Basic Identity
    if (!formData.productName.trim() || !formData.sku.trim()) return false;
    
    // 2. Type-Specific Validation
    if (formData.stockType === 'unitized') {
      return Number(formData.units || 0) > 0 && Number(formData.unitWeight || 0) > 0;
    } else {
      return Number(formData.totalWeightKg || 0) > 0;
    }
  }, [formData]);

  const financialData = useMemo(() => {
    let totalWeight = 0;
    let unitsCount = 0;
    let totalVal = 0;
    
    const cost = formData.costPrice ? Number(formData.costPrice) : 0;
    const isCostSet = formData.costPrice !== '' && !isNaN(cost);

    if (formData.stockType === 'unitized') {
      unitsCount = Number(formData.units) || 0;
      totalWeight = Number(formData.totalWeightKg) || (unitsCount * (Number(formData.unitWeight) || 0));
      
      if (formData.costPer === 'unit') {
        totalVal = unitsCount * cost;
      } else {
        totalVal = totalWeight * cost;
      }
    } else {
      totalWeight = Number(formData.totalWeightKg) || 0;
      totalVal = totalWeight * cost;
    }

    return { totalWeight, unitsCount, totalVal, isCostSet };
  }, [formData]);

  const daysToExpiry = useMemo(() => {
    if (!formData.expirationDate) return null;
    const diff = new Date(formData.expirationDate).getTime() - new Date().getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  }, [formData.expirationDate]);

  const handleSubmit = async () => {
    setLoading(true);
    try {
      // 1. SKU Uniqueness check in current depot
      const q = query(
        collection(db, "depots", formData.depotId, "stock"), 
        where("sku", "==", formData.sku)
      );
      const snapshot = await getDocs(q);
      
      // If SKU exists, we should probably merge or show error. 
      // User requested "AUCUNE écriture directe dans stock sans movement" 
      // and checking if SKU exists.
      if (!snapshot.empty) {
        showToast("Erreur: Ce SKU existe déjà dans ce dépôt", "error");
        setLoading(false);
        return;
      }

      const { totalWeight, unitsCount, totalVal } = financialData;

      // 2. Perform Transaction
      await runTransaction(db, async (transaction) => {
        const depotId = formData.depotId || 'unassigned';
        const depotRef = formData.depotId ? doc(db, "depots", formData.depotId) : null;
        const statsRef = doc(db, "stats", "global");
        
        const newStockRef = doc(collection(db, "depots", depotId, "stock"));
        
        const stockData = computeStockPayload(formData);
        const payload = {
          ...stockData,
          id: newStockRef.id,
          updatedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          createdBy: auth.currentUser?.uid || 'anon',
        };

        transaction.set(newStockRef, payload);

        createMovement(transaction, newStockRef, {
          type: 'entry',
          quantity: payload.quantity,
          previousQty: 0,
          newQty: payload.quantity,
          reason: 'Entrée Inventaire Hub',
          notes: payload.container ? `Conteneur: ${payload.container}` : '',
          userName: auth.currentUser?.displayName || 'Agent',
          userId: auth.currentUser?.uid || 'anon',
        });

        if (depotRef) {
          // current_load uses the same unit as quantity (canonical)
          transaction.update(depotRef, {
            current_load: increment(payload.quantity),
            updatedAt: serverTimestamp(),
          });
        }

        transaction.set(statsRef, {
          valeurStock: increment(payload.totalValue || 0),
          totalCartons: increment(payload.units || 0),
          lastUpdated: serverTimestamp(),
        }, { merge: true });
      });

      showToast("Lot créé & ajouté au stock avec succès !");
      onBack();
    } catch (err: any) {
      console.error(err);
      showToast("Erreur lors de l'enregistrement", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen bg-surface-page max-w-[480px] mx-auto pb-32 font-sans overflow-y-auto no-scrollbar scroll-smooth">
      {/* Top Header */}
      <header className="sticky top-0 z-[100] bg-brand-dark p-6 rounded-b-[40px] shadow-xl flex items-center justify-between overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl p-6" />
        <div className="flex items-center gap-4 relative z-10">
          <button onClick={onBack} className="p-2 bg-white/10 rounded-xl text-white">
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-xl font-black text-white uppercase tracking-tighter">Nouvel Inventaire</h1>
        </div>
        <button 
          disabled={!isValid || loading}
          onClick={handleSubmit}
          className={cn(
            "relative z-10 px-6 py-2.5 rounded-2xl font-black uppercase tracking-widest text-label transition-all active:scale-95",
            isValid 
              ? "bg-white text-brand shadow-xl" 
              : "bg-white/10 text-white/40 cursor-not-allowed"
          )}
        >
          {loading ? '...' : 'Enregistrer'}
        </button>
      </header>

      {/* Depot Creator Modal */}
      <AnimatePresence>
        {showDepotModal && (
          <div className="fixed inset-0 z-[500] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="bg-white rounded-[32px] p-8 w-full max-w-sm shadow-2xl">
              <h3 className="text-xl font-black text-brand-dark mb-6 uppercase tracking-tight">Nouveau Dépôt</h3>
              <div className="space-y-4">
                <FormInput 
                  label="Nom du Dépôt" 
                  value={newDepotName} 
                  onChange={setNewDepotName} 
                  placeholder="Ex: Magasin A" 
                />
                <div className="flex gap-3 pt-4">
                  <button 
                    onClick={() => { setShowDepotModal(false); setNewDepotName(''); }}
                    className="flex-1 py-4 bg-surface-page rounded-2xl font-black uppercase text-label text-text-muted"
                  >
                    Annuler
                  </button>
                  <button 
                    onClick={async () => {
                      if (!newDepotName.trim()) return;
                      setLoading(true);
                      try {
                        const dRef = await addDoc(collection(db, 'depots'), {
                          name: newDepotName,
                          code: newDepotName.substring(0, 3).toUpperCase() + Math.floor(Math.random() * 1000),
                          capacity_cartons: 10000,
                          current_load: 0,
                          type: 'cold',
                          color: '#0d1642',
                          created_at: serverTimestamp(),
                          updatedAt: serverTimestamp()
                        });
                        setFormData(p => ({ ...p, depotId: dRef.id }));
                        setShowDepotModal(false);
                        setNewDepotName('');
                        showToast("Dépôt créé et sélectionné !");
                      } catch (err) {
                        console.error(err);
                        showToast("Erreur lors de la création", "error");
                      } finally {
                        setLoading(false);
                      }
                    }} 
                    disabled={loading || !newDepotName.trim()} 
                    className="flex-1 py-4 bg-brand rounded-2xl font-black uppercase text-label text-white shadow-lg shadow-blue-500/20 flex items-center justify-center disabled:opacity-50"
                  >
                    {loading ? '...' : 'Créer'}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <main className="p-[14px] space-y-4">
        {/* Type selector */}
        <div className="flex gap-2 p-1 bg-surface-page rounded-2xl">
          <button 
            onClick={() => setFormData(p => ({ ...p, stockType: 'unitized' }))}
            className={cn(
              "flex-1 py-3 rounded-xl font-black text-caption uppercase tracking-wider transition-all",
              formData.stockType === 'unitized' ? "bg-white text-brand shadow-sm" : "text-text-muted"
            )}
          >
            📦 Cartons (Unitized)
          </button>
          <button 
            onClick={() => setFormData(p => ({ ...p, stockType: 'bulk' }))}
            className={cn(
              "flex-1 py-3 rounded-xl font-black text-caption uppercase tracking-wider transition-all",
              formData.stockType === 'bulk' ? "bg-white text-brand shadow-sm" : "text-text-muted"
            )}
          >
            ⚖️ Vrac (Bulk)
          </button>
        </div>

        {/* Card 1: Produit */}
        <div className="bg-white rounded-[24px] p-5 shadow-sm border border-border-default flex flex-col gap-4">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 bg-surface-subtle rounded-xl flex items-center justify-center text-brand">
                <Package size={16} />
             </div>
             <h2 className="text-label font-black text-text-muted uppercase tracking-[0.2em]">Détails Produit</h2>
          </div>

          <div className="space-y-3">
            <FormInput 
              label="SKU / Code Unique *" 
              value={formData.sku} 
              autoCapitalize="characters"
              onChange={(v: string) => setFormData(p => ({ ...p, sku: v.toUpperCase() }))}
              placeholder="Ex: DKR-BUF-001"
            />

            <FormInput 
              label="Nom du Produit *" 
              value={formData.productName} 
              onChange={(v: string) => setFormData(p => ({ ...p, productName: v }))}
              placeholder="Ex: Buffalo Meat Grade A"
            />
            
            <div className="grid grid-cols-2 gap-3">
               <FormSelect 
                label="Catégorie *" 
                options={categories}
                value={formData.category}
                onChange={(v: string) => setFormData(p => ({ ...p, category: v }))}
               />
               <FormSelect 
                label="Unité" 
                options={units}
                value={formData.unit}
                onChange={(v: string) => setFormData(p => ({ ...p, unit: v }))}
               />
            </div>

            <div className="grid grid-cols-2 gap-3">
              {formData.stockType === 'unitized' ? (
                <>
                  <FormInput 
                    type="number"
                    label="Nombre Unités (Cartons) *" 
                    value={formData.units} 
                    onChange={(v: string) => setFormData(p => ({ ...p, units: v }))}
                    placeholder="0"
                  />
                  <FormInput 
                    type="number"
                    label="Poids par Unité (kg) *" 
                    value={formData.unitWeight} 
                    onChange={(v: string) => setFormData(p => ({ ...p, unitWeight: v }))}
                    placeholder="0.00"
                  />
                </>
              ) : (
                <FormInput 
                  type="number"
                  label="Poids Total (kg) *" 
                  className="col-span-2"
                  value={formData.totalWeightKg} 
                  onChange={(v: string) => setFormData(p => ({ ...p, totalWeightKg: v }))}
                  placeholder="0.00"
                />
              )}
            </div>
            
            <FormInput 
              label="Conteneur ID" 
              value={formData.container} 
              autoCapitalize="characters"
              onChange={(v: string) => setFormData(p => ({ ...p, container: v.toUpperCase() }))}
              placeholder="Ex: MSCU-123456"
            />

            {/* Financial Preview */}
            <div className="bg-surface-subtle/30 rounded-xl p-4 border border-border-default">
               <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col">
                    <span className="text-micro font-black text-brand uppercase tracking-widest mb-1">Valeur Totaleestimée</span>
                    <span className="text-sm font-black text-brand-dark">
                      {!canSeeFinancials ? "••••" : (financialData.isCostSet ? financialData.totalVal.toLocaleString() : "Non défini")} {financialData.isCostSet && canSeeFinancials && <span className="text-label opacity-40">XOF</span>}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-micro font-black text-text-muted uppercase tracking-widest block mb-1">Poids Total</span>
                    <span className="text-xs font-bold text-text-secondary">{financialData.totalWeight.toLocaleString()} <span className="text-micro opacity-50">KG</span></span>
                  </div>
               </div>
            </div>
          </div>
        </div>

        {/* Card 2: Dates FEFO */}
        <div className="bg-white rounded-[24px] p-5 shadow-sm border border-border-default flex flex-col gap-4">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 bg-orange-50 rounded-xl flex items-center justify-center text-orange-500">
                <Calendar size={16} />
             </div>
             <h2 className="text-label font-black text-text-muted uppercase tracking-[0.2em]">Traçabilité FEFO</h2>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <FormInput 
                type="date"
                label="Production" 
                value={formData.productionDate} 
                onChange={(v: string) => setFormData(p => ({ ...p, productionDate: v }))}
              />
              <FormInput 
                type="date"
                label="Expiration *" 
                value={formData.expirationDate} 
                onChange={(v: string) => setFormData(p => ({ ...p, expirationDate: v }))}
              />
            </div>

            {/* Expiring Alerts */}
            {daysToExpiry !== null && (
              <div className={cn(
                "p-3 rounded-xl flex items-center gap-3",
                daysToExpiry < 7 ? "bg-red-50 text-red-600 border border-red-100" :
                daysToExpiry < 30 ? "bg-orange-50 text-orange-600 border border-orange-100" :
                "bg-green-50 text-green-600 border border-green-100"
              )}>
                <AlertTriangle size={16} />
                <div className="flex flex-col">
                  <span className="text-micro font-black uppercase tracking-widest">Alerte FEFO</span>
                  <span className="text-micro font-bold opacity-80 uppercase">
                    {daysToExpiry <= 0 ? "Le produit est expiré" : `Expire dans ${daysToExpiry} jours`}
                  </span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <FormInput 
                label="N° Lot / Batch *" 
                value={formData.lotNumber} 
                onChange={(v: string) => setFormData(p => ({ ...p, lotNumber: v }))}
                placeholder="Ex: LOT-2026-A"
              />
              <FormInput 
                label="Fournisseur" 
                value={formData.supplier} 
                onChange={(v: string) => setFormData(p => ({ ...p, supplier: v }))}
                placeholder="Atlas Cargo"
              />
            </div>
          </div>
        </div>

        {/* Card 3: Finance & Location */}
        <div className="bg-white rounded-[24px] p-5 shadow-sm border border-border-default flex flex-col gap-4">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 bg-blue-50 rounded-xl flex items-center justify-center text-blue-500">
                <Warehouse size={16} />
             </div>
             <h2 className="text-label font-black text-text-muted uppercase tracking-[0.2em]">Logistique & Coûts</h2>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <label className="text-micro font-black uppercase text-text-muted tracking-widest">Sélectionner Dépôt</label>
                {depots.length === 0 && (
                  <button 
                    onClick={() => setShowDepotModal(true)}
                    className="text-micro font-black text-brand uppercase bg-surface-subtle px-2 py-1 rounded-lg"
                  >
                    + Créer un dépôt
                  </button>
                )}
              </div>
              {depots.length === 0 ? (
                <div className="p-4 bg-orange-50 border border-orange-100 rounded-xl flex items-center gap-2 text-orange-600">
                  <AlertTriangle size={14} />
                  <span className="text-micro font-black uppercase">Aucun dépôt trouvé</span>
                </div>
              ) : (
                <FormSelect 
                  label="" 
                  className="!px-0"
                  value={formData.depotId}
                  onChange={(v: string) => setFormData(p => ({ ...p, depotId: v }))}
                  options={[
                    { label: "Sélectionner un dépôt...", value: "" },
                    ...depots.map(d => ({
                      label: `${d.name} (${d.current_load}/${d.capacity_cartons} CTN)`,
                      value: d.id
                    }))
                  ]}
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-micro font-black uppercase text-text-muted tracking-widest px-1">Coût d'Achat (Optionnel)</label>
                <div className="flex gap-1">
                  <input 
                    type="number"
                    value={canSeeFinancials ? formData.costPrice : ''}
                    disabled={!canSeeFinancials}
                    onChange={e => setFormData(p => ({ ...p, costPrice: e.target.value }))}
                    className="flex-1 bg-surface-subtle border border-transparent rounded-xl p-3 text-xs font-black text-brand-dark focus:bg-white focus:border-brand/20 outline-none transition-all shadow-inner disabled:bg-surface-page disabled:placeholder-gray-300"
                    placeholder={canSeeFinancials ? "Ex: 45000" : "••••"}
                  />
                  <select 
                    value={formData.costPer}
                    onChange={e => setFormData(p => ({ ...p, costPer: e.target.value as any }))}
                    className="w-16 bg-surface-subtle border border-transparent rounded-xl p-3 text-micro font-black text-brand-dark focus:bg-white focus:border-brand/20 outline-none transition-all shadow-inner"
                  >
                    <option value="unit">/u</option>
                    <option value="kg">/kg</option>
                  </select>
                </div>
              </div>
              <FormInput 
                label="Zone / Allée" 
                value={formData.location} 
                onChange={(v: string) => setFormData(p => ({ ...p, location: v }))}
                placeholder="Zone C-04"
              />
            </div>

            {/* Threshold restoration */}
            <div className="space-y-2">
              <label className="text-micro font-black uppercase text-text-muted tracking-widest px-1">Seuil Alerte Stock Bas ({formData.threshold} unités)</label>
              <div className="flex items-center gap-4 bg-surface-subtle rounded-xl p-3">
                <input 
                  type="range" 
                  min="5" 
                  max="50" 
                  step="5"
                  value={formData.threshold}
                  onChange={e => setFormData(p => ({ ...p, threshold: parseInt(e.target.value) }))}
                  className="flex-1 accent-brand h-1 bg-surface-subtle rounded-full appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Action Bottom */}
        <button 
          disabled={!isValid || loading}
          onClick={handleSubmit}
          className={cn(
            "w-full py-5 rounded-[1.5rem] font-black uppercase tracking-[0.2em] text-caption shadow-2xl transition-all active:scale-95 flex items-center justify-center gap-3",
            isValid 
              ? "bg-brand text-white shadow-brand/30" 
              : "bg-surface-subtle text-text-muted cursor-not-allowed"
          )}
        >
          {loading ? 'Saisie en cours...' : 'Créer & Ajouter au Stock'}
          {!loading && <Check size={16} strokeWidth={3} />}
        </button>
      </main>
    </div>
  );
};

const FormInput = ({ label, value, onChange, placeholder, type = "text", inputMode, autoCapitalize, className }: any) => (
  <div className={cn("space-y-1.5", className)}>
    <label className="text-micro font-black uppercase text-text-muted tracking-widest px-1">{label}</label>
    <input 
      type={type}
      value={value}
      inputMode={inputMode}
      autoCapitalize={autoCapitalize}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-surface-subtle border border-transparent rounded-xl p-3 text-xs font-black text-brand-dark focus:bg-white focus:border-brand/20 outline-none transition-all shadow-inner"
      placeholder={placeholder}
    />
  </div>
);

const FormSelect = ({ label, options, value, onChange, className }: any) => (
  <div className={cn("space-y-1.5", className)}>
    {label && <label className="text-micro font-black uppercase text-text-muted tracking-widest px-1">{label}</label>}
    <div className="relative">
      <select 
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-surface-subtle border border-transparent rounded-xl p-3 text-xs font-black text-brand-dark focus:bg-white focus:border-brand/20 outline-none transition-all shadow-inner appearance-none"
      >
        <option value="" disabled>Sélectionner...</option>
        {options.map((opt: any) => (
          <option key={typeof opt === 'string' ? opt : opt.value} value={typeof opt === 'string' ? opt : opt.value}>
            {typeof opt === 'string' ? opt : opt.label}
          </option>
        ))}
      </select>
      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-text-muted">
        <ChevronRight size={14} className="rotate-90" />
      </div>
    </div>
  </div>
);
