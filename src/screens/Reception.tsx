import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, 
  FileText, 
  ChevronLeft, 
  Ship, 
  Clock, 
  Plus,
  ArrowUpRight,
  History,
  Box,
  MapPin,
  Bell,
  Building2,
  ChevronRight,
  Truck,
  CheckCircle2,
  AlertTriangle,
  Package,
  X,
  Navigation,
  Activity,
  Search,
  ChevronDown,
  Anchor,
  Compass,
  PieChart as PieIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, computeStockPayload } from '../lib/utils';
import { db, auth } from '../lib/firebase';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  doc,
  getDocs,
  writeBatch,
  runTransaction,
  serverTimestamp, 
  orderBy, 
  limit, 
  increment,
  Timestamp
} from 'firebase/firestore';
import { useToast } from '../context/ToastContext';
import { useDepots, useUnreadAlerts } from './StockHome';
import { ContainerInfo, DocumentEntry, StockStatus, DocCategory } from '../types';
import { analyzeLogisticsDocument } from '../services/geminiService';
import { compressImage } from '../services/imageCompressionService';
import { trackingService, TrackingData, Milestone } from '../services/trackingService';
import { getTrackingUrl, detectCarrier } from '../utils/CarrierTracking';

export const ReceptionScreen = ({ onBack, onNavigate }: { onBack: () => void, onNavigate: (screen: string) => void }) => {
  // --- STATE ---
  const [trackingFlow, setTrackingFlow] = useState<TrackingData[]>([]);
  const [recentDocs, setRecentDocs] = useState<DocumentEntry[]>([]);
  const [docStatusMap, setDocStatusMap] = useState<Record<string, { hasInvoice: boolean, hasSanitary: boolean }>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [extractedData, setExtractedData] = useState<any | null>(null);
  const [analysisError, setAnalysisError] = useState<{ message: string, detail?: string } | null>(null);
  const [isManualEntry, setIsManualEntry] = useState(false);
  const [manualForm, setManualForm] = useState({ productName: '', quantity: '', container: '', docType: 'invoice' });
  const [isFabOpen, setIsFabOpen] = useState(false);
  const [existingProductNames, setExistingProductNames] = useState<Set<string>>(new Set());
  const [isEditing, setIsEditing] = useState(false);
  const [showDepotSelect, setShowDepotSelect] = useState(false);
  
  const [isSearching, setIsSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [expandedTrackId, setExpandedTrackId] = useState<string | null>(null);
  const [searchType, setSearchType] = useState<'AUTO' | 'CONTAINER' | 'BL'>('AUTO');
  const [validationModal, setValidationModal] = useState<{ open: boolean, track: TrackingData | null }>({ open: false, track: null });

  // Tracking Search
  const [trackingNumber, setTrackingNumber] = useState('');
  const detectedCarrier = trackingNumber.length >= 4 ? detectCarrier(trackingNumber) : null;

  const [isProcessing, setIsProcessing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  
  const { showToast } = useToast();
  const unreadAlerts = useUnreadAlerts();
  const { data: depots } = useDepots();
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- DATA FETCHING ---
  
  // 1. REAL-TIME TRACKING (10 last)
  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'tracking'), orderBy('lastSync', 'desc'), limit(10));
    const unsub = onSnapshot(q, (snap) => {
      setTrackingFlow(snap.docs.map(d => ({ id: d.id, ...d.data() } as TrackingData)));
    }, (err) => {
      console.warn("Tracking error:", err);
    });
    return () => unsub();
  }, []);

  // 2. RECENT DOCUMENTS (5 last)
  useEffect(() => {
    if (!auth.currentUser) return;
    const q = query(collection(db, 'document_library'), orderBy('createdAt', 'desc'), limit(5));
    const unsub = onSnapshot(q, (snap) => {
      setRecentDocs(snap.docs.map(d => ({ id: d.id, ...d.data() } as DocumentEntry)));
    }, (err) => {
      console.warn("Docs error:", err);
    });
    return () => unsub();
  }, []);

  // 3. DOCUMENT STATUS SYNC (Check for Critical Documents per Container)
  useEffect(() => {
    if (!auth.currentUser || trackingFlow.length === 0) return;
    
    const containerNumbers = trackingFlow.map(t => t.numeroConteneur).filter(Boolean);
    if (containerNumbers.length === 0) return;

    const q = query(
      collection(db, 'document_library'), 
      where('linkedContainer', 'in', containerNumbers.slice(0, 10)),
      where('category', 'in', ['invoice', 'sanitary_certificate'])
    );

    const unsub = onSnapshot(q, (snap) => {
      const map: Record<string, { hasInvoice: boolean, hasSanitary: boolean }> = {};
      
      // Initialize with false for all flow containers
      containerNumbers.forEach(cn => map[cn] = { hasInvoice: false, hasSanitary: false });

      snap.docs.forEach(d => {
        const data = d.data();
        if (data.linkedContainer && map[data.linkedContainer]) {
          if (data.category === 'invoice') map[data.linkedContainer].hasInvoice = true;
          if (data.category === 'sanitary_certificate') map[data.linkedContainer].hasSanitary = true;
        }
      });
      setDocStatusMap(map);
    }, (err) => {
      console.warn("Doc status sync error:", err);
    });

    return () => unsub();
  }, [trackingFlow]);

  // FETCH UNIQUE PRODUCT NAMES FOR VALIDATION
  useEffect(() => {
    if (!auth.currentUser) return;
    const fetchProducts = async () => {
      const q = query(collection(db, 'logs'), limit(100)); // Get from logs to see history
      const snap = await getDocs(q);
      const names = new Set<string>();
      snap.forEach(d => {
        const p = d.data().product || d.data().productName;
        if (p) names.add(p.toUpperCase());
      });
      setExistingProductNames(names);
    };
    fetchProducts();
  }, []);

  // --- HANDLERS ---

  const handleDocContainerClick = (containerNo: string) => {
    // 1. Open search if closed
    if (!searchOpen) setSearchOpen(true);
    // 2. Clear previous search
    setTrackingNumber(containerNo);
    // 3. Scroll to tracking section
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
    // 4. Expand if in flow
    setExpandedTrackId(containerNo);
    
    showToast(`Ouverture tracking : ${containerNo}`, "info");
  };

  const processReception = async (track: TrackingData) => {
    if (!auth.currentUser) return;
    const status = docStatusMap[track.numeroConteneur];
    const isComplete = status?.hasInvoice && status?.hasSanitary;
    
    try {
      const batch = writeBatch(db);
      const containerRef = doc(db, 'tracking', track.id!);
      
      batch.update(containerRef, {
        statut: 'discharged',
        lastSync: serverTimestamp(),
        validationLog: {
          validatedBy: auth.currentUser.email,
          validatedAt: serverTimestamp(),
          isDocumentaryComplete: isComplete,
          missingDocs: [
            !status?.hasInvoice && 'Facture',
            !status?.hasSanitary && 'Certificat Sanitaire'
          ].filter(Boolean)
        }
      });

      // Also log to a separate audit collection for permanence
      const auditRef = doc(collection(db, 'reception_logs'));
      batch.set(auditRef, {
        containerNumber: track.numeroConteneur,
        validatedBy: auth.currentUser.email,
        timestamp: serverTimestamp(),
        complianceScore: isComplete ? 100 : (status?.hasInvoice || status?.hasSanitary ? 50 : 0),
        statusAtValidation: track.statut
      });

      await batch.commit();
      showToast(`Réception validée : ${track.numeroConteneur}`, "success");
      setValidationModal({ open: false, track: null });
    } catch (err) {
      console.error(err);
      showToast("Erreur lors de la validation.", "error");
    }
  };

  const handleSearch = async () => {
    if (!trackingNumber.trim()) return;
    const { url, carrier } = getTrackingUrl(trackingNumber.trim());
    
    // 1. Log event as requested
    await trackingService.logTrackingAction(trackingNumber.trim(), carrier);
    
    // 2. Open external URL
    window.open(url, '_blank');
    
    // 3. Try to sync metadata locally
    setIsSearching(true);
    try {
      const result = await trackingService.trackNewReference(trackingNumber.trim());
      setIsSearching(false);
      if (!result) {
        showToast("Référence non synchronisée.", "warning");
      } else {
        showToast(`Tracking ${carrier} ouvert.`, "success");
        setTrackingNumber('');
        setSearchOpen(false);
      }
    } catch (err) {
      setIsSearching(false);
      showToast("Erreur de connexion.", "error");
    }
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files) return;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setIsManualEntry(false);
    showToast(`Compression & Analyse IA...`, "info");

    for (const file of Array.from(files)) {
      try {
        let fileToProcess = file;
        if (file.type.startsWith('image/')) {
          fileToProcess = (await compressImage(file)) as File;
          console.log(`Comp: ${(file.size/1024).toFixed(1)}KB -> ${(fileToProcess.size/1024).toFixed(1)}KB`);
        }
        
        const base64 = await fileToBase64(fileToProcess);
        const analysis = await analyzeLogisticsDocument(base64, fileToProcess.type);
        
        // Product matching logic (Simple check if products list is empty)
        if (!analysis.products || analysis.products.length === 0) {
          throw new Error("Aucun produit détecté sur le document.");
        }

        setExtractedData({ 
          ...analysis, 
          fileName: fileToProcess.name, 
          fileType: fileToProcess.type, 
          fileSize: fileToProcess.size,
          base64: base64
        });
      } catch (err) {
        console.error(err);
        setAnalysisError({ 
          message: "Échec de l'analyse IA", 
          detail: err instanceof Error ? err.message : "Le document est peut-être illisible ou le format n'est pas supporté." 
        });
        showToast(`Erreur d'analyse pour ${file.name}`, "error");
      }
    }
    setIsAnalyzing(false);
  };

  const confirmStockAction = async (type: 'nouveau' | 'depot', targetDepotId?: string) => {
    if ((!extractedData && !isManualEntry) || !auth.currentUser) return;
    setIsProcessing(true);
    
    try {
      const dataToUse = isManualEntry ? {
        containerNumber: manualForm.container,
        products: [{ name: manualForm.productName, quantity: Number(manualForm.quantity) }],
        docType: manualForm.docType,
        fileName: 'Saisie Manuelle',
        fileType: 'manual/entry'
      } : extractedData;

      const containerNo = dataToUse.containerNumber || "PAD-" + Math.random().toString(36).substr(2, 6).toUpperCase();
      const firstProduct = dataToUse.products?.[0] || { name: 'Produit Inconnu', quantity: 0 };
      const estimatedValue = (firstProduct.quantity || 0) * 15000;

      await runTransaction(db, async (transaction) => {
        // 1. Mark doc as PROCESSED
        const docRef = doc(collection(db, 'document_library'));
        transaction.set(docRef, {
          fileName: extractedData.fileName,
          fileType: extractedData.fileType,
          category: extractedData.docType || 'invoice',
          status: 'PROCESSED',
          extraitsIA: extractedData,
          linkedContainer: containerNo,
          actionTaken: type === 'nouveau' ? 'new_container' : 'depot_add',
          createdAt: serverTimestamp(),
          createdBy: auth.currentUser.uid
        });

        // 2. Handle Stock Entry
        let chosenDepotId = targetDepotId || depots[0]?.id || 'unassigned';
        const stockRef = doc(collection(db, 'depots', chosenDepotId, 'stock'));
        
        const calculatedPayload = computeStockPayload({
          productName: firstProduct.name,
          sku: firstProduct.sku || `SKU-${containerNo.substring(0, 4)}`, // Fallback for reception
          units: Number(firstProduct.quantity),
          unitWeight: firstProduct.unitWeight || 0,
          totalWeightKg: firstProduct.totalWeightKg || 0,
          container: containerNo,
          depotId: chosenDepotId,
          costPrice: estimatedValue / (firstProduct.quantity || 1),
          status: 'stored'
        });

        const finalPayload = {
          ...calculatedPayload,
          id: stockRef.id,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          aging_days: 0,
          fefo_score: 100,
          createdBy: auth.currentUser.uid
        };

        transaction.set(stockRef, finalPayload);

        // 3. Update Depot Counters
        const depotRef = doc(db, 'depots', chosenDepotId);
        transaction.update(depotRef, {
          current_load: increment(Number(finalPayload.units || finalPayload.totalWeightKg)),
          updatedAt: serverTimestamp()
        });

        // 4. Global Stats
        const statsRef = doc(db, 'stats', 'global');
        transaction.set(statsRef, {
          valeurStock: increment(finalPayload.totalValue || 0),
          totalCartons: increment(finalPayload.units || 0),
          lastUpdated: serverTimestamp()
        }, { merge: true });

        // 5. Tracking Milestone
        const trackRef = doc(db, 'tracking', containerNo);
        transaction.set(trackRef, {
          numeroConteneur: containerNo,
          statut: 'discharged',
          carrier: extractedData.carrier || 'LINE-X',
          portDechargement: 'DAKAR (PAD)',
          lastSync: serverTimestamp(),
          historiqueMilestones: [
            {
              timestamp: new Date().toISOString(),
              location: 'PAD HUB',
              description: 'Dépotage validé : Stock créé',
              status: 'discharged'
            }
          ]
        }, { merge: true });

      });

      showToast("Stock créé et archives mises à jour.", "success");
      setShowSuccess(true);
      setTimeout(() => {
        setShowSuccess(false);
        setExtractedData(null);
        setIsManualEntry(false);
        setAnalysisError(null);
        onNavigate('inventaire');
      }, 1500);

    } catch (err) {
      console.error(err);
      showToast("Erreur transaction : " + (err instanceof Error ? err.message : String(err)), "error");
    } finally {
      setIsProcessing(false);
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result?.toString().split(',')[1] || "");
      reader.onerror = reject;
    });
  };

  return (
    <div className="h-full bg-surface-page flex flex-col max-w-[480px] mx-auto relative font-sans overflow-hidden">
      
      {/* HEADER */}
      <header className="flex-none bg-brand-dark p-6 rounded-b-[40px] shadow-xl relative overflow-hidden sticky top-0 z-[100]">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl text-white" />
        <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-4">
            <button onClick={onBack} className="p-2 bg-white/10 rounded-xl text-white transition-colors">
              <ChevronLeft size={24} />
            </button>
            <div>
              <h1 className="text-xl font-black text-white tracking-tight uppercase">ENTRÉES</h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-label font-black text-white/50 uppercase tracking-widest leading-none">DEPOTEK HUB</span>
                <div className="w-1.5 h-1.5 bg-status-success rounded-full animate-pulse shadow-md" />
              </div>
            </div>
          </div>
          <button onClick={() => onNavigate('Docs')} className="w-11 h-11 bg-white/10 backdrop-blur-md rounded-2xl border border-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all shadow-xl">
             <FileText size={20} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto no-scrollbar overscroll-contain pb-32">
        
        {/* SECTION 1 - POSTE DE CONTRÔLE */}
        <section className="bg-white p-8 flex flex-col items-center">
           <div className="text-center mb-8">
              <h2 className="text-caption font-black text-text-muted uppercase tracking-[0.2em] mb-1">Poste de Contrôle</h2>
              <p className="text-xl font-black text-brand-dark uppercase tracking-tight">Dépotage & Scan Documents</p>
           </div>

           <label className="relative cursor-pointer mb-8">
              <input type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={(e) => handleFileUpload(e.target.files)} />
              
              <motion.div 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="w-[140px] h-[140px] bg-brand rounded-full flex flex-col items-center justify-center shadow-[0_20px_40px_-5px_rgba(26,35,126,0.3)] relative z-10 border-4 border-white/10"
              >
                 <Upload size={40} className="text-white mb-1" />
                 <span className="text-label font-black text-white/60 uppercase tracking-widest">UPLOAD</span>
              </motion.div>
              
              {/* Pulse effect */}
              <div className="absolute inset-0 bg-brand rounded-full animate-ping opacity-5 z-0 scale-110" />
           </label>

           <button 
             onClick={() => document.querySelector('input')?.click()}
             className="bg-brand-dark text-white px-8 py-3.5 rounded-full text-caption font-black uppercase tracking-[0.2em] shadow-xl hover:bg-brand transition-colors"
           >
              Ouvrir Caméra / Fichiers
           </button>

           {isAnalyzing && (
             <motion.div 
               initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
               className="mt-8 flex items-center gap-3 bg-brand/5 px-6 py-3 rounded-2xl border border-brand/10"
             >
                <div className="w-4 h-4 border-2 border-brand/20 border-t-[#1a237e] rounded-full animate-spin" />
                <span className="text-label font-black text-brand uppercase tracking-widest">Analyse Gemini IA...</span>
             </motion.div>
           )}
        </section>

        {/* SECTION 2 - TRACKING INTÉGRÉ */}
        <section className="mt-4 px-6">
           <div 
             className="flex items-center justify-between mb-4 cursor-pointer active:opacity-60 transition-opacity"
             onClick={() => setSearchOpen(!searchOpen)}
           >
              <div className="flex items-center gap-2">
                 <h3 className="text-body font-black text-text-primary uppercase tracking-tight">Flux de Tracking</h3>
                 <span className="px-1.5 py-0.5 bg-status-success/10 text-status-success text-micro font-black uppercase rounded tracking-tighter">Live PAD</span>
              </div>
              <div className="flex items-center gap-3">
                 <span className="text-label font-black text-text-muted uppercase tracking-widest">10 Derniers</span>
                 <button onClick={() => setSearchOpen(!searchOpen)} className="w-8 h-8 bg-white rounded-lg shadow-sm border border-border-default flex items-center justify-center text-text-muted">
                    <Search size={14} />
                 </button>
              </div>
           </div>

           {/* SEARCH EXPANDABLE */}
           <AnimatePresence>
              {searchOpen && (
                <motion.div 
                  initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden mb-6 bg-white p-5 rounded-[2rem] shadow-sm border border-border-default"
                >
                   <div className="flex gap-2 mb-4">
                      {['AUTO', 'CONTAINER', 'BL'].map(t => (
                        <button 
                          key={t} onClick={() => setSearchType(t as any)}
                          className={cn(
                            "px-4 py-2 rounded-xl text-label font-black uppercase tracking-widest transition-all", 
                            searchType === t ? "bg-brand text-white shadow-lg" : "bg-surface-subtle text-text-muted"
                          )}
                        >
                          {t}
                        </button>
                      ))}
                   </div>
                   <div className="flex gap-2.5">
                      <div className="flex-1 relative flex items-center">
                        <input 
                          type="text" value={trackingNumber} 
                          onChange={e => {
                            const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
                            setTrackingNumber(val);
                          }}
                          placeholder="MSDU9889624"
                          maxLength={11}
                          className="w-full bg-surface-subtle px-5 py-4 rounded-2xl text-sm font-black text-text-primary outline-none border border-border-default focus:border-brand/30 placeholder:text-slate-200"
                        />
                        {detectedCarrier && (
                          <div 
                            className="absolute right-4 px-2.5 py-1.5 rounded-xl flex items-center gap-2 shadow-sm pointer-events-none"
                            style={{ backgroundColor: `${detectedCarrier.color}15` }}
                          >
                             <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: detectedCarrier.color }} />
                             <span className="text-micro font-black uppercase tracking-tighter" style={{ color: detectedCarrier.color }}>
                                {detectedCarrier.name}
                             </span>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-2">
                        <button 
                          onClick={() => {
                             if (!trackingNumber.trim()) return;
                             const { url } = getTrackingUrl(trackingNumber.trim());
                             window.open(url, '_blank');
                             setTrackingNumber('');
                          }}
                          className="bg-brand text-white px-6 py-4 rounded-2xl text-caption font-black uppercase tracking-widest shadow-xl shadow-[#1a237e]/20 active:scale-95 transition-all h-full"
                        >
                          TRACKER
                        </button>
                      </div>
                   </div>
                   <div className="flex items-center justify-between mt-3 px-1">
                      <p className="text-micro font-bold text-text-muted uppercase tracking-widest">
                        Ouverture via portail maritime externe
                      </p>
                      <button 
                        onClick={handleSearch}
                        disabled={isSearching}
                        className="text-micro font-black text-brand uppercase tracking-widest border-b border-brand/20 pb-0.5"
                      >
                        {isSearching ? 'Synchronisation...' : 'Synchroniser Flux'}
                      </button>
                   </div>
                </motion.div>
              )}
           </AnimatePresence>
           
           <div className="flex gap-4 overflow-x-auto no-scrollbar pb-2 scroll-smooth" ref={scrollRef}>
              {trackingFlow.length === 0 ? (
                <div className="w-full h-24 bg-white/50 rounded-2xl border border-dashed border-border-default flex flex-col items-center justify-center">
                   <Navigation size={20} className="text-slate-200 mb-1" />
                   <p className="text-micro font-black text-text-muted uppercase tracking-widest">Aucun flux détecté</p>
                </div>
              ) : (
                trackingFlow.map(track => (
                <div key={track.id} className="relative">
                  <TrackingItemCard 
                    track={track} 
                    isExpanded={expandedTrackId === track.id} 
                    onToggle={() => setExpandedTrackId(expandedTrackId === track.id ? null : (track.id || null))} 
                    missingDocs={(!docStatusMap[track.numeroConteneur]?.hasInvoice || !docStatusMap[track.numeroConteneur]?.hasSanitary) && (track.statut === 'at_port' || track.statut === 'arrived' || track.statut === 'customs_clearance')}
                    onReceptionClick={() => setValidationModal({ open: true, track })}
                  />
                  {(!docStatusMap[track.numeroConteneur]?.hasInvoice || !docStatusMap[track.numeroConteneur]?.hasSanitary) && (track.statut === 'at_port' || track.statut === 'arrived' || track.statut === 'customs_clearance') && (
                    <div className="absolute -top-1 -right-1 z-20">
                      <div className="bg-red-500 text-white text-micro font-black px-1.5 py-0.5 rounded-full shadow-lg border border-white animate-pulse">
                        DOCUMENT REQUIS
                      </div>
                    </div>
                  )}
                </div>
                ))
              )}
           </div>
        </section>

        {/* SECTION 3 - DERNIERS DOCUMENTS */}
        <section className="mt-8 px-6">
           <div className="flex items-center justify-between mb-4">
              <h3 className="text-body font-black text-text-primary uppercase tracking-tight">Derniers Documents</h3>
              <button onClick={() => onNavigate('Docs')} className="text-label font-black text-brand uppercase tracking-widest">Voir tout</button>
           </div>

           <div className="space-y-3">
              {recentDocs.map(doc => (
                <div key={doc.id} className="bg-white p-4 rounded-2xl border border-border-default flex items-center gap-4 transition-all hover:bg-surface-subtle group">
                   <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", getDocColor(doc.category))}>
                      <FileText size={18} />
                   </div>
                   <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                         <h4 className="text-caption font-black text-text-primary uppercase tracking-tight truncate">{doc.fileName}</h4>
                         <span className={cn("text-micro font-black px-1.5 py-0.5 rounded uppercase tracking-tighter", doc.actionTaken === 'new_container' ? "bg-green-50 text-green-600" : "bg-blue-50 text-blue-600")}>
                            {doc.actionTaken === 'new_container' ? '🆕 STOCK' : '📦 DÉPÔT'}
                         </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="text-micro font-bold text-text-muted uppercase tracking-widest leading-none">
                           {doc.createdAt?.toDate ? doc.createdAt.toDate().toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : 'Maintenant'}
                        </p>
                        {doc.linkedContainer && (
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDocContainerClick(doc.linkedContainer!);
                            }}
                            className="px-1.5 py-0.5 bg-green-50 text-green-600 rounded text-micro font-black uppercase tracking-tighter hover:bg-green-100 transition-colors"
                          >
                             {doc.linkedContainer}
                          </button>
                        )}
                      </div>
                   </div>
                   <ChevronRight size={14} className="text-slate-200 group-hover:text-text-muted" />
                </div>
              ))}
           </div>
        </section>
      </div>

      {/* IA ANALYSIS MODAL */}
      <AnimatePresence>
        {extractedData && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-brand-ink/80 backdrop-blur-md z-[200]" onClick={() => !showDepotSelect && setExtractedData(null)} />
            <motion.div 
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} 
              className="fixed bottom-0 left-0 w-full bg-white rounded-t-[3rem] p-8 z-[210] shadow-2xl flex flex-col max-h-[90vh]"
            >
               <div className="w-12 h-1 bg-surface-subtle rounded-full mx-auto mb-6" />
               <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                     <CheckCircle2 size={24} className="text-status-success" />
                     <h3 className="text-lg font-black text-text-primary uppercase tracking-tight">Données Extuites (IA)</h3>
                  </div>
                  <button onClick={() => setExtractedData(null)} className="w-10 h-10 bg-surface-subtle rounded-xl flex items-center justify-center text-text-muted">
                     <X size={20} />
                  </button>
               </div>

               <div className="flex-1 overflow-y-auto no-scrollbar space-y-6 pb-6">
                  <div className="bg-surface-subtle p-6 rounded-2xl space-y-4">
                     <div>
                        <span className="text-micro font-black text-text-muted uppercase tracking-[0.2em] block mb-1">Conteneur Détecté</span>
                        <p className="text-base font-black text-brand uppercase">{extractedData.containerNumber || 'Non défini'}</p>
                     </div>
                     <div>
                        <span className="text-micro font-black text-text-muted uppercase tracking-[0.2em] block mb-1">Type de Document</span>
                        <p className="text-base font-black text-slate-800 uppercase">{getCatLabel(extractedData.docType)}</p>
                     </div>
                     <div>
                        <span className="text-micro font-black text-text-muted uppercase tracking-[0.2em] block mb-2">Produits</span>
                        <div className="space-y-2">
                           {extractedData.products?.map((p: any, i: number) => {
                               const isNewProduct = !existingProductNames.has((p.name || '').toUpperCase());
                               return (
                                <div key={i} className="flex flex-col gap-1">
                                  <div className="flex items-center justify-between bg-white px-4 py-2 rounded-xl border border-border-default">
                                     <span className="text-caption font-black text-text-primary uppercase truncate max-w-[140px]">{p.name}</span>
                                     <span className="text-caption font-black text-brand">{p.quantity} CTN</span>
                                  </div>
                                  {isNewProduct && (
                                    <div className="flex items-center gap-1.5 px-2">
                                       <AlertTriangle size={10} className="text-amber-500" />
                                       <span className="text-micro font-black text-amber-600 uppercase tracking-widest">Article non détecté dans l'historique</span>
                                    </div>
                                  )}
                                </div>
                               );
                            })}
                        </div>
                     </div>
                  </div>

                  {!showDepotSelect ? (
                    <div className="grid grid-cols-1 gap-3">
                       <div className="bg-brand/5 p-4 rounded-xl border border-brand/10 mb-2">
                          <p className="text-label font-black text-brand uppercase tracking-widest mb-1">Résumé Extraction</p>
                          <p className="text-caption font-black text-slate-800 uppercase">
                            {extractedData.products?.[0]?.name || 'Produit'} - {extractedData.products?.[0]?.quantity || 0} CTN
                          </p>
                       </div>
                       <button 
                         disabled={isProcessing}
                         onClick={() => confirmStockAction('nouveau')} 
                         className="w-full py-5 bg-brand-dark text-white rounded-2xl font-black uppercase text-caption tracking-widest shadow-xl disabled:opacity-50"
                       >
                          {isProcessing ? "TRAITEMENT..." : "CRÉER NOUVEAU STOCK"}
                       </button>
                       <button 
                         disabled={isProcessing}
                         onClick={() => setShowDepotSelect(true)} 
                         className="w-full py-5 bg-white text-brand border-2 border-brand rounded-2xl font-black uppercase text-caption tracking-widest shadow-lg disabled:opacity-50"
                       >
                          AJOUTER À UN DÉPÔT EXISTANT
                       </button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                       <h4 className="text-label font-black text-brand uppercase tracking-widest text-center">Choisir Dépôt Destination</h4>
                       <div className="grid grid-cols-2 gap-2">
                          {depots.map((d: any) => (
                             <button 
                                key={d.id} 
                                disabled={isProcessing}
                                onClick={() => confirmStockAction('depot', d.id)} 
                                className="p-4 bg-surface-subtle hover:bg-brand/5 border border-border-default rounded-xl text-left transition-colors disabled:opacity-50"
                             >
                                <p className="text-caption font-black text-text-primary uppercase tracking-tight truncate">{d.name}</p>
                                <p className="text-micro font-bold text-text-muted mt-0.5 uppercase tracking-widest">{d.type}</p>
                             </button>
                          ))}
                       </div>
                       <button onClick={() => setShowDepotSelect(false)} className="w-full text-label font-black text-text-muted uppercase mt-2">Retour au résumé</button>
                    </div>
                  )}
               </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* IA ERROR MODAL */}
      <AnimatePresence>
        {analysisError && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-brand-ink/60 backdrop-blur-sm z-[220]" onClick={() => setAnalysisError(null)} />
            <motion.div 
               initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
               className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-[360px] bg-white rounded-[2.5rem] p-8 z-[230] shadow-2xl border-t-4 border-red-500"
            >
               <div className="flex flex-col items-center text-center">
                  <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mb-4">
                     <AlertTriangle size={32} />
                  </div>
                  <h3 className="text-lg font-black text-text-primary uppercase tracking-tight mb-2">{analysisError.message}</h3>
                  <p className="text-xs text-text-muted mb-6 px-2">{analysisError.detail}</p>
                  
                  <div className="space-y-3 w-full">
                     <button 
                       onClick={() => {
                         setAnalysisError(null);
                         setIsManualEntry(true);
                       }}
                       className="w-full py-4 bg-brand-dark text-white rounded-2xl font-black uppercase text-caption tracking-widest shadow-xl"
                     >
                       Saisie Manuelle
                     </button>
                     <button 
                       onClick={() => setAnalysisError(null)}
                       className="w-full py-4 bg-surface-subtle text-text-muted rounded-2xl font-black uppercase text-caption tracking-widest"
                     >
                       Réessayer le Scan
                     </button>
                  </div>
               </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* MANUAL ENTRY MODAL */}
      <AnimatePresence>
        {isManualEntry && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-brand-ink/80 backdrop-blur-md z-[200]" onClick={() => setIsManualEntry(false)} />
            <motion.div 
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} 
              className="fixed bottom-0 left-0 w-full bg-white rounded-t-[3rem] p-8 z-[210] shadow-2xl flex flex-col max-h-[90vh]"
            >
               <div className="w-12 h-1 bg-surface-subtle rounded-full mx-auto mb-6" />
               <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                     <div className="w-10 h-10 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center">
                        <Plus size={20} />
                     </div>
                     <h3 className="text-lg font-black text-text-primary uppercase tracking-tight">Saisie Manuelle DEPOTEK</h3>
                  </div>
                  <button onClick={() => setIsManualEntry(false)} className="w-10 h-10 bg-surface-subtle rounded-xl flex items-center justify-center text-text-muted">
                     <X size={20} />
                  </button>
               </div>

               <div className="flex-1 overflow-y-auto no-scrollbar space-y-5 pb-6">
                  <div className="space-y-4">
                     <div className="space-y-1.5">
                        <label className="text-micro font-black text-text-muted uppercase tracking-widest px-1">Produit / Désignation</label>
                        <input 
                          type="text" 
                          value={manualForm.productName}
                          onChange={e => setManualForm(prev => ({...prev, productName: e.target.value}))}
                          className="w-full bg-surface-subtle border border-border-default rounded-2xl p-4 text-sm font-black text-text-primary outline-none focus:border-amber-500/30 uppercase"
                          placeholder="Ex: BUFFALO MEAT"
                        />
                     </div>
                     <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                           <label className="text-micro font-black text-text-muted uppercase tracking-widest px-1">Quantité (Cartons)</label>
                           <input 
                             type="number" 
                             value={manualForm.quantity}
                             onChange={e => setManualForm(prev => ({...prev, quantity: e.target.value}))}
                             className="w-full bg-surface-subtle border border-border-default rounded-2xl p-4 text-sm font-black text-text-primary outline-none focus:border-amber-500/30"
                             placeholder="0"
                           />
                        </div>
                        <div className="space-y-1.5">
                           <label className="text-micro font-black text-text-muted uppercase tracking-widest px-1">N° Conteneur</label>
                           <input 
                             type="text" 
                             value={manualForm.container}
                             onChange={e => setManualForm(prev => ({...prev, container: e.target.value.toUpperCase()}))}
                             className="w-full bg-surface-subtle border border-border-default rounded-2xl p-4 text-sm font-black text-text-primary outline-none focus:border-amber-500/30 uppercase"
                             placeholder="MSCU1234567"
                           />
                        </div>
                     </div>
                     <div className="space-y-1.5">
                        <label className="text-micro font-black text-text-muted uppercase tracking-widest px-1">Type de Document</label>
                        <select 
                          value={manualForm.docType}
                          onChange={e => setManualForm(prev => ({...prev, docType: e.target.value}))}
                          className="w-full bg-surface-subtle border border-border-default rounded-2xl p-4 text-sm font-black text-text-primary outline-none focus:border-amber-500/30 appearance-none uppercase"
                        >
                           <option value="invoice">Facture COMMERCIALE</option>
                           <option value="sanitary_certificate">Certificat SANITAIRE</option>
                           <option value="bill_of_lading">Bill of Lading (BL)</option>
                           <option value="packing_list">Packing List</option>
                        </select>
                     </div>
                  </div>

                  {!showDepotSelect ? (
                    <button 
                      disabled={isProcessing || !manualForm.productName || !manualForm.quantity}
                      onClick={() => setShowDepotSelect(true)} 
                      className="w-full py-5 bg-brand-dark text-white rounded-2xl font-black uppercase text-caption tracking-widest shadow-xl disabled:opacity-50"
                    >
                       Choisir Dépôt & Valider
                    </button>
                  ) : (
                    <div className="space-y-4">
                       <h4 className="text-label font-black text-amber-600 uppercase tracking-widest text-center">Destination : {manualForm.productName}</h4>
                       <div className="grid grid-cols-2 gap-2">
                          {depots.map((d: any) => (
                             <button 
                                key={d.id} 
                                disabled={isProcessing}
                                onClick={() => confirmStockAction('depot', d.id)} 
                                className="p-4 bg-surface-subtle hover:bg-amber-50 border border-border-default rounded-xl text-left transition-colors disabled:opacity-50"
                             >
                                <p className="text-caption font-black text-text-primary uppercase tracking-tight truncate">{d.name}</p>
                                <p className="text-micro font-bold text-text-muted mt-0.5 uppercase tracking-widest">{d.type}</p>
                             </button>
                          ))}
                       </div>
                       <button onClick={() => setShowDepotSelect(false)} className="w-full text-label font-black text-text-muted uppercase mt-2">Retour au formulaire</button>
                    </div>
                  )}
               </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* SUCCESS OVERLAY */}
      <AnimatePresence>
        {showSuccess && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-white z-[500] flex flex-col items-center justify-center p-8 text-center"
          >
             <motion.div 
               initial={{ scale: 0.5, rotate: -10 }} animate={{ scale: 1, rotate: 0 }}
               className="w-32 h-32 bg-green-500 rounded-full flex items-center justify-center text-white mb-8 shadow-2xl shadow-green-500/40"
             >
                <CheckCircle2 size={64} />
             </motion.div>
             <h2 className="text-3xl font-black text-text-primary uppercase tracking-tighter mb-4">Stock Enregistré !</h2>
             <p className="text-text-muted font-bold uppercase tracking-widest text-sm max-w-[240px]">
               Entrée validée DEPOTEK Hub. Redirection...
             </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FAB: ACTION CENTER (Matching Dashboard) */}
      <div className="fixed bottom-24 right-6 flex flex-col items-end gap-3 z-[190]">
         <AnimatePresence>
            {isFabOpen && (
               <motion.div 
                 initial={{ opacity: 0, y: 10, scale: 0.9 }}
                 animate={{ opacity: 1, y: 0, scale: 1 }}
                 exit={{ opacity: 0, y: 10, scale: 0.9 }}
                 className="flex flex-col items-end gap-4 mb-3"
               >
                  <FabOption label="Sortie" icon={<ArrowUpRight size={20} />} onClick={() => onNavigate('MovementForm')} color="bg-orange-500" />
                  <FabOption label="Entrée" icon={<Plus size={20} />} onClick={() => onNavigate('MovementForm')} color="bg-brand" />
                  <FabOption label="Inventaire" icon={<Box size={20} />} onClick={() => onNavigate('inventaire')} color="bg-brand-dark" />
               </motion.div>
            )}
         </AnimatePresence>

         <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setIsFabOpen(!isFabOpen)}
            className={cn(
              "w-16 h-16 rounded-full shadow-2xl flex items-center justify-center border-[5px] border-white transition-all shadow-[#1a237e]/30 z-[200]",
              isFabOpen ? "bg-brand-dark text-white rotate-45" : "bg-brand text-white"
            )}
         >
            <Plus size={32} strokeWidth={3} />
         </motion.button>
      </div>

      {/* VALIDATION MODAL */}
      <AnimatePresence>
        {validationModal.open && validationModal.track && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-brand-ink/40 backdrop-blur-sm z-[250]" onClick={() => setValidationModal({ open: false, track: null })} />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-[400px] bg-white rounded-[2.5rem] p-8 z-[260] shadow-2xl border border-border-default"
            >
               <div className="flex flex-col items-center text-center">
                  <div className={cn(
                    "w-20 h-20 rounded-full flex items-center justify-center mb-6",
                    (docStatusMap[validationModal.track.numeroConteneur]?.hasInvoice && docStatusMap[validationModal.track.numeroConteneur]?.hasSanitary) 
                      ? "bg-green-100 text-green-600" 
                      : "bg-amber-100 text-amber-600"
                  )}>
                     {(docStatusMap[validationModal.track.numeroConteneur]?.hasInvoice && docStatusMap[validationModal.track.numeroConteneur]?.hasSanitary) 
                        ? <CheckCircle2 size={40} /> 
                        : <AlertTriangle size={40} />
                     }
                  </div>
                  
                  <h3 className="text-xl font-black text-text-primary uppercase tracking-tight mb-2">VALIDER RÉCEPTION</h3>
                  <p className="text-sm font-black text-brand uppercase mb-6">{validationModal.track.numeroConteneur}</p>
                  
                  <div className="w-full bg-surface-subtle p-6 rounded-2xl space-y-4 mb-8 text-left">
                     <div className="flex items-center justify-between">
                        <span className="text-label font-black text-text-muted uppercase tracking-widest">Conformité Documents</span>
                        <span className={cn(
                          "text-label font-black uppercase tracking-widest",
                          (docStatusMap[validationModal.track.numeroConteneur]?.hasInvoice && docStatusMap[validationModal.track.numeroConteneur]?.hasSanitary)
                            ? "text-green-600"
                            : "text-amber-600"
                        )}>
                           {(docStatusMap[validationModal.track.numeroConteneur]?.hasInvoice && docStatusMap[validationModal.track.numeroConteneur]?.hasSanitary)
                             ? "100% (COMPLET)"
                             : "ATTENTION : INCOMPLET"
                           }
                        </span>
                     </div>
                     <div className="space-y-2">
                        <div className="flex items-center gap-3">
                           <div className={cn("w-2 h-2 rounded-full", docStatusMap[validationModal.track.numeroConteneur]?.hasInvoice ? "bg-green-500" : "bg-red-500")} />
                           <span className="text-caption font-black text-slate-700 uppercase tracking-tight">Facture Commerciale</span>
                        </div>
                        <div className="flex items-center gap-3">
                           <div className={cn("w-2 h-2 rounded-full", docStatusMap[validationModal.track.numeroConteneur]?.hasSanitary ? "bg-green-500" : "bg-red-500")} />
                           <span className="text-caption font-black text-slate-700 uppercase tracking-tight">Certificat Sanitaire</span>
                        </div>
                     </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 w-full">
                     <button 
                       onClick={() => setValidationModal({ open: false, track: null })}
                       className="py-4 bg-surface-subtle text-text-muted rounded-2xl font-black uppercase text-label tracking-widest"
                     >
                        ANNULER
                     </button>
                     <button 
                        onClick={() => {
                          if (validationModal.track) {
                            processReception(validationModal.track);
                          }
                        }}
                       className="py-4 bg-brand-dark text-white rounded-2xl font-black uppercase text-label tracking-widest shadow-lg"
                     >
                        CONFIRMER
                     </button>
                  </div>
               </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

const TrackingItemCard = ({ track, onToggle, isExpanded, missingDocs, onReceptionClick }: { track: TrackingData, onToggle: () => void, isExpanded: boolean, missingDocs?: boolean, onReceptionClick?: () => void }) => {
  const carrier = detectCarrier(track.numeroConteneur || '');
  const carrierColor = carrier?.color || '#666';
  const carrierName = carrier?.name || 'UNKNOWN';

  const canReceive = track.statut === 'at_port' || track.statut === 'arrived' || track.statut === 'customs_clearance';

  const handleTrackClick = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const { url, carrier } = getTrackingUrl(track.numeroConteneur || '');
    await trackingService.logTrackingAction(track.numeroConteneur || '', carrier);
    window.open(url, '_blank');
  };

  return (
    <div 
      className={cn(
        "flex-none w-[170px] bg-white rounded-2xl p-4 shadow-sm border border-border-default relative group transition-all",
        missingDocs ? "border-red-200 bg-red-50/10" : ""
      )}
      style={carrier ? { borderBottom: `3px solid ${carrierColor}`, borderBottomRightRadius: '8px', borderBottomLeftRadius: '8px' } : {}}
    >
       <div 
         onClick={() => handleTrackClick()}
         className="cursor-pointer"
       >
          <div className="flex items-center justify-between mb-3">
             <div 
               className={cn("w-10 h-10 rounded-xl flex items-center justify-center", missingDocs ? "bg-red-500 text-white shadow-lg animate-pulse" : "")}
               style={!missingDocs ? { backgroundColor: `${carrierColor}15`, color: carrierColor } : {}}
             >
                {missingDocs ? <AlertTriangle size={20} /> : <Ship size={20} />}
             </div>
             
             {canReceive && onReceptionClick && (
               <button 
                 onClick={(e) => {
                   e.stopPropagation();
                   onReceptionClick();
                 }}
                 className="w-8 h-8 bg-green-500 text-white rounded-lg flex items-center justify-center shadow-lg shadow-green-500/20 active:scale-95 transition-all"
               >
                 <CheckCircle2 size={18} />
               </button>
             )}
          </div>
          
          <p className="text-caption font-black text-text-primary truncate uppercase tracking-tight leading-none mb-1">{track.numeroConteneur}</p>
          
          <div 
            className="inline-flex px-1.5 py-0.5 rounded-md mb-3"
            style={{ backgroundColor: `${carrierColor}20` }}
          >
             <span className="text-micro font-black uppercase tracking-widest truncate" style={{ color: carrierColor }}>
                {carrierName}
             </span>
          </div>
       </div>
       
       <div className="flex items-center justify-between">
          <button 
            onClick={onToggle}
            className="text-micro font-black text-text-muted uppercase tracking-widest hover:text-brand"
          >
             {isExpanded ? 'OK' : 'DOCS'}
          </button>
          
          <button 
            onClick={handleTrackClick}
            className="text-micro font-black uppercase tracking-widest"
            style={{ color: carrierColor }}
          >
             TRACK →
          </button>
       </div>

       {/* TIMELINE EXPAND */}
       <AnimatePresence>
          {isExpanded && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              className="mt-4 pt-3 border-t border-border-default space-y-3 overflow-hidden"
            >
               {track.historiqueMilestones?.slice(0, 3).map((m, i) => (
                 <div key={i} className="flex gap-2.5 relative">
                    <div className="w-1 h-full absolute left-[3.5px] top-2 border-l border-border-default" />
                    <div className="w-2 h-2 bg-slate-200 rounded-full mt-1 shrink-0 bg-brand" />
                    <div className="min-w-0">
                       <p className="text-micro font-black text-text-primary uppercase tracking-tighter leading-none mb-0.5">{m.status}</p>
                       <p className="text-micro font-bold text-text-muted uppercase tracking-tighter truncate w-[130px]">{m.location}</p>
                    </div>
                 </div>
               ))}
               <p className="text-micro font-black text-center text-brand/40 uppercase tracking-widest pt-1 cursor-pointer" onClick={onToggle}>Réduire</p>
            </motion.div>
          )}
       </AnimatePresence>
    </div>
  );
};

