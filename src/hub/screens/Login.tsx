import React, { useState } from 'react';
import { Package } from 'lucide-react';
import { supabase } from '../supabase';

export function Login() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = mode === 'login'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } });
    setBusy(false);
    if (res.error) {
      setMsg(res.error.message === 'Invalid login credentials' ? 'Email ou mot de passe incorrect.' : res.error.message);
    } else if (mode === 'signup' && !res.data.session) {
      setMsg('Compte créé. Ouvrez le lien reçu par email pour l’activer, puis connectez-vous.');
      setMode('login');
    }
  };

  const google = async () => {
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname, queryParams: { prompt: 'select_account' } },
    });
    if (error) {
      setBusy(false);
      setMsg(error.message.includes('not enabled') ? 'La connexion Google n’est pas encore activée sur le serveur.' : error.message);
    }
  };

  const input = 'w-full rounded-2xl bg-white/10 border border-white/20 px-4 py-4 text-white placeholder:text-white/40 focus:outline-none focus:border-white/60';

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-dark to-brand flex items-center justify-center p-6 text-white">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div className="w-20 h-20 bg-white/10 rounded-[2rem] flex items-center justify-center mx-auto mb-6 border border-white/20">
          <Package size={40} />
        </div>
        <h1 className="text-display font-black tracking-tighter uppercase text-center">DEPOTEK</h1>
        <p className="text-caption font-bold text-white/50 uppercase tracking-[0.2em] text-center mb-8">Hub froid ODS</p>

        <button type="button" onClick={google} disabled={busy}
          className="w-full flex items-center justify-center gap-3 bg-white text-text-primary py-4 rounded-2xl font-bold text-body disabled:opacity-60">
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          Continuer avec Google
        </button>
        <div className="flex items-center gap-3 text-caption text-white/50"><span className="flex-1 h-px bg-white/20" />ou avec un email<span className="flex-1 h-px bg-white/20" /></div>

        {mode === 'signup' && (
          <input className={input} placeholder="Nom complet" value={name} onChange={(e) => setName(e.target.value)} required />
        )}
        <input className={input} type="email" placeholder="Email" autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className={input} type="password" placeholder="Mot de passe (8 caractères min.)" minLength={8}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password} onChange={(e) => setPassword(e.target.value)} required />

        {msg && <p className="text-body bg-white/10 rounded-xl p-3">{msg}</p>}
        <p className="text-caption text-white/50 text-center">Un nouveau compte doit être validé par un administrateur avant d’accéder aux données.</p>

        <button disabled={busy} className="w-full bg-white text-brand py-4 rounded-2xl font-black uppercase tracking-widest text-body disabled:opacity-60">
          {busy ? '…' : mode === 'login' ? 'Se connecter' : 'Créer le compte'}
        </button>
        <button type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMsg(null); }}
          className="w-full text-caption text-white/70 underline">
          {mode === 'login' ? 'Pas encore de compte ? Créer un compte' : 'Déjà un compte ? Se connecter'}
        </button>
      </form>
    </div>
  );
}
