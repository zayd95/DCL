import React, { useState, useEffect, useMemo } from 'react';
import { 
  ChevronLeft, 
  Search, 
  Filter, 
  FileText, 
  Grid, 
  List, 
  Clock, 
  Calendar, 
  MoreVertical, 
  Download, 
  Trash2,
  Share2,
  Archive,
  Link as LinkIcon,
  Eye,
  Edit3,
  X,
  FileSearch,
  CheckSquare,
  Square,
  FileJson,
  FileDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { db } from '../lib/firebase';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { 
  collection, 
  query, 
  orderBy, 
  onSnapshot, 
  deleteDoc, 
  doc, 
  updateDoc, 
  where, 
  getDocs, 
  serverTimestamp, 
  arrayUnion 
} from 'firebase/firestore';
import { DocumentEntry, DocCategory, ContainerInfo } from '../types';
import { useToast } from '../context/ToastContext';
import { Ship, Plus, Package, Truck, Scan, TrendingUp, Building2, BrainCircuit, Sparkles } from 'lucide-react';
import { analyzeLogisticsDocument } from '../services/geminiService';

export const DocumentLibrary = ({ onBack }: { onBack: () => void }) => {
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'timeline'>('list');
  const [activeCategory, setActiveCategory] = useState<'all' | DocCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeContainers, setActiveContainers] = useState<ContainerInfo[]>([]);
  const [linkingDoc, setLinkingDoc] = useState<DocumentEntry | null>(null);
  const [editingOCRDoc, setEditingOCRDoc] = useState<DocumentEntry | null>(null);
  
  // Selection Logic
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);

  const { showToast } = useToast();

  useEffect(() => {
    const q = query(
      collection(db, 'containers'), 
      where('status', 'in', ['at_sea', 'port_arrival', 'customs_clearance', 'quay_pad', 'stored']),
      orderBy('updatedAt', 'desc')
    );
    const unsub = onSnapshot(q, (snap) => {
      setActiveContainers(snap.docs.map(d => ({ id: d.id, ...d.data() } as ContainerInfo)));
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'document_library'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      setDocuments(snap.docs.map(d => ({ id: d.id, ...d.data() } as DocumentEntry)));
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const filteredDocs = useMemo(() => {
    return documents.filter(doc => {
      const matchesCategory = activeCategory === 'all' || doc.category === activeCategory;
      const q = searchQuery.toLowerCase();
      const ai = doc.extraitsIA;
      const matchesSearch = doc.fileName.toLowerCase().includes(q) || 
                          doc.linkedContainer?.toLowerCase().includes(q) ||
                          ai?.supplier?.toLowerCase().includes(q) ||
                          ai?.containerNumber?.toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [documents, activeCategory, searchQuery]);

  const groupedDocs = useMemo(() => {
    const groups: { [key: string]: DocumentEntry[] } = {};
    filteredDocs.forEach(d => {
      const date = d.createdAt?.toDate?.() || new Date(d.createdAt);
      const label = isToday(date) ? "Aujourd'hui" : 
                    isYesterday(date) ? "Hier" : 
                    "Cette semaine"; // Simplified
      if (!groups[label]) groups[label] = [];
      groups[label].push(d);
    });
    return groups;
  }, [filteredDocs]);

  const handleDelete = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'document_library', id));
      showToast("Document supprimé", "success");
    } catch (err) {
      showToast("Erreur lors de la suppression", "error");
    }
  };

  const handleManualLink = async (container: ContainerInfo) => {
    if (!linkingDoc) return;
    
    try {
      showToast("Liaison en cours...", "info");
      
      // 1. Update Document Entry
      const docRef = doc(db, 'document_library', linkingDoc.id);
      await updateDoc(docRef, {
        linkedContainer: container.containerNumber,
        updatedAt: serverTimestamp()
      });

      // 2. Update Container Entry (Add to linkedDocuments)
      const containerRef = doc(db, 'containers', container.id);
      await updateDoc(containerRef, {
        linkedDocuments: arrayUnion({
          docId: linkingDoc.id,
          fileName: linkingDoc.fileName,
          category: linkingDoc.category,
          downloadURL: linkingDoc.downloadURL
        }),
        updatedAt: serverTimestamp()
      });

      showToast(`Document lié au conteneur ${container.containerNumber}`, "success");
      setLinkingDoc(null);
    } catch (err) {
      console.error("Link Error:", err);
      showToast("Erreur lors de la liaison manuelle", "error");
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedDocIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedDocIds(next);
  };

  const selectAll = () => {
    const allIds = filteredDocs.map(d => d.id);
    setSelectedDocIds(new Set(allIds));
  };

  const clearSelection = () => {
    setSelectedDocIds(new Set());
    setIsSelectionMode(false);
  };

  const exportCSV = () => {
    const selectedDocs = documents.filter(d => selectedDocIds.has(d.id));
    if (selectedDocs.length === 0) return;

    const headers = ['Nom Fichier', 'Catégorie', 'Conteneur Lié', 'Fournisseur', 'N° Facture', 'Quantité', 'Date Création'];
    const rows = selectedDocs.map(d => {
      const ia = d.extraitsIA;
      return [
        `"${d.fileName}"`,
        `"${getCatLabel(d.category)}"`,
        `"${d.linkedContainer || ''}"`,
        `"${ia?.supplier || ''}"`,
        `"${ia?.invoiceNumber || ''}"`,
        `"${ia?.products?.[0]?.quantity || 0}"`,
        `"${d.createdAt?.toDate?.().toLocaleString() || d.createdAt}"`
      ];
    });

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    saveAs(blob, `dakar_coldlink_export_${new Date().getTime()}.csv`);
    showToast(`${selectedDocs.length} métadonnées exportées`, "success");
    clearSelection();
  };

  const exportZip = async () => {
    const selectedDocs = documents.filter(d => selectedDocIds.has(d.id));
    if (selectedDocs.length === 0) return;

    setIsExporting(true);
    showToast("Préparation de l'archive ZIP...", "info");
    const zip = new JSZip();

    try {
      const promises = selectedDocs.map(async (doc) => {
        try {
          const response = await fetch(doc.downloadURL);
          const blob = await response.blob();
          // Avoid duplicate names in zip
          let name = doc.fileName;
          if (!name.toLowerCase().endsWith('.pdf') && doc.fileType?.includes('pdf')) name += '.pdf';
          zip.file(name, blob);
        } catch (err) {
          console.error(`Failed to download ${doc.fileName}`, err);
        }
      });

      await Promise.all(promises);
      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `dakar_coldlink_docs_${new Date().getTime()}.zip`);
      showToast("Archive ZIP téléchargée", "success");
      clearSelection();
    } catch (err) {
      console.error(err);
      showToast("Erreur lors de la création du ZIP", "error");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="h-screen bg-surface-page max-w-[480px] mx-auto relative flex flex-col font-sans overflow-hidden">
      <header className="bg-brand-dark p-6 rounded-b-[40px] shadow-xl relative overflow-hidden sticky top-0 z-50">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl p-6" />
        <div className="flex items-center justify-between relative z-10 mb-6">
          <button onClick={onBack} className="p-2 bg-white/10 rounded-xl text-white transition-colors">
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-xl font-black text-white uppercase tracking-tight leading-none">Archives Docs</h1>
          <div className="flex gap-2">
             <button 
              onClick={() => setIsSelectionMode(!isSelectionMode)}
              className={cn(
                "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
                isSelectionMode ? "bg-white text-brand-dark" : "bg-white/10 text-white/60 hover:text-white"
              )}
             >
                <CheckSquare size={20} />
             </button>
             <button 
              onClick={() => setViewMode(viewMode === 'list' ? 'grid' : viewMode === 'grid' ? 'timeline' : 'list')}
              className="w-10 h-10 bg-white/10 backdrop-blur-md rounded-xl flex items-center justify-center text-white/60 hover:text-white transition-all"
             >
                {viewMode === 'list' ? <List size={20} /> : viewMode === 'grid' ? <Grid size={20} /> : <Clock size={20} />}
             </button>
          </div>
        </div>

        {/* SEARCH BAR */}
        <div className="mb-6 flex items-center gap-3 bg-white/10 backdrop-blur-md p-4 rounded-3xl border border-white/10 focus-within:bg-white/20 transition-all relative z-10">
           <Search size={18} className="text-white/40" />
           <input 
             type="text" 
             placeholder="Conteneur, Fournisseur, Facture..." 
             className="bg-transparent border-none outline-none text-xs font-black text-white w-full placeholder:text-white/30"
             value={searchQuery}
             onChange={(e) => setSearchQuery(e.target.value)}
           />
           {searchQuery && (
             <button onClick={() => setSearchQuery('')} className="p-1">
               <X size={14} className="text-white/40" />
             </button>
           )}
        </div>

        {/* FILTERS */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-2 px-2 pb-1 relative z-10">
           {['all', 'invoice', 'bill_of_lading', 'sanitary_certificate', 'temperature_log', 'customs', 'packing_list'].map(cat => (
             <button
               key={cat}
               onClick={() => setActiveCategory(cat as any)}
               className={cn(
                 "px-6 py-2.5 rounded-2xl text-label font-black uppercase tracking-widest transition-all whitespace-nowrap",
                 activeCategory === cat ? "bg-white text-brand-dark shadow-lg" : "bg-white/10 text-white/50 border border-white/5"
               )}
             >
                {getCatLabel(cat)}
             </button>
           ))}
        </div>
      </header>

      {/* CONTENT */}
      <div className="flex-1 p-6 pb-32 overflow-y-auto no-scrollbar scroll-smooth">
         {loading ? (
            <div className="py-20 text-center text-text-muted">
               <div className="w-10 h-10 border-4 border-border-default border-t-ocean-primary rounded-full animate-spin mx-auto mb-4" />
               <p className="text-label font-black uppercase tracking-widest">Accès aux dossiers...</p>
            </div>
         ) : filteredDocs.length === 0 ? (
            <div className="py-20 text-center opacity-20 flex flex-col items-center">
               <FileSearch size={100} className="mb-6" strokeWidth={1} />
               <p className="text-sm font-black uppercase tracking-widest">Aucun document trouvé</p>
            </div>
         ) : viewMode === 'timeline' ? (
           <div className="space-y-10">
              {Object.entries(groupedDocs).map(([group, docs]) => (
                <div key={group} className="space-y-4">
                   <h3 className="text-label font-black text-text-muted uppercase tracking-[0.3em] pl-4">{group}</h3>
                   <div className="space-y-3">
                      {docs.map(doc => (
                        <DocItem 
                          key={doc.id} 
                          doc={doc} 
                          viewMode="list" 
                          onDelete={() => handleDelete(doc.id)} 
                          onLink={() => setLinkingDoc(doc)} 
                          isSelected={selectedDocIds.has(doc.id)}
                          onSelect={() => toggleSelect(doc.id)}
                          isSelectionMode={isSelectionMode}
                          onOCRClick={() => setEditingOCRDoc(doc)}
                        />
                      ))}
                   </div>
                </div>
              ))}
           </div>
         ) : (
           <div className={cn(
             "space-y-3",
             viewMode === 'grid' ? "grid grid-cols-2 gap-4 space-y-0" : ""
           )}>
              {filteredDocs.map(doc => (
                <DocItem 
                  key={doc.id} 
                  doc={doc} 
                  viewMode={viewMode} 
                  onDelete={() => handleDelete(doc.id)} 
                  onLink={() => setLinkingDoc(doc)}
                  isSelected={selectedDocIds.has(doc.id)}
                  onSelect={() => toggleSelect(doc.id)}
                  isSelectionMode={isSelectionMode}
                  onOCRClick={() => setEditingOCRDoc(doc)}
                />
              ))}
           </div>
         )}
      </div>

      {/* OCR CORRECTION MODAL */}
      <AnimatePresence>
        {editingOCRDoc && (
          <OCRCorrectionModal 
            doc={editingOCRDoc} 
            onClose={() => setEditingOCRDoc(null)} 
            onSave={() => {
              setEditingOCRDoc(null);
              showToast("Données OCR mises à jour", "success");
            }}
          />
        )}
      </AnimatePresence>

      {/* FLOAT ACTION BAR (Selection Mode) */}
      <AnimatePresence>
        {isSelectionMode && selectedDocIds.size > 0 && (
          <motion.div 
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-[440px] bg-brand-ink rounded-3xl p-4 shadow-2xl flex items-center justify-between z-[150] border border-white/10"
          >
             <div className="pl-2">
                <p className="text-label font-black text-white/40 uppercase tracking-widest">Sélection</p>
                <p className="text-sm font-black text-white uppercase">{selectedDocIds.size} Doc{selectedDocIds.size > 1 ? 's' : ''}</p>
             </div>
             
             <div className="flex gap-2">
                <button 
                  onClick={exportZip}
                  disabled={isExporting}
                  className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-white hover:bg-white/20 transition-all disabled:opacity-50"
                  title="Exporter ZIP"
                >
                   {isExporting ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <FileDown size={20} />}
                </button>
                <button 
                  onClick={exportCSV}
                  className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-white hover:bg-white/20 transition-all"
                  title="Exporter CSV"
                >
                   <FileJson size={20} />
                </button>
                <button 
                  onClick={clearSelection}
                  className="w-12 h-12 bg-red-500/20 rounded-2xl flex items-center justify-center text-red-400 hover:bg-red-500/30 transition-all"
                >
                   <X size={20} />
                </button>
             </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* LINKING MODAL */}
      <AnimatePresence>
        {linkingDoc && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              onClick={() => setLinkingDoc(null)}
              className="fixed inset-0 bg-brand-ink/60 backdrop-blur-sm z-[200]" 
            />
            <motion.div 
              initial={{ y: "100%" }} 
              animate={{ y: 0 }} 
              exit={{ y: "100%" }} 
              className="fixed bottom-0 left-0 w-full bg-white rounded-t-[3.5rem] p-8 z-[210] shadow-2xl"
            >
              <div className="w-12 h-1.5 bg-slate-200 rounded-full mx-auto mb-8" />
              <h3 className="text-xl font-black text-text-primary uppercase tracking-tight mb-2">Lier le document</h3>
              <p className="text-xs font-bold text-text-muted uppercase tracking-widest mb-8">{linkingDoc.fileName}</p>
              
              <div className="space-y-3 max-h-[40vh] overflow-y-auto no-scrollbar mb-8">
                 {activeContainers.map(c => (
                   <button 
                    key={c.id}
                    onClick={() => handleManualLink(c)}
                    className="w-full p-4 bg-surface-subtle border border-border-default rounded-2xl flex items-center justify-between group hover:border-brand hover:bg-white transition-all"
                   >
                      <div className="flex items-center gap-3">
                         <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center text-text-muted group-hover:text-brand">
                            <Ship size={16} />
                         </div>
                         <div className="text-left">
                            <div className="text-xs font-black text-text-primary uppercase tracking-tight">{c.containerNumber}</div>
                            <div className="text-label font-bold text-text-muted uppercase tracking-tighter">{c.origin}</div>
                         </div>
                      </div>
                      <Plus size={16} className="text-text-muted group-hover:text-brand" />
                   </button>
                 ))}
              </div>

              <button 
                onClick={() => setLinkingDoc(null)}
                className="w-full py-5 bg-surface-subtle text-text-muted rounded-2xl font-black uppercase text-xs tracking-widest"
              >
                Annuler
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

const DocItem = ({ doc, viewMode, onDelete, onLink, isSelected, onSelect, isSelectionMode, onOCRClick }: { doc: DocumentEntry, viewMode: 'list' | 'grid', onDelete: () => void, onLink: () => void, isSelected?: boolean, onSelect?: () => void, isSelectionMode?: boolean, onOCRClick?: () => void }) => {
  const [showOptions, setShowOptions] = useState(false);
  const data = doc.extraitsIA;

  return (
    <div 
      onClick={() => isSelectionMode && onSelect?.()}
      className={cn(
      "bg-white rounded-3xl border shadow-sm relative group transition-all cursor-pointer",
      isSelected ? "border-brand ring-2 ring-ocean-primary/20" : "border-border-default",
      viewMode === 'grid' ? "p-4 flex flex-col gap-4" : "p-4 flex items-center justify-between gap-4"
    )}>
       <div className={cn(
         "flex items-center gap-4 flex-1",
         viewMode === 'grid' ? "flex-col items-start" : ""
       )}>
          <div className="relative">
             <div className={cn(
                "w-12 h-12 rounded-2xl flex items-center justify-center shrink-0",
                getDocColor(doc.category)
             )}>
                <FileText size={24} />
             </div>
             {isSelectionMode && (
               <div className={cn(
                 "absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center border-2 border-white shadow-sm transition-all",
                 isSelected ? "bg-brand text-white" : "bg-white text-slate-200"
               )}>
                  {isSelected && <CheckSquare size={10} />}
               </div>
             )}
          </div>
          <div className="flex-1 min-w-0">
             <div className="flex items-center gap-2 mb-1">
                <h4 className="text-xs font-black text-text-primary uppercase tracking-tight truncate max-w-[180px]">
                   {doc.fileName}
                </h4>
                <span className="text-micro font-black text-brand bg-surface-subtle px-1.5 py-0.5 rounded-md uppercase">
                   {getCatLabel(doc.category)}
                </span>
             </div>
             {/* SMART LOGISTICS PREVIEW (IA) - PAD HUB SÉNÉGAL */}
             {doc.linkedContainer && data && (
               <div className="mt-3 p-3 bg-surface-subtle/80 rounded-2xl border border-border-default flex flex-col gap-2 shadow-inner">
                 <div className="flex items-baseline justify-between gap-2 overflow-hidden">
                   <div className="flex items-center gap-1.5 shrink-0 overflow-hidden">
                      <Truck size={10} className="text-brand" />
                      <span className="text-micro font-black text-brand-dark uppercase tracking-[0.1em] truncate">
                        {data.containerNumber || doc.linkedContainer}
                      </span>
                   </div>
                   {data.supplier && (
                     <span className="text-micro font-black text-brand uppercase truncate tracking-tighter bg-surface-subtle px-1.5 py-0.5 rounded-md border border-ocean-soft">
                       {data.supplier}
                     </span>
                   )}
                 </div>
                 
                 {data.products && data.products.length > 0 && (
                   <div className="flex items-center gap-2 pt-2 border-t border-border-default/50">
                      <div className="w-5 h-5 bg-white rounded-lg flex items-center justify-center text-brand shadow-sm border border-border-default shrink-0">
                         <Package size={10} />
                      </div>
                      <div className="flex-1 min-w-0">
                         <div className="flex items-center justify-between w-full">
                            <p className="text-micro font-black text-slate-700 truncate uppercase tracking-tight">
                               {data.products[0].name}
                            </p>
                            <span className="text-micro font-black text-brand leading-none shrink-0 tabular-nums">
                               {data.products[0].quantity} CTN
                            </span>
                         </div>
                      </div>
                   </div>
                 )}
               </div>
             )}

             {/* AI EXTRACTED METADATA */}
             {data && (
               <div className="space-y-1">
                 {(data.supplier || data.invoiceNumber) && (
                   <p className="text-micro font-bold text-text-secondary uppercase tracking-tight flex items-center gap-2">
                     {data.supplier && <span className="truncate max-w-[100px]">{data.supplier}</span>}
                     {data.supplier && data.invoiceNumber && <span className="text-slate-200">|</span>}
                     {data.invoiceNumber && <span className="text-text-muted">#{data.invoiceNumber}</span>}
                   </p>
                 )}
                 {data.products && data.products.length > 0 && (
                   <div className="flex flex-wrap gap-1">
                     {data.products.slice(0, 2).map((p: any, i: number) => (
                       <span key={i} className="text-micro font-bold bg-surface-subtle text-text-muted px-1.5 py-0.5 rounded uppercase max-w-[80px] truncate">
                         {p.name}
                       </span>
                     ))}
                     {data.products.length > 2 && (
                       <span className="text-micro font-bold text-text-muted">+{data.products.length - 2}</span>
                     )}
                   </div>
                 )}
               </div>
             )}

             <div className="mt-2 flex items-center gap-2">
                {doc.linkedContainer ? (
                   <div className="flex items-center gap-1.5 px-2 py-0.5 bg-green-50 text-green-600 rounded-md text-micro font-black uppercase">
                      <LinkIcon size={8} /> {doc.linkedContainer}
                   </div>
                ) : (
                   <span className="text-micro font-bold text-amber-500 bg-amber-50 px-2 py-0.5 rounded-md uppercase tracking-tighter">
                      ⚠️ Non lié
                   </span>
                )}
             </div>
          </div>
       </div>

       <div className={cn(
         "flex gap-1",
         viewMode === 'grid' ? "justify-between w-full mt-2" : ""
       )}>
          <button className="p-2 text-text-muted hover:text-brand transition-colors">
             <Eye size={18} />
          </button>
          <div className="relative">
             <button onClick={() => setShowOptions(!showOptions)} className="p-2 text-text-muted">
                <MoreVertical size={18} />
             </button>
             {showOptions && (
               <>
                 <div className="fixed inset-0 z-10" onClick={() => setShowOptions(false)} />
                 <div className="absolute right-0 bottom-full mb-2 w-48 bg-brand-ink text-white rounded-2xl p-2 shadow-2xl z-20 flex flex-col gap-1 overflow-hidden">
                    <OptionItem 
                      icon={<LinkIcon size={14} />} 
                      label={doc.linkedContainer ? "Modifier le lien" : "Lier au conteneur"} 
                      onClick={() => {
                        onLink();
                        setShowOptions(false);
                      }}
                    />
                    {data && (
                      <OptionItem 
                        icon={<Scan size={14} className="text-brand" />} 
                        label="OCR Détails" 
                        onClick={() => {
                          onOCRClick?.();
                          setShowOptions(false);
                        }}
                      />
                    )}
                    <OptionItem 
                      icon={<Edit3 size={14} />} 
                      label="Modifier" 
                      onClick={() => {
                        onOCRClick?.();
                        setShowOptions(false);
                      }}
                    />
                    <OptionItem icon={<Share2 size={14} />} label="Partager" />
                    <OptionItem icon={<Archive size={14} />} label="Archiver" />
                    <button 
                      onClick={onDelete}
                      className="flex items-center gap-3 w-full px-3 py-2 text-red-400 hover:bg-red-500/10 rounded-xl transition-colors text-label font-black uppercase tracking-tight"
                    >
                       <Trash2 size={14} /> Supprimer
                    </button>
                 </div>
               </>
             )}
          </div>
       </div>
    </div>
  );
};

const OptionItem = ({ icon, label, onClick }: any) => (
  <button onClick={onClick} className="flex items-center gap-3 w-full px-3 py-2 hover:bg-white/10 rounded-xl transition-colors text-label font-black uppercase tracking-tight text-white/70 hover:text-white">
     {icon} {label}
  </button>
);

const OCRCorrectionModal = ({ doc: docEntry, onClose, onSave }: { doc: DocumentEntry, onClose: () => void, onSave: () => void }) => {
  const [data, setData] = useState({
    containerNumber: docEntry.extraitsIA?.containerNumber || '',
    quantity: docEntry.extraitsIA?.products?.[0]?.quantity || 0,
    price: docEntry.extraitsIA?.totalValue || 0,
    supplier: docEntry.extraitsIA?.supplier || ''
  });
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const { showToast } = useToast();

  const handleGeminiAnalysis = async () => {
    setAnalyzing(true);
    try {
      showToast("Analyse Gemini en cours...", "info");
      
      // Fetch the file and convert to base64
      const response = await fetch(docEntry.downloadURL);
      const blob = await response.blob();
      
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
      });
      reader.readAsDataURL(blob);
      const base64 = await base64Promise;

      const result = await analyzeLogisticsDocument(base64, blob.type);
      
      if (result) {
        setData({
          containerNumber: result.containerNumber || data.containerNumber,
          quantity: result.products?.[0]?.quantity || data.quantity,
          price: result.totalValue || data.price,
          supplier: result.supplier || data.supplier
        });
        showToast("Analyse terminée avec succès !", "success");
      }
    } catch (err) {
      console.error("Gemini Analysis Failed:", err);
      showToast("L'analyse IA a échoué. Vérifiez votre connexion.", "error");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      const updatedExtraits = {
        ...docEntry.extraitsIA,
        containerNumber: data.containerNumber,
        supplier: data.supplier,
        totalValue: Number(data.price),
        products: docEntry.extraitsIA?.products?.map((p, i) => i === 0 ? { ...p, quantity: Number(data.quantity) } : p) || [{ name: 'Inconnu', quantity: Number(data.quantity) }]
      };

      await updateDoc(doc(db, 'document_library', docEntry.id), {
        extraitsIA: updatedExtraits
      });
      onSave();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-brand-ink/60 backdrop-blur-sm z-[300]" onClick={onClose} />
      <motion.div initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} className="fixed bottom-0 left-0 w-full bg-white rounded-t-[3.5rem] p-8 z-[310] shadow-2xl">
        <div className="w-12 h-1.5 bg-slate-200 rounded-full mx-auto mb-8" />
        <div className="flex items-center justify-between mb-8">
           <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-surface-subtle rounded-2xl flex items-center justify-center text-brand">
                 <Scan size={28} />
              </div>
              <div>
                 <h3 className="text-xl font-black text-text-primary uppercase tracking-tight">Détails IA (OCR)</h3>
                 <p className="text-label font-black text-text-muted uppercase tracking-widest leading-none mt-1">Vérification PAD HUB SÉNÉGAL</p>
              </div>
           </div>
           
           <button 
             onClick={handleGeminiAnalysis}
             disabled={analyzing}
             className={cn(
               "flex items-center gap-2 px-4 py-3 rounded-xl font-black text-label uppercase tracking-wider transition-all",
               analyzing ? "bg-surface-subtle text-text-muted" : "bg-surface-subtle text-brand border border-brand/20 hover:bg-brand hover:text-white"
             )}
           >
             {analyzing ? (
               <div className="w-3 h-3 border-2 border-slate-300 border-t-slate-500 rounded-full animate-spin" />
             ) : (
               <Sparkles size={14} />
             )}
             {analyzing ? "Analyse..." : "Analyser avec Gemini"}
           </button>
        </div>

        <div className="space-y-6 mb-10">
           <div className="space-y-4">
              <InputGroup 
                label="N° Conteneur" 
                icon={<Truck size={14} />} 
                value={data.containerNumber} 
                onChange={(v) => setData(prev => ({ ...prev, containerNumber: v }))} 
              />
              <InputGroup 
                label="Fournisseur" 
                icon={<Building2 size={14} />} 
                value={data.supplier} 
                onChange={(v) => setData(prev => ({ ...prev, supplier: v }))} 
              />
              <div className="grid grid-cols-2 gap-4">
                 <InputGroup 
                    label="Quantité (CTN)" 
                    icon={<Package size={14} />} 
                    value={data.quantity.toString()} 
                    onChange={(v) => setData(prev => ({ ...prev, quantity: Number(v) || 0 }))} 
                    type="number"
                 />
                 <InputGroup 
                    label="Prix Total (CFA)" 
                    icon={<TrendingUp size={14} />} 
                    value={data.price.toString()} 
                    onChange={(v) => setData(prev => ({ ...prev, price: Number(v) || 0 }))} 
                    type="number"
                 />
              </div>
           </div>
        </div>

        <div className="flex gap-3">
           <button onClick={onClose} className="flex-1 py-5 bg-surface-subtle text-text-muted rounded-2xl font-black uppercase text-xs tracking-widest">Annuler</button>
           <button 
             onClick={handleSave} 
             disabled={loading}
             className="flex-[2] py-5 bg-brand text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl shadow-brand/20 flex items-center justify-center gap-2"
           >
              {loading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <CheckSquare size={16} />}
              Sauvegarder
           </button>
        </div>
      </motion.div>
    </>
  );
};

const InputGroup = ({ label, icon, value, onChange, type = "text" }: any) => (
  <div className="space-y-1.5">
     <label className="text-label font-black text-text-muted uppercase tracking-widest ml-1">{label}</label>
     <div className="relative">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-brand opacity-40">
           {icon}
        </div>
        <input 
           type={type}
           value={value}
           onChange={(e) => onChange(e.target.value)}
           className="w-full bg-surface-subtle border border-border-default rounded-2xl p-4 pl-12 text-sm font-black text-text-primary outline-none focus:ring-4 focus:ring-brand/5 transition-all"
        />
     </div>
  </div>
);

const getCatLabel = (cat: string) => {
  switch(cat) {
    case 'all': return 'Tout';
    case 'invoice': return 'Factures';
    case 'bill_of_lading': return 'B/L';
    case 'sanitary_certificate': return 'Sani.';
    case 'temperature_log': return 'Temp.';
    case 'customs': return 'Douane';
    case 'packing_list': return 'Packing';
    default: return 'Autre';
  }
};

const getDocColor = (cat: DocCategory) => {
  switch(cat) {
    case 'invoice': return 'bg-blue-50 text-blue-500';
    case 'bill_of_lading': return 'bg-amber-50 text-amber-500';
    case 'sanitary_certificate': return 'bg-green-50 text-green-500';
    case 'customs': return 'bg-purple-50 text-purple-500';
    default: return 'bg-surface-subtle text-text-secondary';
  }
};

const isToday = (someDate: Date) => {
  const today = new Date();
  return someDate.getDate() === today.getDate() &&
    someDate.getMonth() === today.getMonth() &&
    someDate.getFullYear() === today.getFullYear();
};

const isYesterday = (someDate: Date) => {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  return someDate.getDate() === yesterday.getDate() &&
    someDate.getMonth() === yesterday.getMonth() &&
    someDate.getFullYear() === yesterday.getFullYear();
};
