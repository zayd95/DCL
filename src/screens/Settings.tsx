import React, { useState, useEffect } from 'react';
import { 
  ChevronLeft, 
  Settings as SettingsIcon,
  Bell,
  Mail,
  MessageSquare,
  Smartphone,
  Shield,
  LogOut,
  User,
  CreditCard,
  Target,
  Globe,
  CheckCircle2
} from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '../lib/utils';
import { auth, db } from '../lib/firebase';
import { signOut } from 'firebase/auth';
import { doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { useToast } from '../context/ToastContext';

import { maintenanceService } from '../services/maintenanceService';
import { AlertTriangle, Trash2, RefreshCcw } from 'lucide-react';

import { requestNotificationPermission, initMessageListener } from '../services/PushNotificationService';

export const Settings = ({ onBack }: { onBack: () => void }) => {
  const { showToast } = useToast();
  const [config, setConfig] = useState({
    pushEnabled: true,
    emailEnabled: true,
    smsEnabled: false,
    lowStockThreshold: 10,
    fefoAlertDays: 30,
    adminPhone: '+221',
    userEmail: auth.currentUser?.email || ''
  });
  const [saving, setSaving] = useState(false);
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
  const [resetInput, setResetInput] = useState('');
  const [resetting, setResetting] = useState(false);

  const handleResetData = async () => {
    if (resetInput !== 'RESET') return;
    setResetting(true);
    try {
      await maintenanceService.resetAllData();
      showToast("Toutes les données ont été réinitialisées !", "success");
      setIsResetConfirmOpen(false);
      setResetInput('');
    } catch (err) {
      console.error(err);
      showToast("Échec de la réinitialisation", "error");
    } finally {
      setResetting(false);
    }
  };

  useEffect(() => {
    if (!auth.currentUser) return;
    initMessageListener();
    const unsub = onSnapshot(doc(db, 'settings', auth.currentUser.uid), (snap) => {
      if (snap.exists()) {
        setConfig(prev => ({ ...prev, ...snap.data() }));
      }
    });
    return () => unsub();
  }, []);

  const handleToggle = async (key: keyof typeof config) => {
    if (!auth.currentUser) return;
    const newVal = !config[key as keyof typeof config];
    
    // Logic for Push Permission
    if (key === 'pushEnabled' && newVal) {
      const token = await requestNotificationPermission();
      if (!token) {
        showToast("Permission de notification refusée ou erreur", "error");
        return;
      } else {
        showToast("Notifications Push activées pour ce mobile", "success");
      }
    }

    try {
      await setDoc(doc(db, 'settings', auth.currentUser.uid), { [key]: newVal }, { merge: true });
      // Also update users collection for the server-side notifyAdmins sweep
      if (key === 'pushEnabled') {
        await setDoc(doc(db, 'users', auth.currentUser.uid), { pushNotificationsEnabled: newVal }, { merge: true });
      }
    } catch (err) {
      showToast("Erreur de sauvegarde", "error");
    }
  };

  const handleInputChange = (key: keyof typeof config, val: any) => {
    setConfig(prev => ({ ...prev, [key]: val }));
  };

  const saveConfig = async () => {
    if (!auth.currentUser) return;
    setSaving(true);
    try {
      await setDoc(doc(db, 'settings', auth.currentUser.uid), config, { merge: true });
      showToast("Paramètres mis à jour", "success");
    } catch (err) {
      showToast("Erreur de sauvegarde", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = () => {
    signOut(auth);
  };

  return (
    <div className="h-screen bg-surface-subtle max-w-[480px] mx-auto relative flex flex-col font-sans overflow-y-auto no-scrollbar scroll-smooth pb-40">
      {/* 🚀 PREMIUM COMMANDER HEADER */}
      <header className="flex-none p-6 pb-16 bg-gradient-to-br from-ocean-dark via-ocean-primary to-[#1a237e] text-white relative overflow-hidden">
        {/* Modern abstract patterns */}
        <div className="absolute top-0 right-0 w-80 h-80 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl" />
        <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-accent-gold/10 rounded-full blur-2xl" />
        
        <div className="flex items-center justify-between relative z-10 mb-8 pt-2">
          <button 
            onClick={onBack} 
            className="w-11 h-11 bg-white/10 backdrop-blur-xl rounded-2xl flex items-center justify-center border border-white/10 transition-all active:scale-90 hover:bg-white/20"
          >
            <ChevronLeft size={24} />
          </button>
          <div className="text-center">
            <h1 className="text-xs font-black uppercase tracking-[0.3em] text-white/40 mb-1">Système OS</h1>
            <p className="text-base font-black uppercase tracking-tight">Profil Utilisateur</p>
          </div>
          <div className="w-11 h-11 bg-white/10 backdrop-blur-xl rounded-2xl flex items-center justify-center border border-white/10">
            <SettingsIcon size={20} className="text-white/40" />
          </div>
        </div>

        <div className="flex flex-col items-center text-center relative z-10">
           <div className="relative mb-4">
              <div className="w-24 h-24 rounded-[2.5rem] border-4 border-white/20 overflow-hidden shadow-2xl relative z-10 bg-brand-dark">
                 {auth.currentUser?.photoURL ? (
                    <img src={auth.currentUser.photoURL} alt="User" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                 ) : (
                    <div className="w-full h-full flex items-center justify-center text-white/20">
                       <User size={40} />
                    </div>
                 )}
              </div>
              <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-status-success rounded-xl border-4 border-brand flex items-center justify-center z-20 shadow-lg">
                 <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
              </div>
           </div>
           
           <h2 className="text-2xl font-black tracking-tighter mb-1">{auth.currentUser?.displayName || 'Agent Inconnu'}</h2>
           <p className="text-label font-bold text-white/50 uppercase tracking-[0.2em] mb-4">{config.userEmail}</p>
           
           <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-white/5 backdrop-blur-md rounded-full text-micro font-black uppercase tracking-widest border border-white/10 text-white/80 shadow-inner">
              <Shield size={12} className="text-status-warning" /> 
              <span>Authentification Grade : Enterprise</span>
           </div>
        </div>
      </header>

      <div className="px-5 -mt-8 space-y-5 relative z-20 pb-20">
        
        {/* Section Communications - iOS Style Card */}
        <section className="bg-white/80 backdrop-blur-2xl rounded-[2.5rem] p-6 shadow-2xl shadow-ocean-dark/5 border border-white space-y-5">
           <div className="flex items-center justify-between px-1">
             <h3 className="text-label font-black uppercase tracking-[0.2em] text-text-muted flex items-center gap-2">
               <Bell size={14} className="text-brand/40" /> Communication
             </h3>
             <span className="text-micro font-black text-white bg-status-success px-2 py-0.5 rounded-full uppercase tracking-tighter">Live</span>
           </div>
           
           <div className="space-y-1">
             <ToggleRow icon={<Smartphone className="text-brand" />} label="Logs Push Mobile" active={config.pushEnabled} onToggle={() => handleToggle('pushEnabled')} />
             <div className="h-px bg-surface-subtle mx-4" />
             <ToggleRow icon={<Mail className="text-brand" />} label="Monitoring Email" active={config.emailEnabled} onToggle={() => handleToggle('emailEnabled')} />
             <div className="h-px bg-surface-subtle mx-4" />
             <ToggleRow icon={<MessageSquare className="text-brand" />} label="Passerelle SMS (+221)" active={config.smsEnabled} onToggle={() => handleToggle('smsEnabled')} />
           </div>
        </section>

        {/* Section Paramètres Logistiques - Hardware Styled */}
        <section className="bg-white/80 backdrop-blur-2xl rounded-[2.5rem] p-6 shadow-2xl shadow-ocean-dark/5 border border-white space-y-6">
           <div className="flex items-center justify-between px-1">
             <h3 className="text-label font-black uppercase tracking-[0.2em] text-text-muted flex items-center gap-2">
               <Target size={14} className="text-brand/40" /> Seuils Critique
             </h3>
             <SettingsIcon size={14} className="text-slate-100 animate-spin-slow" />
           </div>

           <div className="space-y-6">
             <div className="space-y-3 bg-surface-subtle/50 p-4 rounded-3xl border border-border-default/50 shadow-inner">
               <div className="flex justify-between items-center px-1">
                 <div className="flex flex-col">
                   <label className="text-label font-black text-brand-dark uppercase tracking-widest mb-0.5">Stock Bas</label>
                   <span className="text-micro font-bold text-text-muted uppercase tracking-tighter leading-none">Alerte Orange</span>
                 </div>
                 <div className="px-3 py-1 bg-white rounded-xl border border-border-default shadow-sm text-caption font-black text-brand">
                    {config.lowStockThreshold}%
                 </div>
               </div>
               <input 
                 type="range" min="5" max="50" step="5" 
                 value={config.lowStockThreshold} 
                 onChange={(e) => handleInputChange('lowStockThreshold', parseInt(e.target.value))}
                 className="w-full h-2 bg-slate-200 rounded-full appearance-none cursor-pointer accent-ocean-primary shadow-inner"
               />
             </div>

             <div className="space-y-3 bg-surface-subtle/50 p-4 rounded-3xl border border-border-default/50 shadow-inner">
               <div className="flex justify-between items-center px-1">
                 <div className="flex flex-col">
                   <label className="text-label font-black text-brand-dark uppercase tracking-widest mb-0.5">FEFO Delta</label>
                   <span className="text-micro font-bold text-text-muted uppercase tracking-tighter leading-none">Anticipation d'expiration</span>
                 </div>
                 <div className="px-3 py-1 bg-white rounded-xl border border-border-default shadow-sm text-caption font-black text-brand">
                    {config.fefoAlertDays}j
                 </div>
               </div>
               <input 
                 type="range" min="7" max="90" step="1" 
                 value={config.fefoAlertDays} 
                 onChange={(e) => handleInputChange('fefoAlertDays', parseInt(e.target.value))}
                 className="w-full h-2 bg-slate-200 rounded-full appearance-none cursor-pointer accent-ocean-primary shadow-inner"
               />
             </div>

             <div className="pt-2">
                <label className="text-micro font-black text-brand-dark uppercase tracking-[0.2em] px-2 mb-2 block">Numéro de passerelle SMS (SN)</label>
                <div className="flex items-center gap-3 bg-surface-subtle p-4 rounded-3xl border border-border-default shadow-inner focus-within:bg-white focus-within:ring-4 focus-within:ring-ocean-primary/5 transition-all">
                   <div className="w-8 h-8 bg-white rounded-xl flex items-center justify-center text-brand shadow-sm">
                      <Globe size={16} />
                   </div>
                   <input 
                     type="tel"
                     value={config.adminPhone}
                     onChange={(e) => handleInputChange('adminPhone', e.target.value)}
                     className="bg-transparent border-none outline-none text-sm font-black text-brand-dark w-full placeholder:text-slate-200"
                     placeholder="+221 ..."
                   />
                </div>
             </div>
           </div>

           <button 
             onClick={saveConfig}
             disabled={saving}
             className="w-full py-5 bg-brand text-white rounded-[2rem] font-black uppercase text-caption tracking-[0.2em] shadow-2xl shadow-brand/30 active:scale-[0.98] transition-all flex items-center justify-center gap-3"
           >
              {saving ? (
                 <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                 <CheckCircle2 size={18} className="text-status-warning" />
              )}
              <span>{saving ? 'Synchronisation...' : 'Appliquer les Paramètres'}</span>
           </button>
        </section>

        {/* Section Danger Zone */}
        <section className="bg-red-50/50 backdrop-blur-md rounded-[2.5rem] p-6 border border-red-100/50 space-y-4">
          <div className="flex items-center gap-2 px-2">
             <AlertTriangle size={14} className="text-red-400" />
             <h3 className="text-label font-black uppercase tracking-[0.2em] text-red-400">Administration Démo</h3>
          </div>
          <p className="text-micro text-text-muted font-medium px-2 leading-relaxed uppercase tracking-tight">
            Suppression massive pour remise à zéro. Ne pas utiliser en production PAD.
          </p>
          <button 
            onClick={() => setIsResetConfirmOpen(true)}
            className="w-full py-4 bg-white text-red-500 rounded-2xl font-black uppercase text-label tracking-widest border border-red-100 shadow-sm hover:bg-red-500 hover:text-white transition-all flex items-center justify-center gap-2"
          >
             <Trash2 size={12} /> Réinitialiser le système
          </button>
        </section>

        {/* Logout - Floating Style */}
        <button 
          onClick={handleLogout}
          className="w-full py-6 flex items-center justify-between px-8 bg-white rounded-[2.5rem] border border-border-default shadow-xl shadow-ocean-dark/5 group active:scale-[0.98] transition-all"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center shadow-inner group-hover:bg-red-500 group-hover:text-white transition-colors">
              <LogOut size={22} />
            </div>
            <div className="text-left">
               <span className="text-body font-black uppercase text-brand-dark tracking-tight block">Fermer la session</span>
               <span className="text-micro font-bold text-text-muted uppercase tracking-widest">Identité : {config.userEmail.split('@')[0]}</span>
            </div>
          </div>
          <ChevronLeft className="rotate-180 text-slate-200 group-hover:text-brand transition-colors" />
        </button>

        <div className="flex flex-col items-center gap-2 pt-4 pb-12 opacity-30">
           <div className="flex items-center gap-3">
              <div className="w-1.5 h-1.5 bg-status-success rounded-full" />
              <p className="text-micro font-black text-brand-dark uppercase tracking-[0.4em]">DEPOTEK V2.0.4 CORE</p>
           </div>
           <p className="text-micro font-bold text-text-muted uppercase tracking-widest whitespace-nowrap">Distribué par Dakar Cold Link Logistics</p>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      {isResetConfirmOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsResetConfirmOpen(false)} className="fixed inset-0 bg-brand-ink/80 backdrop-blur-sm" />
          <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="w-full max-w-[340px] bg-white rounded-[32px] p-8 z-[310] shadow-2xl space-y-6">
            <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto">
              <AlertTriangle size={32} />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-black text-brand-ink tracking-tight">Réinitialisation Totale</h3>
              <p className="text-xs text-red-400 font-bold bg-red-50 p-3 rounded-xl mt-3 uppercase">Attention: Cette action effacera TOUTES les données (Inventaire, Dépôts, Logs, Tracking).</p>
              <p className="text-xs text-text-muted mt-4 italic">Tapez <span className="font-black text-red-500">RESET</span> pour confirmer.</p>
            </div>
            <input 
              value={resetInput}
              onChange={e => setResetInput(e.target.value.toUpperCase())}
              placeholder="RESET"
              className="w-full bg-surface-subtle border border-red-100 rounded-2xl p-4 text-center font-black outline-none focus:border-red-500 uppercase"
            />
            <div className="flex gap-4">
              <button onClick={() => setIsResetConfirmOpen(false)} className="flex-1 py-4 text-text-muted font-black uppercase text-label">Annuler</button>
              <button 
                onClick={handleResetData}
                disabled={resetInput !== 'RESET' || resetting}
                className={cn(
                  "flex-1 py-4 rounded-2xl font-black uppercase text-label transition-all flex items-center justify-center gap-2",
                  resetInput === 'RESET' ? "bg-red-500 text-white shadow-lg shadow-red-500/20" : "bg-surface-page text-text-muted"
                )}
              >
                {resetting ? <RefreshCcw size={14} className="animate-spin" /> : 'Confirmer'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

const ToggleRow = ({ icon, label, active, onToggle }: any) => (
  <div className="flex items-center justify-between py-1 px-2">
    <div className="flex items-center gap-3">
       <div className="w-10 h-10 bg-surface-subtle rounded-xl flex items-center justify-center">
          {icon}
       </div>
       <span className="text-xs font-black text-brand-dark uppercase tracking-tight">{label}</span>
    </div>
    <button 
      onClick={onToggle}
      className={cn(
        "w-12 h-6 rounded-full p-1 transition-colors relative",
        active ? "bg-green-500" : "bg-gray-200"
      )}
    >
      <motion.div 
        animate={{ x: active ? 24 : 0 }}
        className="w-4 h-4 bg-white rounded-full shadow-sm"
      />
    </button>
  </div>
);
