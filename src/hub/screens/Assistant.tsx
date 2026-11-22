import React, { useEffect, useRef, useState } from 'react';
import { FileText, Sheet, Mic, ArrowUp, Check, X, Camera, ArrowUpFromLine, ArrowDownToLine, Banknote, Search, Copy, Volume2, RotateCcw, Square } from 'lucide-react';
import { supabase, rpc, type Profile, canSeeFinance } from '../supabase';
import { prepareFile, MAX_TOTAL, type Attachment } from '../attach';
import { fcfa, useDocPicker } from '../ui';
import { cx as cn } from '../cx';

type FileMeta = Pick<Attachment, 'name' | 'kind' | 'preview'>;
type Msg = { role: 'user' | 'model'; text: string; files?: FileMeta[]; action?: { id: string; summary: string; state?: 'done' } };

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const [copied, setCopied] = useState<number | null>(null);
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

  // Pièces jointes : préparées tout de suite (photo réduite, Excel → tableau), envoyées avec le message
  const [pending, setPending] = useState<Attachment[]>([]);
  const [preparing, setPreparing] = useState(0);
  // Contenu des fichiers déjà envoyés (en mémoire seulement) : l'assistant peut répondre aux questions de suite
  const sentFiles = useRef<Map<number, Attachment[]>>(new Map());
  const addFile = async (file: File) => {
    setPreparing((n) => n + 1);
    try {
      const a = await prepareFile(file);
      setPending((p) => {
        const total = p.reduce((s, x) => s + x.size, 0) + a.size;
        if (total > MAX_TOTAL) {
          setMessages((m) => [...m, { role: 'model', text: `⚠️ ${a.name} : trop de fichiers en une fois (16 Mo max). Envoyez-les en deux fois.` }]);
          return p;
        }
        return [...p, a];
      });
      inputRef.current?.focus();
    } catch (e) {
      setMessages((m) => [...m, { role: 'model', text: `⚠️ ${(e as Error).message}` }]);
    } finally {
      setPreparing((n) => n - 1);
    }
  };
  const picker = useDocPicker((f) => void addFile(f), { multiple: true, accept: 'image/*,application/pdf,.csv,.txt,.xlsx,.xls,.ods' });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40).map((m) => (m.files ? { ...m, files: m.files.map(({ name, kind }) => ({ name, kind })) } : m)))); } catch { /* stockage indisponible */ }
    if (messages.length) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const call = async (body: Record<string, unknown>) => {
    // Le téléphone n'attend jamais plus de 60 s : au-delà, message clair plutôt qu'un écran figé
    const { data, error } = await supabase.functions.invoke('assistant', { body, timeout: 100000 }).catch(() => ({
      data: null,
      error: new Error("L'assistant met trop de temps à répondre. Réessayez dans un instant."),
    }));
    if (error) {
      // Message d'erreur renvoyé par la fonction si disponible
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (error as any).context;
      let detail = /fetch|abort|timeout|send a request/i.test(error.message)
        ? "L'assistant met trop de temps à répondre. Réessayez dans un instant."
        : error.message;
      try { detail = (await ctx?.json())?.error ?? detail; } catch { /* corps non JSON */ }
      throw new Error(detail);
    }
    return data as { reply: string; pending_action?: { id: string; summary: string } };
  };

  const send = async (text: string) => {
    const files = pending;
    const t = text.trim() || (files.length ? (files.length > 1 ? 'Analyse ces documents.' : 'Analyse ce document.') : '');
    if (!t || busy || preparing) return;
    const idx = messages.length;
    const next: Msg[] = [...messages, { role: 'user', text: t, files: files.length ? files.map(({ name, kind, preview }) => ({ name, kind, preview })) : undefined }];
    if (files.length) sentFiles.current.set(idx, files);
    setMessages(next);
    setInput('');
    setPending([]);
    setBusy(true);
    try {
      // Les 2 derniers envois de fichiers restent joints : on peut poser des questions de suite sur le dossier
      const withFiles = new Set([...sentFiles.current.keys()].filter((k) => k < next.length).sort((a, b) => b - a).slice(0, 2));
      const history = next.map((m, i) => ({ m, i })).filter(({ m }) => !m.text.startsWith('⚠️')).slice(-16)
        .map(({ m, i }) => ({
          role: m.role,
          text: m.files && !withFiles.has(i) ? `${m.text}\n[Pièces jointes déjà analysées : ${m.files.map((f) => f.name).join(', ')}]` : m.text,
          files: withFiles.has(i) ? sentFiles.current.get(i)!.map(({ name, mime, data }) => ({ name, mime, data })) : undefined,
        }));
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

  // Dictée vocale (Safari / Chrome), en français : le texte s'écrit en direct dans la zone, on relit puis on envoie
  const listen = () => {
    if (listening) { recRef.current?.stop(); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setMessages((m) => [...m, { role: 'model', text: '⚠️ Dictée vocale non disponible sur ce navigateur. Utilisez le micro du clavier.' }]); return; }
    const rec = new SR();
    rec.lang = 'fr-FR';
    rec.interimResults = true;
    rec.continuous = false;
    const base = input ? input.trimEnd() + ' ' : '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setInput(base + t);
    };
    rec.onend = () => { setListening(false); inputRef.current?.focus(); };
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  const copy = async (i: number, text: string) => {
    try { await navigator.clipboard.writeText(text.replace(/\*\*/g, '')); setCopied(i); setTimeout(() => setCopied(null), 1500); } catch { /* presse-papiers refusé */ }
  };
  // Lecture à voix haute (synthèse vocale du téléphone, gratuite)
  const speak = (text: string) => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/\*\*/g, '').replace(/[•·]/g, ''));
      u.lang = 'fr-FR';
      speechSynthesis.speak(u);
    } catch { /* non disponible */ }
  };
  const retry = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    setMessages((m) => {
      const cut = m.length - 1 - [...m].reverse().findIndex((x) => x.role === 'user');
      return m.slice(0, cut);
    });
    setTimeout(() => send(lastUser.text), 0);
  };

  // La zone de saisie grandit avec le texte (jusqu'à ~5 lignes)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 132) + 'px';
  }, [input]);

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
                    <span className="block text-caption font-semibold text-text-primary">Documents et dossiers</span>
                    <span className="block text-caption text-text-muted">Factures, bons de livraison, reçus, relevés, Excel : je lis, je résume et je saisis pour vous</span>
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
        {messages.map((m, i) => {
          const isErr = m.role === 'model' && m.text.startsWith('⚠️');
          const isLast = i === messages.length - 1;
          return (
            <div key={i} className={cn('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
              <div className={cn('max-w-[88%] rounded-[20px] px-4 py-2.5 text-[15px] leading-[1.45]',
                m.role === 'user' ? 'bg-brand text-white rounded-br-md whitespace-pre-wrap'
                  : isErr ? 'bg-status-danger/10 text-status-danger rounded-bl-md'
                  : 'bg-surface-card text-text-primary rounded-bl-md shadow-sm')}>
                {m.files && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {m.files.map((f, k) => f.preview
                      ? <img key={k} src={f.preview} alt={f.name} className="w-16 h-16 rounded-xl object-cover border border-white/30" />
                      : <span key={k} className="flex items-center gap-1 rounded-lg bg-white/15 px-2 py-1 text-caption max-w-[180px]">
                          {f.kind === 'table' ? <Sheet size={14} /> : <FileText size={14} />}<span className="truncate">{f.name}</span>
                        </span>)}
                  </div>
                )}
                {m.role === 'user' ? m.text : <RichText text={m.text} />}
                {m.action && !m.action.state && (
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => decide(i, 'confirm')} disabled={busy}
                      className="flex-1 flex items-center justify-center gap-1 bg-status-success text-white rounded-xl py-2.5 font-bold">
                      <Check size={16} /> Confirmer
                    </button>
                    <button onClick={() => decide(i, 'cancel')} disabled={busy}
                      className="flex-1 flex items-center justify-center gap-1 bg-surface-subtle text-text-primary rounded-xl py-2.5 font-bold">
                      <X size={16} /> Annuler
                    </button>
                  </div>
                )}
              </div>
              {m.role === 'model' && !m.action && (
                <div className="flex gap-1 px-1 pt-1 text-text-muted">
                  {isErr ? (
                    isLast && <button onClick={retry} disabled={busy} className="flex items-center gap-1 px-2 py-1 text-caption font-semibold text-brand"><RotateCcw size={14} /> Réessayer</button>
                  ) : (<>
                    <button onClick={() => copy(i, m.text)} aria-label="Copier" className="p-1.5 rounded-lg active:bg-surface-subtle">
                      {copied === i ? <Check size={15} className="text-status-success" /> : <Copy size={15} />}
                    </button>
                    <button onClick={() => speak(m.text)} aria-label="Lire à voix haute" className="p-1.5 rounded-lg active:bg-surface-subtle"><Volume2 size={15} /></button>
                  </>)}
                </div>
              )}
            </div>
          );
        })}
        {busy && messages[messages.length - 1]?.files && (
          <p className="text-caption text-text-muted px-1">Lecture des documents…</p>
        )}
        {busy && (
          <div className="flex items-center gap-1 bg-surface-card rounded-[20px] rounded-bl-md px-4 py-3.5 w-fit shadow-sm" aria-label="DEPOTEK réfléchit">
            {[0, 1, 2].map((d) => <span key={d} className="w-2 h-2 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: `${d * 150}ms` }} />)}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {picker.element}
      {messages.length > 0 && !busy && (
        <div className="flex gap-2 overflow-x-auto px-3 pb-2 no-scrollbar">
          {quick.map((q) => (
            <button key={q} onClick={() => send(q)}
              className="shrink-0 rounded-full bg-surface-card border border-border-default px-3 py-1.5 text-caption text-text-primary">{q}</button>
          ))}
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="px-3 pt-2 pb-24 bg-surface-page">
        {(pending.length > 0 || preparing > 0) && (
          <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2">
            {pending.map((f, k) => (
              <div key={k} className="relative shrink-0">
                {f.preview
                  ? <img src={f.preview} alt={f.name} className="w-14 h-14 rounded-xl object-cover border border-border-default" />
                  : <div className="h-14 max-w-[150px] rounded-xl bg-surface-card border border-border-default px-2.5 flex items-center gap-1.5 text-caption text-text-primary">
                      {f.kind === 'table' ? <Sheet size={16} className="text-status-success shrink-0" /> : <FileText size={16} className="text-status-danger shrink-0" />}
                      <span className="truncate">{f.name}</span>
                    </div>}
                <button type="button" onClick={() => setPending((p) => p.filter((_, j) => j !== k))} aria-label={`Retirer ${f.name}`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-text-primary text-white flex items-center justify-center">
                  <X size={12} />
                </button>
              </div>
            ))}
            {preparing > 0 && <div className="w-14 h-14 rounded-xl bg-surface-subtle animate-pulse shrink-0" />}
          </div>
        )}
        <div className={cn('flex items-end gap-1 rounded-[24px] border bg-surface-card pl-1.5 pr-1.5 py-1.5 transition-colors',
          listening ? 'border-status-danger' : 'border-border-strong focus-within:border-brand')}>
          <button type="button" onClick={picker.open} aria-label="Joindre une photo ou des fichiers"
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-text-secondary active:bg-surface-subtle">
            <Camera size={20} />
          </button>
          <textarea ref={inputRef} value={input} rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); send(input); } }}
            placeholder={listening ? 'Je vous écoute…' : pending.length ? 'Que dois-je en faire ? (facultatif)' : 'Message à DEPOTEK'}
            enterKeyHint="send"
            className="flex-1 min-w-0 resize-none bg-transparent px-1.5 py-[7px] text-[16px] leading-[22px] text-text-primary placeholder:text-text-muted focus:outline-none" />
          {(input.trim() || pending.length > 0) && !listening ? (
            <button disabled={busy || preparing > 0} aria-label="Envoyer"
              className="w-9 h-9 rounded-full bg-brand text-white flex items-center justify-center shrink-0 disabled:opacity-40">
              <ArrowUp size={20} strokeWidth={2.5} />
            </button>
          ) : (
            <button type="button" onClick={listen} aria-label={listening ? 'Arrêter la dictée' : 'Dicter'}
              className={cn('w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                listening ? 'bg-status-danger text-white animate-pulse' : 'text-text-secondary active:bg-surface-subtle')}>
              {listening ? <Square size={14} fill="currentColor" /> : <Mic size={20} />}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Affiche le texte de l'assistant proprement : **gras**, listes à puces ou numérotées, paragraphes. */
function RichText({ text }: { text: string }) {
  const inline = (line: string) => line.split(/(\*\*[^*]+\*\*)/g).map((part, k) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? <strong key={k} className="font-semibold">{part.slice(2, -2)}</strong>
      : <React.Fragment key={k}>{part.replace(/(^|\s)\*(\S[^*]*\S|\S)\*/g, '$1$2')}</React.Fragment>);
  const lines = text.replace(/\n{3,}/g, '\n\n').split('\n');
  return (
    <div className="space-y-1">
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={i} className="h-1.5" />;
        const h = line.match(/^#{1,4}\s+(.*)/);
        if (h) return <p key={i} className="font-semibold pt-1">{inline(h[1])}</p>;
        const b = line.match(/^\s*[-*•]\s+(.*)/);
        if (b) return <div key={i} className={cn('flex gap-2', /^\s{2,}/.test(line) && 'pl-4')}><span className="text-text-muted">•</span><span className="min-w-0">{inline(b[1])}</span></div>;
        const n = line.match(/^\s*(\d+)[.)]\s+(.*)/);
        if (n) return <div key={i} className="flex gap-2"><span className="text-text-muted tabular-nums">{n[1]}.</span><span className="min-w-0">{inline(n[2])}</span></div>;
        return <p key={i}>{inline(line)}</p>;
      })}
    </div>
  );
}
