import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, X, MessageCircle, ChevronDown } from 'lucide-react';
import { supabase, rpc, type Profile } from '../supabase';
import { Card, Badge, Empty, ErrorNote } from '../ui';
import { cx } from '../cx';

export interface Task {
  id: string; kind: string; severity: 'info' | 'warning' | 'critical'; title: string; body: string;
  action: { tool: string } | null; link: string | null; status: string; result: { error?: string } | null;
  created_at: string; decided_at: string | null;
}

const KIND_LABEL: Record<string, string> = {
  rupture: 'Rupture', reappro: 'Réappro', fefo: 'FEFO', creance: 'Impayé', credit: 'Crédit',
  anomalie: 'Contrôle', document: 'Document',
};
const STATUS_LABEL: Record<string, string> = { validee: 'Validé', refusee: 'Refusé', resolue: 'Résolu', echec: 'Échec' };

const ago = (d: string) => {
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`;
};

/** Fil « À traiter » : tout ce que le moteur a détecté ou préparé, avec validation en un clic. */
export function Inbox({ profile, onCount }: { profile: Profile; onCount: (n: number) => void }) {
  const [open, setOpen] = useState<Task[]>([]);
  const [done, setDone] = useState<Task[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [o, d] = await Promise.all([
      supabase.from('tasks').select('*').eq('status', 'ouverte').order('created_at', { ascending: false }).limit(50),
      supabase.from('tasks').select('*').neq('status', 'ouverte').order('decided_at', { ascending: false }).limit(15),
    ]);
    setOpen((o.data ?? []) as Task[]);
    setDone((d.data ?? []) as Task[]);
    onCount(o.data?.length ?? 0);
  }, [onCount]);

  useEffect(() => {
    load();
    const ch = supabase.channel('tasks').on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const decide = async (t: Task, decision: 'valider' | 'refuser') => {
    setBusy(t.id); setError(null);
    try {
      const r = await rpc<{ status: string; error?: string }>('decide_task', { p_task: t.id, p_decision: decision });
      if (r.status === 'echec') setError(`${t.title} : ${r.error}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const scan = async (file: File) => {
    setScanMsg('Envoi du document…'); setError(null);
    const ext = file.type === 'application/pdf' ? 'pdf' : (file.type.split('/')[1] || 'jpg');
    const path = `${profile.id}/app-${Date.now()}.${ext}`;
    const up = await supabase.storage.from('documents').upload(path, file, { contentType: file.type });
    if (up.error) { setScanMsg(null); setError(up.error.message); return; }
    const ins = await supabase.from('documents').insert({ storage_path: path, mime: file.type, source: 'app', uploaded_by: profile.id });
    if (ins.error) { setScanMsg(null); setError(ins.error.message); return; }
    setScanMsg('📄 Document reçu. DEPOTEK le lit et vous propose la saisie dans quelques secondes.');
    setTimeout(() => setScanMsg(null), 8000);
  };

  return (
    <div className="space-y-3">
      <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) scan(f); e.target.value = ''; }} />
      <button onClick={() => fileRef.current?.click()}
        className="w-full flex items-center justify-center gap-2 bg-brand text-white rounded-2xl py-4 text-body font-bold active:scale-[0.99]">
        <Camera size={20} /> Scanner une facture ou un reçu
      </button>
      {scanMsg && <p className="rounded-xl bg-status-info-bg text-status-info text-body p-3">{scanMsg}</p>}
      <ErrorNote error={error} />

      {open.length === 0 && <Empty>Rien à traiter. Le moteur surveille le stock, les lots et les paiements en continu.</Empty>}
      {open.map((t) => (
        <Card key={t.id} className={cx(t.severity === 'critical' && 'border-status-danger', t.severity === 'warning' && 'border-status-warning')}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <Badge tone={t.severity === 'critical' ? 'danger' : t.severity === 'warning' ? 'warn' : 'info'}>{KIND_LABEL[t.kind] ?? t.kind}</Badge>
            <span className="text-caption text-text-muted">{ago(t.created_at)}</span>
          </div>
          <p className="text-body font-bold text-text-primary">{t.title}</p>
          <p className="text-body text-text-secondary whitespace-pre-wrap mt-1">{t.body}</p>
          <div className="flex gap-2 mt-3">
            {t.link && (
              <a href={t.link} target="_blank" rel="noreferrer"
                className="flex-1 flex items-center justify-center gap-1 bg-status-success-bg text-status-success rounded-xl py-2 text-body font-bold">
                <MessageCircle size={16} /> WhatsApp
              </a>
            )}
            <button disabled={busy === t.id} onClick={() => decide(t, 'valider')}
              className="flex-1 flex items-center justify-center gap-1 bg-brand text-white rounded-xl py-2 text-body font-bold disabled:opacity-50">
              <Check size={16} /> {t.action ? 'Valider' : 'Noté'}
            </button>
            <button disabled={busy === t.id} onClick={() => decide(t, 'refuser')}
              className="flex items-center justify-center gap-1 bg-surface-subtle text-text-primary rounded-xl px-4 py-2 text-body font-bold disabled:opacity-50">
              <X size={16} />
            </button>
          </div>
        </Card>
      ))}

      {done.length > 0 && (
        <button onClick={() => setShowDone(!showDone)} className="w-full flex items-center justify-center gap-1 text-caption text-text-muted py-2">
          Historique <ChevronDown size={14} className={cx(showDone && 'rotate-180')} />
        </button>
      )}
      {showDone && done.map((t) => (
        <div key={t.id} className="flex items-start justify-between gap-3 px-1 py-2 border-b border-border-default">
          <div className="min-w-0">
            <p className="text-body text-text-secondary truncate">{t.title}</p>
            {t.status === 'echec' && <p className="text-caption text-status-danger">{t.result?.error}</p>}
          </div>
          <Badge tone={t.status === 'validee' || t.status === 'resolue' ? 'ok' : t.status === 'echec' ? 'danger' : 'muted'}>
            {STATUS_LABEL[t.status] ?? t.status}
          </Badge>
        </div>
      ))}
    </div>
  );
}
