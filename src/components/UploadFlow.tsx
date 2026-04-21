import React, { useState, useRef } from 'react';
import { useStock } from '../hooks/useStock';
import { parseDocument, ExtractedData, ExtractedContainer } from '../services/ocrService';
import { 
  FileUp, 
  Loader2, 
  CheckCircle2, 
  AlertCircle, 
  ChevronRight, 
  Plus, 
  Trash2, 
  Box,
  FileText
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { useAppStore } from '../store/useStore';

interface UploadFlowProps {
  depotId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export const UploadFlow = ({ depotId, onSuccess, onCancel }: UploadFlowProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<'upload' | 'processing' | 'validation'>('upload');
  const [extracted, setExtracted] = useState<ExtractedData | null>(null);
  const [editableContainers, setEditableContainers] = useState<ExtractedContainer[]>([]);
  const { importInvoice } = useStock(depotId);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    startParsing(selectedFile);
  };

  const startParsing = async (selectedFile: File) => {
    setFile(selectedFile);
    setPhase('processing');
    try {
      const data = await parseDocument(selectedFile);
      setExtracted(data);
      setEditableContainers(data.containers);
      setPhase('validation');
    } catch (error) {
      console.error("Parsing error:", error);
      alert("Erreur lors de l'analyse du document. Veuillez réessayer ou saisir manuellement.");
      setPhase('upload');
    }
  };

  const updateContainer = (index: number, updates: Partial<ExtractedContainer>) => {
    setEditableContainers(prev => prev.map((c, i) => i === index ? { ...c, ...updates } : c));
  };

  const removeContainer = (index: number) => {
    setEditableContainers(prev => prev.filter((_, i) => i !== index));
  };

  const addManualContainer = () => {
    setEditableContainers(prev => [...prev, { id: '', cartons: 0, description: extracted?.containers[0]?.description || 'BUFFALO' }]);
  };

  const handleCommit = async () => {
    if (editableContainers.length === 0) {
      alert("Aucun conteneur à importer.");
      return;
    }

    setPhase('processing');
    try {
      await importInvoice({
        invoice_no: `INV-OCR-${Date.now().toString().slice(-6)}`,
        supplier: extracted?.supplier || 'IMPORT OCR',
        product: editableContainers[0].description,
        total_value_usd: 1, // OCR doesn't always find total value easily, using placeholder or could add field
        containers: editableContainers.map(c => ({
          id: c.id.toUpperCase(),
          cartons: Number(c.cartons),
          kg: c.weight_kg
        }))
      }, depotId);
      
      onSuccess();
    } catch (error) {
      alert("Erreur lors de la création du stock.");
      setPhase('validation');
    }
  };

  return (
    <div className="bg-white rounded-[40px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <div className="p-8 pb-4 border-b border-gray-50 flex items-center justify-between">
        <div>
           <h2 className="text-xl font-black text-[#0A2540] tracking-tight">Importer Document</h2>
           <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mt-1">OCR Intelligent • DEPOTEK</p>
        </div>
        <button onClick={onCancel} className="text-gray-400 hover:text-red-500 transition-colors">
          <Trash2 size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
        <AnimatePresence mode="wait">
          {phase === 'upload' && (
            <motion.div 
              key="upload"
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center justify-center py-12"
            >
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-64 border-4 border-dashed border-gray-100 rounded-[40px] flex flex-col items-center justify-center gap-6 cursor-pointer hover:border-ocean-primary hover:bg-ocean-soft/10 transition-all group"
              >
                <div className="w-20 h-20 bg-gray-50 rounded-3xl flex items-center justify-center text-gray-300 group-hover:bg-ocean-primary group-hover:text-white transition-all">
                  <FileUp size={32} />
                </div>
                <div className="text-center">
                   <p className="text-sm font-black text-[#0A2540] uppercase tracking-tight">Déposer le document ici</p>
                   <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-2">PDF, JPG ou PNG (Packing List / Invoice)</p>
                </div>
              </div>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} hidden accept=".pdf,image/*" />
            </motion.div>
          )}

          {phase === 'processing' && (
            <motion.div 
              key="processing"
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
              className="flex flex-col items-center justify-center py-24 gap-8"
            >
              <div className="relative">
                <div className="w-24 h-24 border-8 border-ocean-soft rounded-full" />
                <motion.div 
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
                  className="w-24 h-24 border-8 border-transparent border-t-ocean-primary rounded-full absolute top-0"
                />
                <div className="absolute inset-0 flex items-center justify-center text-ocean-primary">
                   <Loader2 size={32} className="animate-spin" />
                </div>
              </div>
              <div className="text-center">
                 <h3 className="text-lg font-black text-[#0A2540] uppercase tracking-tight">Analyse en cours...</h3>
                 <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mt-2 animate-pulse">Extraction des conteneurs via OCR</p>
              </div>
            </motion.div>
          )}

          {phase === 'validation' && (
            <motion.div 
              key="validation"
              initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
              className="space-y-6 pb-10"
            >
              <div className="bg-ocean-soft/30 p-4 rounded-3xl flex items-center gap-4 border border-ocean-primary/10">
                 <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-ocean-primary shadow-sm">
                    <CheckCircle2 size={24} />
                 </div>
                 <div>
                    <h4 className="text-xs font-black text-[#0A2540] uppercase">Extraction Terminée</h4>
                    <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{editableContainers.length} conteneurs détectés</p>
                 </div>
              </div>

              <div className="space-y-3">
                {editableContainers.map((container, idx) => (
                  <motion.div 
                    key={idx}
                    initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 }}
                    className="p-5 bg-gray-50 rounded-[28px] border border-gray-100 relative group"
                  >
                    <button 
                      onClick={() => removeContainer(idx)}
                      className="absolute -top-2 -right-2 w-8 h-8 bg-white border border-red-100 text-red-500 rounded-full flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Plus size={16} className="rotate-45" />
                    </button>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest px-2">Numéro Conteneur</label>
                        <input 
                          value={container.id} 
                          onChange={(e) => updateContainer(idx, { id: e.target.value.toUpperCase() })}
                          className="w-full bg-white border border-gray-100 rounded-2xl p-3 text-sm font-black text-[#0A2540] focus:ring-2 focus:ring-ocean-primary/20 outline-none"
                          placeholder="MSCU1234567"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest px-2">Cartons</label>
                        <input 
                          type="number"
                          value={container.cartons} 
                          onChange={(e) => updateContainer(idx, { cartons: parseInt(e.target.value) || 0 })}
                          className="w-full bg-white border border-gray-100 rounded-2xl p-3 text-sm font-black text-[#0A2540] outline-none"
                          placeholder="0"
                        />
                      </div>
                    </div>
                    
                    <div className="mt-4 space-y-1">
                      <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest px-2">Produit</label>
                      <input 
                        value={container.description} 
                        onChange={(e) => updateContainer(idx, { description: e.target.value })}
                        className="w-full bg-white border border-gray-100 rounded-2xl p-3 text-xs font-black text-[#0A2540] outline-none"
                        placeholder="Description du produit"
                      />
                    </div>
                  </motion.div>
                ))}

                <button 
                  onClick={addManualContainer}
                  className="w-full py-4 border-2 border-dashed border-gray-200 rounded-[28px] text-gray-400 font-bold text-xs uppercase tracking-widest flex items-center justify-center gap-2 hover:border-ocean-primary hover:text-ocean-primary transition-all"
                >
                  <Plus size={16} /> Ajouter un conteneur
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="p-8 bg-gray-50/50 pt-4 flex gap-4 border-t border-gray-50">
         {phase === 'validation' && (
           <>
              <button 
                onClick={handleCommit}
                className="flex-1 py-5 bg-[#0A2540] text-white rounded-[24px] font-black uppercase tracking-widest text-xs flex items-center justify-center gap-2 shadow-2xl active:scale-95 transition-all"
              >
                Confirmer & Créer <ChevronRight size={18} />
              </button>
           </>
         )}
      </div>
    </div>
  );
};
