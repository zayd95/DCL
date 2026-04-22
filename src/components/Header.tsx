
import React from 'react';
import { useAppStore } from '../store/useStore';
import { Plus, User, Box, Mic, FileText } from 'lucide-react';
import { cn } from '../lib/utils';
import { motion } from 'framer-motion';

export const Header = ({ onMicClick, onAddDepot, onInvoiceClick }: { onMicClick: () => void, onAddDepot: () => void, onInvoiceClick: () => void }) => {
  const { depots, selectedDepotId, setSelectedDepotId, user } = useAppStore();

  return (
    <header className="sticky top-0 z-50 pt-6 pb-4 px-4 overflow-hidden relative">
      <div className="absolute inset-0 bg-gradient-to-r from-brand-ink to-brand opacity-90 backdrop-blur-xl -z-10" />

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-white/10 rounded-2xl flex items-center justify-center border border-white/20 shadow-inner">
            <Box size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight leading-none text-white">DEPOTEK</h1>
            <p className="text-label font-black text-white/40 uppercase tracking-[0.2em] mt-1">LOGISTICS OS V2</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onMicClick}
            className="w-10 h-10 bg-white/10 rounded-2xl flex items-center justify-center border border-white/10 backdrop-blur-md text-white/60 active:scale-90"
          >
            <Mic size={20} />
          </button>
          <div className="w-10 h-10 bg-white/10 rounded-2xl flex items-center justify-center border border-white/10 backdrop-blur-md overflow-hidden transition-all active:scale-90 cursor-pointer">
            {user?.photoURL ? (
              <img src={user.photoURL} alt="User" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
            ) : (
              <User size={20} className="text-white/60" />
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-2 no-scrollbar -mx-4 px-4 scroll-smooth">
        <button
          onClick={onInvoiceClick}
          className="flex-none bg-brand-tint text-brand px-5 py-3 rounded-2xl text-label font-black uppercase tracking-widest transition-all active:scale-95 flex items-center gap-2 shadow-lg shadow-brand/20 border border-brand/10"
        >
          <FileText size={14} />
          Document
        </button>

        <button
          onClick={() => setSelectedDepotId(null)}
          className={cn(
            "flex-none px-6 py-3 rounded-2xl text-label font-black uppercase tracking-widest transition-all duration-300",
            !selectedDepotId
              ? "bg-white text-brand-ink shadow-[0_10px_20px_rgba(255,255,255,0.2)]"
              : "bg-white/5 text-white/40 border border-white/5"
          )}
        >
          Global
        </button>

        {depots.map((depot) => (
          <button
            key={depot.id}
            onClick={() => setSelectedDepotId(depot.id)}
            className={cn(
              "flex-none px-6 py-3 rounded-2xl text-label font-black uppercase tracking-widest transition-all duration-300 relative overflow-hidden",
              selectedDepotId === depot.id
                ? "bg-white text-brand-ink shadow-[0_10px_20px_rgba(255,255,255,0.2)]"
                : "bg-white/5 text-white/40 border border-white/5"
            )}
          >
            {selectedDepotId === depot.id && (
              <motion.div
                layoutId="activeTabGlow"
                className="absolute inset-0 bg-white"
                initial={false}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            )}
            <span className="relative z-10">{depot.name}</span>
          </button>
        ))}

        <button
          onClick={onAddDepot}
          className="flex-none w-11 h-11 bg-white/10 rounded-2xl flex items-center justify-center text-white/60 border border-dashed border-white/30 transition-all active:scale-90"
        >
          <Plus size={20} />
        </button>
      </div>
    </header>
  );
};
