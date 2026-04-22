import React, { useState, useRef } from 'react';
import { useStock } from '../hooks/useStock';
import { parseDocument, ExtractedData, ExtractedContainer } from '../services/ocrService';
import { FileUp, Loader2, CheckCircle2, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';

interface UploadFlowProps {
  depotId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export const UploadFlow = ({ depotId, onSuccess, onCancel }: UploadFlowProps) => {
  const [phase, setPhase] = useState<'upload' | 'processing' | 'validation'>('upload');
  const [extracted, setExtracted] = useState<ExtractedData | null>(null);
  const [editableContainers, setEditableContainers] = useState<ExtractedContainer[]>([]);
  const { importInvoice } = useStock(depotId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startParsing = async (file: File) => {
    setPhase('processing');
    try {
      const data = await parseDocument(file);
      setExtracted(data);
      setEditableContainers(data.containers);
      setPhase('validation');
    } catch {
      alert("Erreur lors de l'analyse du document. Veuillez réessayer ou saisir manuellement.");
      setPhase('upload');
    }
  };

  const updateContainer = (index: number, updates: Partial<ExtractedContainer>) =>
    setEditableContainers(prev => prev.map((c, i) => i === index ? { ...c, ...updates } : c));

  const removeContainer = (index: number) =>
    setEditableContainers(prev => prev.filter((_, i) => i !== index));

  const addManualContainer = () =>
    setEditableContainers(prev => [...prev, { id: '', cartons: 0, description: extracted?.containers[0]?.description || 'BUFFALO' }]);

  const handleCommit = async () => {
    if (editableContainers.length === 0) { alert("Aucun conteneur à importer."); return; }
    setPhase('processing');
    try {
      await importInvoice({
        invoice_no: `INV-OCR-${Date.now().toString().slice(-6)}`,
        supplier: extracted?.supplier || 'IMPORT OCR',
        product: editableContainers[0].description,
        total_value_usd: 1,
        containers: editableContainers.map(c => ({ id: c.id.toUpperCase(), cartons: Number(c.cartons), kg: c.weight_kg }))
      }, depotId);
      onSuccess();
    } catch {
      alert("Erreur lors de la création du stock.");
      setPhase('validation');
    }
  };

  const inputClass = "w-full bg-surface-card border border-border-default rounded-2xl p-3 text-body font-black text-brand-ink focus:ring-2 focus:ring-brand/20 outline-none";

  return (
    <div className="bg-surface-card rounded-[40px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <div className="p-8 pb-4 border-b border-border-default flex items-center justify-between">
        <div>
          <h2 className="text-title font-black text-brand-ink tracking-tight">Importer Document</h2>
          <p className="text-label font-black text-text-muted uppercase tracking-widest mt-1">OCR Intelligent • DEPOTEK</p>
        </div>
        <button onClick={onCancel} className="text-text-muted hover:text-status-danger transition-colors">
          <Trash2 size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <AnimatePresence mode="wait">
          {phase === 'upload' && (
            <motion.div key="upload" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center justify-center py-12">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-64 border-4 border-dashed border-border-default rounded-[40px] flex flex-col items-center justify-center gap-6 cursor-pointer hover:border-brand hover:bg-brand-tint/20 transition-all group"
              >
                <div className="w-20 h-20 bg-surface-subtle rounded-3xl flex items-center justify-center text-text-muted group-hover:bg-brand group-hover:text-white transition-all">
                  <FileUp size={32} />
                </div>
                <div className="text-center">
                  <p className="text-body font-black text-brand-ink uppercase tracking-tight">Déposer le document ici</p>
                  <p className="text-label font-bold text-text-muted uppercase tracking-widest mt-2">PDF, JPG ou PNG (Packing List / Invoice)</p>
                </div>
              </div>
              <input type="file" ref={fileInputRef} onChange={e => { const f = e.target.files?.[0]; if (f) startParsing(f); }} hidden accept=".pdf,image/*" />
            </motion.div>
          )}

          {phase === 'processing' && (
            <motion.div key="processing" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
              className="flex flex-col items-center justify-center py-24 gap-8">
              <div className="relative">
                <div className="w-24 h-24 border-8 border-brand-tint rounded-full" />
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
                  className="w-24 h-24 border-8 border-transparent border-t-brand rounded-full absolute top-0" />
                <div className="absolute inset-0 flex items-center justify-center text-brand">
                  <Loader2 size={32} className="animate-spin" />
                </div>
              </div>
              <div className="text-center">
                <h3 className="text-title font-black text-brand-ink uppercase tracking-tight">Analyse en cours...</h3>
                <p className="text-label font-black text-text-muted uppercase tracking-[0.2em] mt-2 animate-pulse">Extraction des conteneurs via OCR</p>
              </div>
            </motion.div>
          )}

          {phase === 'validation' && (
            <motion.div key="validation" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-6 pb-10">
              <div className="bg-brand-tint/30 p-4 rounded-3xl flex items-center gap-4 border border-brand/10">
                <div className="w-12 h-12 bg-surface-card rounded-2xl flex items-center justify-center text-brand shadow-sm">
                  <CheckCircle2 size={24} />
                </div>
                <div>
                  <h4 className="text-caption font-black text-brand-ink uppercase">Extraction Terminée</h4>
                  <p className="text-label font-bold text-text-secondary uppercase tracking-widest">{editableContainers.length} conteneurs détectés</p>
                </div>
              </div>

              <div className="space-y-3">
                {editableContainers.map((container, idx) => (
                  <motion.div key={idx} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 }}
                    className="p-5 bg-surface-subtle rounded-[28px] border border-border-default relative group">
                    <button onClick={() => removeContainer(idx)}
                      className="absolute -top-2 -right-2 w-8 h-8 bg-surface-card border border-status-danger/20 text-status-danger rounded-full flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transition-opacity">
                      <Plus size={16} className="rotate-45" />
                    </button>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-micro font-black text-text-muted uppercase tracking-widest px-2">Numéro Conteneur</label>
                        <input value={container.id} onChange={e => updateContainer(idx, { id: e.target.value.toUpperCase() })} className={inputClass} placeholder="MSCU1234567" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-micro font-black text-text-muted uppercase tracking-widest px-2">Cartons</label>
                        <input type="number" value={container.cartons} onChange={e => updateContainer(idx, { cartons: parseInt(e.target.value) || 0 })} className={inputClass} placeholder="0" />
                      </div>
                    </div>
                    <div className="mt-4 space-y-1">
                      <label className="text-micro font-black text-text-muted uppercase tracking-widest px-2">Produit</label>
                      <input value={container.description} onChange={e => updateContainer(idx, { description: e.target.value })} className={inputClass} placeholder="Description du produit" />
                    </div>
                  </motion.div>
                ))}
                <button onClick={addManualContainer}
                  className="w-full py-4 border-2 border-dashed border-border-default rounded-[28px] text-text-muted font-bold text-caption uppercase tracking-widest flex items-center justify-center gap-2 hover:border-brand hover:text-brand transition-all">
                  <Plus size={16} /> Ajouter un conteneur
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {phase === 'validation' && (
        <div className="p-8 bg-surface-subtle/50 pt-4 border-t border-border-default">
          <button onClick={handleCommit}
            className="w-full py-5 bg-brand-ink text-white rounded-[24px] font-black uppercase tracking-widest text-caption flex items-center justify-center gap-2 shadow-2xl active:scale-95 transition-all">
            Confirmer & Créer <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
};
