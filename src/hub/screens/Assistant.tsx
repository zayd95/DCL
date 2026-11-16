import React, { useEffect, useRef, useState } from 'react';
import { Mic, Send, Check, X } from 'lucide-react';
import { supabase, type Profile, canSeeFinance } from '../supabase';
import { cx as cn } from '../cx';

type Msg = { role: 'user' | 'model'; text: string; action?: { id: string; summary: string; state?: 'done' } };

const SUGGESTIONS_FINANCE = [
  'Briefing du jour',
  'Qui me doit de l’argent ?',
  'Ventes et marge de la semaine',
  'Qu’est-ce que je dois commander ?',
];
const SUGGESTIONS_STOCK = ['Stock par produit', 'Quels lots expirent bientôt ?', 'Alertes'];

const STORAGE_KEY = 'depotek.assistant.history';

export function Assistant({ profile }: { profile: Profile }) {
  const [messages, setMessages] = useState<Msg[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40))); } catch { /* stockage indisponible */ }
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const call = async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke('assistant', { body });
    if (error) {
      // Message d'erreur renvoyé par la fonction si disponible
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (error as any).context;
      let detail = error.message;
      try { detail = (await ctx?.json())?.error ?? detail; } catch { /* corps non JSON */ }
      throw new Error(detail);
    }
    return data as { reply: string; pending_action?: { id: string; summary: string } };
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    const next: Msg[] = [...messages, { role: 'user', text: t }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const history = next.map(({ role, text }) => ({ role, text }));
      const res = await call({ messages: history });
      setMessages((m) => [...m, { role: 'model', text: res.reply, action: res.pending_action }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'model', text: `⚠️ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (idx: number, decision: 'confirm' | 'cancel') => {
    const action = messages[idx].action;
    if (!action || action.state) return;
    setMessages((m) => m.map((x, i) => (i === idx ? { ...x, action: { ...action, state: 'done' } } : x)));
    setBusy(true);
    try {
      const res = await call({ action_id: action.id, decision });
      setMessages((m) => [...m, { role: 'model', text: res.reply }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'model', text: `⚠️ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  // Dictée vocale (Chrome / Safari), en français
  const listen = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert('Dictée vocale non disponible sur ce navigateur.'); return; }
    const rec = new SR();
    rec.lang = 'fr-FR';
    rec.interimResults = false;
    rec.onresult = (e: { results: { 0: { transcript: string } }[] }) => send(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const suggestions = canSeeFinance(profile.role) ? SUGGESTIONS_FINANCE : SUGGESTIONS_STOCK;

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 pt-6 pb-3 flex items-end justify-between">
        <div>
          <h1 className="text-title font-black text-brand-ink uppercase tracking-tight">Assistant</h1>
          <p className="text-caption text-text-secondary">Bonjour {profile.full_name?.split(' ')[0] || ''} — posez votre question</p>
        </div>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} className="text-caption text-text-muted underline">Effacer</button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 space-y-3 pb-4">
        {messages.length === 0 && (
          <div className="pt-6 space-y-2">
            {suggestions.map((s) => (
              <button key={s} onClick={() => send(s)}
                className="block w-full text-left bg-surface-card border border-border-default rounded-2xl px-4 py-3 text-body text-text-primary">
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[85%] rounded-2xl px-4 py-3 text-body whitespace-pre-wrap',
              m.role === 'user' ? 'bg-brand text-white rounded-br-md' : 'bg-surface-card border border-border-default text-text-primary rounded-bl-md')}>
              {m.text}
              {m.action && !m.action.state && (
                <div className="flex gap-2 mt-3">
                  <button onClick={() => decide(i, 'confirm')} disabled={busy}
                    className="flex-1 flex items-center justify-center gap-1 bg-status-success text-white rounded-xl py-2 font-bold">
                    <Check size={16} /> Confirmer
                  </button>
                  <button onClick={() => decide(i, 'cancel')} disabled={busy}
                    className="flex-1 flex items-center justify-center gap-1 bg-surface-subtle text-text-primary rounded-xl py-2 font-bold">
                    <X size={16} /> Annuler
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="text-caption text-text-muted px-2">DEPOTEK réfléchit…</div>}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="px-3 pt-2 pb-24 flex gap-2 items-center bg-surface-page border-t border-border-default">
        <button type="button" onClick={listen}
          className={cn('w-11 h-11 rounded-full flex items-center justify-center shrink-0',
            listening ? 'bg-status-danger text-white animate-pulse' : 'bg-surface-subtle text-brand')}>
          <Mic size={20} />
        </button>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ex. Vends 20 cartons de foie à Moussa"
          className="flex-1 rounded-full border border-border-strong bg-surface-card px-4 py-3 text-body focus:outline-none focus:border-border-focus" />
        <button disabled={busy || !input.trim()}
          className="w-11 h-11 rounded-full bg-brand text-white flex items-center justify-center shrink-0 disabled:opacity-40">
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
