import React, { useEffect, useRef, useState } from 'react';
import { Mic, Send, Check, X, Camera, ArrowUpFromLine, ArrowDownToLine, Banknote, Search } from 'lucide-react';
import { supabase, rpc, type Profile, canSeeFinance, uploadDocument } from '../supabase';
import { fcfa, useDocPicker } from '../ui';
import { cx as cn } from '../cx';

type Msg = { role: 'user' | 'model'; text: string; action?: { id: string; summary: string; state?: 'done' } };

// Phrases modèles : elles remplissent la zone de saisie, il suffit d'ajuster et d'envoyer
const TEMPLATES = [
  { icon: ArrowUpFromLine, label: 'Vente', text: 'Vends 20 cartons de cuisse de poulet à Moussa à 15 000' },
  { icon: ArrowDownToLine, label: 'Réception', text: 'Réception de 400 cartons de foie de bœuf, lot BR-2211, expire le 2027-06-30, chambre viande' },
  { icon: Banknote, label: 'Encaissement', text: 'Moussa a payé 500 000 par Wave' },
  { icon: Search, label: 'Question', text: 'Quels lots expirent cette semaine ?' },
];
const QUICK_FINANCE = ['Briefing du jour', 'Qui me doit de l’argent ?', 'Quelles chambres sont libres ?'];
const QUICK_STOCK = ['Stock par produit', 'Quels lots expirent bientôt ?', 'Quelles chambres sont libres ?'];

interface Welcome { sales: string; sub: string; expiring: number; overdue: number | null; reorder: number | null }

const STORAGE_KEY = 'depotek.assistant.history';

