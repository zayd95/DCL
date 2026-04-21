
import React, { useState, useRef, useEffect } from 'react';
import { StockItem, Depot } from '../types';
import { cn, formatCFA, isFefoAlert, isLowStockAlert } from '../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  AlertTriangle, 
  MapPin, 
  ArrowLeftRight, 
  Split, 
  Edit3, 
  Trash2,
  Clock,
  MoreVertical,
  ArrowDownCircle
} from 'lucide-react';
import { useAppStore } from '../store/useStore';

interface StockCardProps {
  item: StockItem;
  depot?: Depot;
}

export const StockCard = ({ item, depot }: StockCardProps) => {
  const { setSelectedLot, setIsEditModalOpen, setIsSplitModalOpen, setSelectedDepotId } = useAppStore();
  const [isPressing, setIsPressing] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const handleStart = () => {
    setIsPressing(true);
    timerRef.current = setTimeout(() => {
      setShowOptions(true);
      setIsPressing(false);
      // Haptic feedback could be added here if supported
    }, 800);
  };

  const handleEnd = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsPressing(false);
  };

  const menuActions = [
    { label: 'Modifier', icon: <Edit3 size={18} />, action: () => { setSelectedLot(item); setIsEditModalOpen(true); setShowOptions(false); } },
    { label: 'Diviser', icon: <Split size={18} />, action: () => { setSelectedLot(item); setIsSplitModalOpen(true); setShowOptions(false); } },
    { label: 'Transférer', icon: <ArrowLeftRight size={18} />, action: () => { /* Handle transfer launch */ setShowOptions(false); } },
    { label: 'Abandonner', icon: <Trash2 size={18} />, action: () => { /* Handle cancel */ setShowOptions(false); }, color: 'text-red-500' },
  ];

  const alertFefo = isFefoAlert(item);
  const alertLowStock = isLowStockAlert(item);

  return (
    <div className="relative">
      <motion.div
        animate={isPressing ? { scale: 0.96, opacity: 0.8 } : { scale: 1, opacity: 1 }}
        onMouseDown={handleStart}
        onMouseUp={handleEnd}
        onMouseLeave={handleEnd}
        onTouchStart={handleStart}
        onTouchEnd={handleEnd}
        className={cn(
          "bg-white rounded-[24px] p-5 shadow-[0_4px_20px_rgba(0,0,0,0.05)] border-2 transition-all active:shadow-none mb-4 relative overflow-hidden",
          (alertFefo || alertLowStock) ? "border-red-400 bg-red-50/20" : "border-transparent"
        )}
      >
        {alertFefo && (
          <div className="absolute top-0 right-0 bg-red-500 text-white text-[8px] font-black px-3 py-1 rounded-bl-xl uppercase tracking-tighter z-10">
            Urgent FEFO
          </div>
        )}
        {alertLowStock && !alertFefo && (
          <div className="absolute top-0 right-0 bg-orange-500 text-white text-[8px] font-black px-3 py-1 rounded-bl-xl uppercase tracking-tighter z-10">
            Stock Bas
          </div>
        )}
        <div className="flex justify-between items-start mb-4">
          <div className="flex items-center gap-3">
            <div className={cn(
              "w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-inner",
              (alertFefo || alertLowStock) ? "bg-red-100 text-red-600" : "bg-ocean-soft text-ocean-primary"
            )}>
              🥩
            </div>
            <div>
              <h3 className="font-black text-sm tracking-tight text-[#0A2540] uppercase">{item.product}</h3>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mt-0.5">{item.container}</p>
            </div>
          </div>
          <div className="flex flex-col items-end">
            <div className={cn(
               "px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest mb-2 shadow-sm border",
               (alertFefo || alertLowStock) ? "bg-red-50 text-red-600 border-red-100" : "bg-green-50 text-green-600 border-green-100"
            )}>
              {item.status === 'stored' ? 'En Stock' : item.status === 'quay_pad' ? 'Au Quai' : 'Transit'}
            </div>
            {depot && (
               <div className="flex items-center gap-1 text-[9px] font-bold text-gray-400 capitalize bg-gray-50 px-2 py-1 rounded-lg">
                  <MapPin size={10} /> {depot.name}
               </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 pt-4 border-t border-gray-100">
          <div className="text-center relative">
            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">Cartons</p>
            <p className="text-lg font-black text-[#0A2540]">{item.cartons}</p>
            {item.min_threshold !== undefined && (
              <p className="text-[8px] font-black text-gray-300 uppercase absolute -bottom-4 left-0 right-0">Min: {item.min_threshold}</p>
            )}
          </div>
          <div className="text-center border-x border-gray-100">
            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">Âge</p>
            <p className="text-lg font-black text-[#0A2540] leading-none">{item.aging_days}<span className="text-[10px] ml-1">j</span></p>
          </div>
          <div className="text-center">
            <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1">CFA (k)</p>
            <p className="text-lg font-black text-ocean-primary">{((item.cost_basis || 0) / 1000).toFixed(0)}</p>
          </div>
        </div>

        {(alertFefo || alertLowStock) && (
          <div className={cn(
            "mt-8 flex items-center gap-2 p-2.5 rounded-xl border",
            alertFefo ? "bg-red-50 border-red-100" : "bg-orange-50 border-orange-100"
          )}>
            {alertFefo ? <AlertTriangle size={14} className="text-red-500" /> : <ArrowDownCircle size={14} className="text-orange-500" />}
            <p className={cn(
              "text-[10px] font-black uppercase tracking-widest",
              alertFefo ? "text-red-600" : "text-orange-600"
            )}>
              {alertFefo ? "Alerte FEFO : Sortie prioritaire" : `Alerte Stock Bas : Seuil ${item.min_threshold} atteint`}
            </p>
          </div>
        )}
      </motion.div>

      {/* Context Action Menu Overlay */}
      <AnimatePresence>
        {showOptions && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowOptions(false)}
              className="fixed inset-0 bg-[#0A2540]/60 backdrop-blur-sm z-[100]"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 10 }}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[85%] bg-white rounded-[32px] p-3 z-[110] shadow-2xl overflow-hidden"
            >
              <div className="p-4 border-b border-gray-50 mb-2">
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Actions pour lot</p>
                <p className="text-xs font-black text-[#0A2540] uppercase truncate">{item.container}</p>
              </div>
              <div className="grid grid-cols-1 gap-1">
                {menuActions.map((action, idx) => (
                  <button 
                    key={idx}
                    onClick={action.action}
                    className={cn(
                      "w-full flex items-center gap-4 p-4 rounded-2xl active:bg-gray-50 transition-colors",
                      action.color || "text-[#0A2540]"
                    )}
                  >
                    <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center">
                      {action.icon}
                    </div>
                    <span className="text-sm font-black uppercase tracking-tight">{action.label}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};