const NavItem = ({ icon, label, active = false, badge, onClick }: any) => (
  <button onClick={onClick} className={cn(
    "flex flex-col items-center gap-1 transition-all relative",
    active ? "text-brand" : "text-text-muted"
  )}>
    <div className={cn("p-1 transition-all", active ? "scale-110" : "")}>{icon}</div>
    {badge !== undefined && (
      <span className="absolute -top-1 right-0 min-w-[16px] h-[16px] bg-red-500 text-white text-micro font-black rounded-full flex items-center justify-center border border-white px-0.5 shadow-sm">
        {badge}
      </span>
    )}
    <span className="text-micro font-black uppercase tracking-widest pt-0.5">{label}</span>
  </button>
);

const getCatLabel = (cat: string) => {
  switch(cat) {
    case 'invoice': return 'Facture';
    case 'bill_of_lading': return 'B-Lading';
    case 'sanitary_certificate': return 'Sani.';
    case 'temperature_log': return 'Temp.';
    case 'customs': return 'Douane';
    case 'packing_list': return 'Packing';
    default: return 'Autre';
  }
};

const getDocColor = (cat: any) => {
  switch(cat) {
    case 'invoice': return 'bg-blue-50 text-blue-500';
    case 'bill_of_lading': return 'bg-amber-50 text-amber-500';
    case 'sanitary_certificate': return 'bg-green-50 text-green-500';
    case 'customs': return 'bg-purple-50 text-purple-500';
    case 'packing_list': return 'bg-orange-50 text-orange-500';
    case 'temperature_log': return 'bg-cyan-50 text-cyan-500';
    default: return 'bg-surface-subtle text-text-secondary';
  }
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