export function Assistant({ profile, openTasks = 0 }: { profile: Profile; openTasks?: number }) {
  const [messages, setMessages] = useState<Msg[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const finance = canSeeFinance(profile.role);
  const [welcome, setWelcome] = useState<Welcome | null>(null);

  // Petit tableau de bord d'accueil
  useEffect(() => {
    if (messages.length) return;
    (async () => {
      try {
        const [day, exp, brief] = await Promise.all([
          rpc<{ sales_count: number; sales_xof: number | null; payments_xof: number | null }>('operations_day', {}),
          supabase.from('v_stock_lots').select('lot_number', { count: 'exact', head: true })
            .in('fefo_status', ['EXPIRE', 'CRITIQUE']).is('owner_client_id', null),
          finance ? rpc<{ overdue_xof: number; reorder: unknown[] }>('daily_briefing', {}) : Promise.resolve(null),
        ]);
        setWelcome({
          sales: finance ? fcfa(day.sales_xof) : String(day.sales_count),
          sub: finance ? `${day.sales_count} vente${day.sales_count > 1 ? 's' : ''} · encaissé ${fcfa(day.payments_xof)}` : 'ventes aujourd’hui',
          expiring: exp.count ?? 0,
          overdue: brief ? Number(brief.overdue_xof) : null,
          reorder: brief ? brief.reorder.length : null,
        });
      } catch { /* l'accueil reste simple */ }
    })();
  }, [messages.length, finance]);

  const picker = useDocPicker((f) => sendFile(f));
  const sendFile = async (file: File) => {
    setMessages((m) => [...m, { role: 'user', text: `📎 ${file.name || 'Photo du document'}` }]);
    setBusy(true);
    try {
      await uploadDocument(profile.id, file);
      setMessages((m) => [...m, { role: 'model', text: 'Document reçu. Je le lis et je prépare la saisie (réception, facture fournisseur…). Vous la validerez en un geste dans « À traiter ».' }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'model', text: `⚠️ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40))); } catch { /* stockage indisponible */ }
    if (messages.length) endRef.current?.scrollIntoView({ behavior: 'smooth' });
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

  const quick = finance ? QUICK_FINANCE : QUICK_STOCK;
  const first = profile.full_name?.split(' ')[0] || '';

  return (
    <div className="h-full flex flex-col">
      {messages.length > 0 && (
        <div className="px-5 pt-3 flex justify-end">
          <button onClick={() => setMessages([])} className="text-caption text-brand font-semibold">Nouvelle conversation</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 space-y-3 pb-4">
        {messages.length === 0 && (
          <div className="pt-4 space-y-4">
            <div className="px-1">
              <p className="text-title font-bold text-text-primary">Bonjour{first ? ` ${first}` : ''}</p>
              <p className="text-caption text-text-secondary">
                {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Dakar' })}
              </p>
            </div>

            <div className="grid grid-cols-2 bg-surface-card rounded-2xl overflow-hidden divide-x divide-border-default">
              <div className="px-4 py-3">
                <p className="text-caption text-text-secondary">Aujourd’hui</p>
                <p className="text-body font-semibold text-text-primary tabular-nums truncate">{welcome?.sales ?? '—'}</p>
                <p className="text-micro text-text-muted truncate">{welcome?.sub ?? ''}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-caption text-text-secondary">À traiter</p>
                <p className={cn('text-body font-semibold tabular-nums', openTasks > 0 ? 'text-status-danger' : 'text-text-primary')}>{openTasks}</p>
                <p className="text-micro text-text-muted">à valider</p>
              </div>
            </div>
            <div className="bg-surface-card rounded-2xl overflow-hidden">
              {[
                { label: 'Lots à écouler (≤ 15 j)', value: welcome ? String(welcome.expiring) : '—', alert: (welcome?.expiring ?? 0) > 0, q: 'Quels lots expirent bientôt ?' },
                ...(finance ? [
                  { label: 'Créances en retard', value: welcome?.overdue != null ? fcfa(welcome.overdue) : '—', alert: (welcome?.overdue ?? 0) > 0, q: 'Qui me doit de l’argent ?' },
                  { label: 'Produits à commander', value: welcome?.reorder != null ? String(welcome.reorder) : '—', alert: (welcome?.reorder ?? 0) > 0, q: 'Qu’est-ce que je dois commander ?' },
                ] : []),
              ].map((r, i) => (
                <button key={r.label} onClick={() => send(r.q)}
                  className={cn('w-full flex items-center justify-between px-4 py-3 text-left active:bg-surface-subtle', i > 0 && 'border-t border-border-default')}>
                  <span className="text-body text-text-primary">{r.label}</span>
                  <span className={cn('text-body font-semibold tabular-nums', r.alert ? 'text-status-danger' : 'text-text-muted')}>{r.value}</span>
                </button>
              ))}
            </div>

            <div>
              <p className="text-caption text-text-secondary px-1 pb-2">Dites-le simplement</p>
              <div className="bg-surface-card rounded-2xl overflow-hidden">
                {TEMPLATES.map((t, i) => (
                  <button key={t.label} onClick={() => { setInput(t.text); inputRef.current?.focus(); }}
                    className={cn('w-full flex items-start gap-3 px-4 py-3 text-left active:bg-surface-subtle', i > 0 && 'border-t border-border-default')}>
                    <t.icon size={18} className="text-brand mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-caption font-semibold text-text-primary">{t.label}</span>
                      <span className="block text-caption text-text-muted">« {t.text} »</span>
                    </span>
                  </button>
                ))}
                <button onClick={picker.open}
                  className="w-full flex items-start gap-3 px-4 py-3 text-left border-t border-border-default active:bg-surface-subtle">
                  <Camera size={18} className="text-brand mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-caption font-semibold text-text-primary">Photo d’un document</span>
                    <span className="block text-caption text-text-muted">Bon de livraison, facture fournisseur, reçu : je saisis pour vous</span>
                  </span>
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {quick.map((q) => (
                <button key={q} onClick={() => send(q)}
                  className="rounded-full bg-surface-card border border-border-default px-3 py-1.5 text-caption text-text-primary">{q}</button>
              ))}
            </div>
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

      {picker.element}
      <form onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="px-3 pt-2 pb-24 flex gap-2 items-center bg-surface-page border-t border-border-default">
        <button type="button" onClick={picker.open} aria-label="Photo d’un document"
          className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 bg-surface-subtle text-brand">
          <Camera size={20} />
        </button>
        <button type="button" onClick={listen}
          className={cn('w-11 h-11 rounded-full flex items-center justify-center shrink-0',
            listening ? 'bg-status-danger text-white animate-pulse' : 'bg-surface-subtle text-brand')}>
          <Mic size={20} />
        </button>
        <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Écrivez ou dictez…"
          className="flex-1 min-w-0 rounded-full border border-border-strong bg-surface-card px-4 py-3 text-body focus:outline-none focus:border-border-focus" />
        <button disabled={busy || !input.trim()}
          className="w-11 h-11 rounded-full bg-brand text-white flex items-center justify-center shrink-0 disabled:opacity-40">
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
