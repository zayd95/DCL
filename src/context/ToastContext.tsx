
import React, { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '../lib/utils';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[1000] flex flex-col gap-2 w-full max-w-[400px] px-6 pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
              className={cn(
                "pointer-events-auto flex items-center gap-3 p-4 rounded-2xl shadow-2xl border backdrop-blur-md",
                toast.type === 'success' ? "bg-surface-card border-status-success-bg text-status-success" :
                toast.type === 'error'   ? "bg-surface-card border-status-danger-bg  text-status-danger"  :
                toast.type === 'warning' ? "bg-surface-card border-status-warning-bg text-status-warning" :
                                           "bg-surface-card border-status-info-bg    text-status-info"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-xl flex items-center justify-center shrink-0",
                toast.type === 'success' ? "bg-status-success-bg" :
                toast.type === 'error'   ? "bg-status-danger-bg"  :
                toast.type === 'warning' ? "bg-status-warning-bg" :
                                           "bg-status-info-bg"
              )}>
                {toast.type === 'success' && <CheckCircle size={18} />}
                {toast.type === 'error'   && <AlertCircle size={18} />}
                {toast.type === 'warning' && <AlertCircle size={18} />}
                {toast.type === 'info'    && <Info size={18} />}
              </div>
              <p className="text-caption font-black uppercase tracking-widest flex-1">{toast.message}</p>
              <button
                onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
                className="p-1 hover:bg-surface-subtle rounded-lg transition-colors"
              >
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
};
