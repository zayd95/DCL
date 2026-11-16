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

  const input = 'w-full rounded-2xl bg-white/10 border border-white/20 px-4 py-4 text-white placeholder:text-white/40 focus:outline-none focus:border-white/60';

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-dark to-brand flex items-center justify-center p-6 text-white">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div className="w-20 h-20 bg-white/10 rounded-[2rem] flex items-center justify-center mx-auto mb-6 border border-white/20">
          <Package size={40} />
        </div>
        <h1 className="text-display font-black tracking-tighter uppercase text-center">DEPOTEK</h1>
        <p className="text-caption font-bold text-white/50 uppercase tracking-[0.2em] text-center mb-8">Hub froid ODS</p>

        {mode === 'signup' && (
          <input className={input} placeholder="Nom complet" value={name} onChange={(e) => setName(e.target.value)} required />
        )}
        <input className={input} type="email" placeholder="Email" autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className={input} type="password" placeholder="Mot de passe (8 caractères min.)" minLength={8}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password} onChange={(e) => setPassword(e.target.value)} required />

        {msg && <p className="text-body bg-white/10 rounded-xl p-3">{msg}</p>}

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
