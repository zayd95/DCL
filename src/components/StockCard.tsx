
import React, { useState, useRef } from 'react';
import { StockItem, Depot } from '../types';
import { cn } from '../lib/utils';
import { computeStockState } from '../lib/stockService';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, MapPin, ArrowLeftRight, Split, Edit3, Trash2, ArrowDownCircle } from 'lucide-react';
import { useAppStore } from '../store/useStore';

interface StockCardProps {
  item: StockItem;
  depot?: Depot;
}

export const StockCard = ({ item, depot }: StockCardProps) => {
  const { setSelectedLot, setIsEditModalOpen, setIsSplitModalOpen } = useAppStore();
  const [isPressing, setIsPressing]   = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const handleStart = () => {
    setIsPressing(true);
    timerRef.current = setTimeout(() => { setShowOptions(true); setIsPressing(false); }, 800);
  };
  const handleEnd = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsPressing(false);
  };

  const menuActions = [
    { label: 'Modifier',    icon: <Edit3 size={18} />,        action: () => { setSelectedLot(item); setIsEditModalOpen(true);  setShowOptions(false); } },
    { label: 'Diviser',     icon: <Split size={18} />,        action: () => { setSelectedLot(item); setIsSplitModalOpen(true); setShowOptions(false); } },
    { label: 'Transférer',  icon: <ArrowLeftRight size={18} />, action: () => { setShowOptions(false); } },
    { label: 'Abandonner',  icon: <Trash2 size={18} />,       action: () => { setShowOptions(false); }, color: 'text-status-danger' },
  ];

  const state         = computeStockState(item);
  const alertFefo     = state.healthStatus === 'EXPIRED' || state.healthStatus === 'CRITICAL';
  const alertLowStock = state.healthStatus === 'LOW';

  return (
    <div className="relative">
      <motion.div
        animate={isPressing ? { scale: 0.96, opacity: 0.8 } : { scale: 1, opacity: 1 }}
        onMouseDown={handleStart} onMouseUp={handleEnd} onMouseLeave={handleEnd}
        onTouchStart={handleStart} onTouchEnd={handleEnd}
        className={cn(
          "bg-surface-card rounded-[24px] p-5 border-2 transition-all active:shadow-none mb-4 relative overflow-hidden",
          (alertFefo || alertLowStock) ? "border-status-danger bg-status-danger-bg/20" : "border-transparent shadow-sm"
        )}
      >
        {alertFefo && (
          <div className="absolute top-0 right-0 bg-status-danger text-white text-micro font-black px-3 py-1 rounded-bl-xl uppercase tracking-tighter z-10">
            Urgent FEFO
          </div>
        )}
        {alertLowStock && !alertFefo && (
          <div className="absolute top-0 right-0 bg-status-warning text-white text-micro font-black px-3 py-1 rounded-bl-xl uppercase tracking-tighter z-10">
            Stock Bas
          </div>
        )}

        <div className="flex justify-between items-start mb-4">
          <div className="flex items-center gap-3">
            <div className={cn(
              "w-12 h-12 rounded-2xl flex items-center justify-center text-xl shadow-inner",
              (alertFefo || alertLowStock) ? "bg-status-danger-bg text-status-danger" : "bg-brand-tint text-brand"
            )}>
              🥩
            </div>
            <div>
              <h3 className="font-black text-body tracking-tight text-brand-ink uppercase">{item.product}</h3>
              <p className="text-label font-black text-text-muted uppercase tracking-widest mt-0.5">{item.container}</p>
            </div>
          </div>
          <div className="flex flex-col items-end">
            <div className={cn(
              "px-3 py-1 rounded-full text-micro font-black uppercase tracking-widest mb-2 shadow-sm border",
              (alertFefo || alertLowStock)
                ? "bg-status-danger-bg text-status-danger border-status-danger/20"
                : "bg-status-success-bg text-status-success border-status-success/20"
            )}>
              {item.status === 'stored' ? 'En Stock' : item.status === 'quay_pad' ? 'Au Quai' : 'Transit'}
            </div>
            {depot && (
              <div className="flex items-center gap-1 text-micro font-bold text-text-muted capitalize bg-surface-subtle px-2 py-1 rounded-lg">
                <MapPin size={10} /> {depot.name}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 pt-4 border-t border-border-default">
          <div className="text-center relative">
            <p className="text-micro font-black text-text-muted uppercase tracking-widest mb-1">Cartons</p>
            <p className="text-lg font-black text-brand-ink">{item.cartons}</p>
            {item.min_threshold !== undefined && (
              <p className="text-micro font-black text-text-muted uppercase absolute -bottom-4 left-0 right-0">Min: {item.min_threshold}</p>
            )}
          </div>
          <div className="text-center border-x border-border-default">
            <p className="text-micro font-black text-text-muted uppercase tracking-widest mb-1">Âge</p>
            <p className="text-lg font-black text-brand-ink leading-none">{item.aging_days}<span className="text-label ml-1">j</span></p>
          </div>
          <div className="text-center">
            <p className="text-micro font-black text-text-muted uppercase tracking-widest mb-1">CFA (k)</p>
            <p className="text-lg font-black text-brand">{((item.cost_basis || 0) / 1000).toFixed(0)}</p>
          </div>
        </div>

        {(alertFefo || alertLowStock) && (
          <div className={cn(
            "mt-8 flex items-center gap-2 p-2.5 rounded-xl border",
            alertFefo ? "bg-status-danger-bg border-status-danger/20" : "bg-status-warning-bg border-status-warning/20"
          )}>
            {alertFefo
              ? <AlertTriangle size={14} className="text-status-danger" />
              : <ArrowDownCircle size={14} className="text-status-warning" />
            }
            <p className={cn(
              "text-label font-black uppercase tracking-widest",
              alertFefo ? "text-status-danger" : "text-status-warning"
            )}>
              {alertFefo
                ? "Alerte FEFO : Sortie prioritaire"
                : `Alerte Stock Bas : Seuil ${item.min_threshold} atteint`}
            </p>
          </div>
        )}
      </motion.div>

      <AnimatePresence>
        {showOptions && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setShowOptions(false)}
              className="modal-overlay z-[100]"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 10 }}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[85%] bg-surface-card rounded-[32px] p-3 z-[110] shadow-2xl overflow-hidden"
            >
              <div className="p-4 border-b border-border-default mb-2">
                <p className="text-label font-black text-text-muted uppercase tracking-widest mb-1">Actions pour lot</p>
                <p className="text-caption font-black text-brand-ink uppercase truncate">{item.container}</p>
              </div>
              <div className="grid grid-cols-1 gap-1">
                {menuActions.map((action, idx) => (
                  <button
                    key={idx}
                    onClick={action.action}
                    className={cn(
                      "w-full flex items-center gap-4 p-4 rounded-2xl active:bg-surface-subtle transition-colors",
                      action.color || "text-brand-ink"
                    )}
                  >
                    <div className="w-10 h-10 bg-surface-subtle rounded-xl flex items-center justify-center">
                      {action.icon}
                    </div>
                    <span className="text-body font-black uppercase tracking-tight">{action.label}</span>
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
