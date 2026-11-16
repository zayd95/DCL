import React, { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { MessageSquare, Box, Wallet, ArrowLeftRight, Settings as SettingsIcon } from 'lucide-react';
import { supabase, type Profile, canSeeFinance } from './supabase';
import { cx as cn } from './cx';
import { Login } from './screens/Login';
import { Assistant } from './screens/Assistant';
import { Stock } from './screens/Stock';
import { Receivables } from './screens/Receivables';
import { Operations } from './screens/Operations';
import { Settings } from './screens/Settings';

type Tab = 'assistant' | 'stock' | 'creances' | 'operations' | 'reglages';

export default function HubApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>('assistant');
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
    { id: 'assistant', label: 'Assistant', icon: <MessageSquare size={22} />, show: true },
    { id: 'stock', label: 'Stock', icon: <Box size={22} />, show: true },
    { id: 'creances', label: 'Créances', icon: <Wallet size={22} />, show: finance },
    { id: 'operations', label: 'Opérations', icon: <ArrowLeftRight size={22} />, show: true },
    { id: 'reglages', label: 'Réglages', icon: <SettingsIcon size={22} />, show: true },
  ];

  return (
    <div className="fixed inset-0 bg-surface-page flex justify-center">
      <div className="relative w-full max-w-[480px] h-full overflow-hidden">
        {tab === 'assistant' && <Assistant profile={profile} />}
        {tab === 'stock' && <Stock profile={profile} />}
        {tab === 'creances' && finance && <Receivables />}
        {tab === 'operations' && <Operations />}
        {tab === 'reglages' && <Settings profile={profile} onSignOut={signOut} />}

        <nav className="absolute bottom-0 inset-x-0 h-20 bg-surface-card/90 backdrop-blur-xl border-t border-border-default flex justify-around items-center px-2 pb-4 z-[180]">
          {tabs.filter((t) => t.show).map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn('flex flex-col items-center gap-1 px-2', tab === t.id ? 'text-brand' : 'text-text-muted')}>
              {t.icon}
              <span className="text-micro font-black uppercase tracking-widest">{t.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
