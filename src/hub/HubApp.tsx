import React, { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Bell, Box, Wallet, ArrowLeftRight, ChevronLeft } from 'lucide-react';
import { supabase, type Profile, canSeeFinance } from './supabase';
import { cx as cn } from './cx';
import { Login } from './screens/Login';
import { Home } from './screens/Home';
import { Stock } from './screens/Stock';
import { Receivables } from './screens/Receivables';
import { Operations } from './screens/Operations';
import { Settings } from './screens/Settings';

type Tab = 'accueil' | 'stock' | 'operations' | 'creances';

export default function HubApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>('accueil');
  const [openTasks, setOpenTasks] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    setLoadError(null);
    supabase.from('profiles').select('*').eq('id', session.user.id).single()
      .then(({ data, error }) => {
        if (error || !data) setLoadError(error?.message || 'Profil introuvable');
        else setProfile(data as Profile);
      });
  }, [session, retry]);

  const reloadProfile = () => setRetry((n) => n + 1);

  const signOut = async () => {
    try { localStorage.removeItem('depotek.assistant.history'); } catch { /* ignore */ }
    await supabase.auth.signOut();
  };

  if (session && !profile && loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-body text-text-secondary">Connexion au serveur impossible. Vérifiez votre réseau.</p>
        <p className="text-caption text-text-muted">{loadError}</p>
        <button onClick={() => setRetry((n) => n + 1)} className="bg-brand text-white rounded-xl px-6 py-3 font-bold">Réessayer</button>
        <button onClick={signOut} className="text-caption text-text-muted underline">Se déconnecter</button>
      </div>
    );
  }
  if (session === undefined || (session && !profile)) {
    return <div className="min-h-screen flex items-center justify-center text-text-muted text-body">Chargement…</div>;
  }
  if (!session || !profile) return <Login />;

  const finance = canSeeFinance(profile.role);
  const tabs: { id: Tab; label: string; icon: React.ReactNode; show: boolean }[] = [
    { id: 'accueil', label: 'DEPOTEK', icon: <Bell size={22} />, show: true },
    { id: 'stock', label: 'Stock', icon: <Box size={22} />, show: true },
    { id: 'operations', label: 'Opérations', icon: <ArrowLeftRight size={22} />, show: true },
    { id: 'creances', label: 'Créances', icon: <Wallet size={22} />, show: finance },
  ];

  return (
    <div className="fixed inset-0 bg-surface-page flex justify-center">
      <div className="relative w-full max-w-[480px] h-full overflow-hidden">
        <div className={cn('h-full', tab !== 'accueil' && 'hidden')}>
          <Home profile={profile} count={openTasks} onCount={setOpenTasks}
            initial="inbox" onOpenSettings={() => setSettingsOpen(true)} />
        </div>
        {tab === 'stock' && <Stock profile={profile} />}
        {tab === 'creances' && finance && <Receivables />}
        {tab === 'operations' && <Operations profile={profile} />}

        {/* Réglages : ouverts depuis l'engrenage de l'accueil, par-dessus les onglets */}
        {settingsOpen && (
          <div className="absolute inset-0 z-[300] bg-surface-page flex flex-col">
            <button onClick={() => setSettingsOpen(false)}
              className="flex items-center gap-0.5 text-brand text-body px-3 pt-4 pb-1 self-start">
              <ChevronLeft size={22} /> Retour
            </button>
            <div className="flex-1 min-h-0"><Settings profile={profile} onSignOut={signOut} onProfileChange={reloadProfile} /></div>
          </div>
        )}

        <nav className="absolute bottom-0 inset-x-0 h-20 bg-surface-card/90 backdrop-blur-xl border-t border-border-default flex justify-around items-center px-2 pb-4 z-[180]">
          {tabs.filter((t) => t.show).map((t) => (
            <button key={t.id} onClick={() => { setTab(t.id); setSettingsOpen(false); }}
              className={cn('relative flex flex-col items-center gap-1 px-2', tab === t.id ? 'text-brand' : 'text-text-muted')}>
              {t.icon}
              {t.id === 'accueil' && openTasks > 0 && (
                <span className="absolute -top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-status-danger text-white text-micro font-black flex items-center justify-center">
                  {openTasks > 99 ? '99+' : openTasks}
                </span>
              )}
              <span className="text-micro font-black uppercase tracking-widest">{t.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
