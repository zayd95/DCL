import React, { useCallback, useEffect, useState } from 'react';
import { Phone, MessageCircle, FileText, Plus, Pencil, NotebookPen } from 'lucide-react';
import { supabase, rpc, type Profile } from '../supabase';
import { Screen, Card, Badge, Empty, ErrorNote, Sheet, Field, Input, Select, Button, fcfa, shortDate } from '../ui';
import { cx } from '../cx';
import { InvoiceForm, InvoiceView, waNumber } from './Billing';

interface ClientBalance {
  client_id: string; client_name: string; phone: string | null; credit_limit_xof: number;
  balance_xof: number; overdue_xof: number; max_days_overdue: number | null; open_invoices: number; over_limit: boolean;
}
interface Receivable {
  invoice_id: string; number: string; kind: string; issue_date: string; due_date: string; client_id: string; client_name: string;
  total_xof: number; paid_xof: number; balance_xof: number; days_overdue: number; aging_bucket: string;
}
interface InvoiceRow { id: string; number: string; kind: string; issue_date: string; due_date: string; status: string; total_xof: number; paid_xof: number; clients: { name: string } }
interface Note { id: string; kind: string; note: string | null; promised_date: string | null; promised_xof: number | null; status: string; created_at: string }
interface Payment { amount_xof: number; method: string; paid_at: string; reference: string | null; invoices: { number: string } }

const METHODS = [
  { value: 'especes', label: 'Espèces' }, { value: 'wave', label: 'Wave' }, { value: 'orange_money', label: 'Orange Money' },
  { value: 'virement', label: 'Virement' }, { value: 'cheque', label: 'Chèque' }, { value: 'autre', label: 'Autre' },
];
const NOTE_KIND: Record<string, string> = { note: 'Note', appel: 'Appel', whatsapp: 'WhatsApp', visite: 'Visite', promesse: 'Promesse' };
const BUCKETS: { key: string; label: string; color: string }[] = [
  { key: 'a_echoir', label: 'À échoir', color: '#34C759' }, { key: '1-30j', label: '1–30 j', color: '#FF9500' },
  { key: '31-60j', label: '31–60 j', color: '#FF6B00' }, { key: '60j+', label: '+60 j', color: '#FF3B30' },
];

export function Receivables({ profile }: { profile: Profile }) {
  const [view, setView] = useState<'clients' | 'factures'>('clients');
  const [filter, setFilter] = useState<'tous' | 'retard' | 'limite'>('tous');
  const [rows, setRows] = useState<ClientBalance[]>([]);
  const [recv, setRecv] = useState<Receivable[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [paidMonth, setPaidMonth] = useState(0);
  const [sel, setSel] = useState<ClientBalance | null>(null);
  const [selInvoice, setSelInvoice] = useState<string | null>(null);
  const [newInvoice, setNewInvoice] = useState<{ client?: string } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [terms, setTerms] = useState<{ limit: string; days: string } | null>(null);
  const [pay, setPay] = useState({ amount: '', method: 'especes', reference: '' });
  const [nv, setNv] = useState({ kind: 'appel', note: '', date: '', amount: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const month = new Date(); month.setDate(1);
    const [b, r, i, p] = await Promise.all([
      supabase.from('v_client_balances').select('*').gt('balance_xof', 0).order('overdue_xof', { ascending: false }).order('balance_xof', { ascending: false }),
      supabase.from('v_receivables').select('*'),
      supabase.from('invoices').select('id,number,kind,issue_date,due_date,status,total_xof,paid_xof,clients(name)').order('created_at', { ascending: false }).limit(60),
      supabase.from('payments').select('amount_xof').gte('paid_at', month.toISOString().slice(0, 10)),
    ]);
    setError(b.error?.message ?? null);
    setRows((b.data ?? []) as ClientBalance[]);
    setRecv((r.data ?? []) as Receivable[]);
    setInvoices((i.data ?? []) as unknown as InvoiceRow[]);
    setPaidMonth(((p.data ?? []) as { amount_xof: number }[]).reduce((s, x) => s + Number(x.amount_xof), 0));
  }, []);

  useEffect(() => {
    load();
    const ch = supabase.channel('creances').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'payments' }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const openClient = async (c: ClientBalance) => {
    setSel(c); setPay({ amount: '', method: 'especes', reference: '' }); setError(null); setTerms(null);
    setNv({ kind: 'appel', note: '', date: '', amount: '' });
    const [n, p] = await Promise.all([
      supabase.from('collection_notes').select('*').eq('client_id', c.client_id).order('created_at', { ascending: false }).limit(20),
      supabase.from('payments').select('amount_xof,method,paid_at,reference,invoices!inner(number,client_id)').eq('invoices.client_id', c.client_id)
        .order('paid_at', { ascending: false }).limit(10),
    ]);
    setNotes((n.data ?? []) as Note[]);
    setPayments((p.data ?? []) as unknown as Payment[]);
  };

  const encaisser = async () => {
    if (!sel) return;
    setBusy(true); setError(null);
    try {
      const r = await rpc<{ remaining_balance_xof: number }>('record_client_payment', {
        p_client: sel.client_name, p_amount_xof: Math.round(Number(pay.amount)), p_method: pay.method, p_reference: pay.reference || null,
      });
      setNotice(`${fcfa(pay.amount)} encaissés pour ${sel.client_name}. Reste dû : ${fcfa(r.remaining_balance_xof)}.`);
      setSel(null); load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const addNote = async () => {
    if (!sel) return;
    setBusy(true); setError(null);
    const { error } = await supabase.from('collection_notes').insert({
      client_id: sel.client_id, kind: nv.kind, note: nv.note || null,
      promised_date: nv.kind === 'promesse' ? nv.date || null : null,
      promised_xof: nv.kind === 'promesse' && nv.amount ? Math.round(Number(nv.amount)) : null,
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    setNv({ kind: 'appel', note: '', date: '', amount: '' });
    openClient(sel);
  };

  const saveTerms = async () => {
    if (!sel || !terms) return;
    setBusy(true); setError(null);
    const { error } = await supabase.from('clients').update({
      credit_limit_xof: Math.round(Number(terms.limit || 0)), payment_terms_days: Math.round(Number(terms.days || 0)),
    }).eq('id', sel.client_id);
    setBusy(false);
    if (error) { setError(error.message); return; }
    setTerms(null); setNotice('Conditions mises à jour.'); load();
  };

  const total = rows.reduce((s, r) => s + Number(r.balance_xof), 0);
  const overdue = rows.reduce((s, r) => s + Number(r.overdue_xof), 0);
  const aging = BUCKETS.map((b) => ({ ...b, value: recv.filter((r) => r.aging_bucket === b.key).reduce((s, r) => s + Number(r.balance_xof), 0) }));
  const shown = rows.filter((r) => filter === 'tous' || (filter === 'retard' ? r.overdue_xof > 0 : r.over_limit));
  const clientInvoices = sel ? recv.filter((r) => r.client_id === sel.client_id).sort((a, b) => a.due_date.localeCompare(b.due_date)) : [];

  const reminder = (c: ClientBalance) =>
    `Bonjour ${c.client_name}, voici votre relevé chez ODS :\n` +
    clientInvoices.map((i) => `• ${i.number} du ${shortDate(i.issue_date)} : ${fcfa(i.balance_xof)}${i.days_overdue > 0 ? ` (échue depuis ${i.days_overdue} j)` : ` (échéance ${shortDate(i.due_date)})`}`).join('\n') +
    `\nTotal dû : ${fcfa(c.balance_xof)}` + (c.overdue_xof > 0 ? `, dont ${fcfa(c.overdue_xof)} échus.` : '.') +
    '\nPaiement possible par Wave, Orange Money ou virement. Merci de nous indiquer la date de règlement.';

  return (
    <Screen title="Créances" subtitle={`${fcfa(total)} dus · ${fcfa(overdue)} en retard`}
      right={<button onClick={() => setNewInvoice({})} className="flex items-center gap-1 rounded-full bg-brand text-white px-3 py-1.5 text-caption font-semibold">
        <Plus size={16} /> Facture</button>}>
      {notice && <p className="rounded-2xl bg-surface-card text-caption px-4 py-3" onClick={() => setNotice(null)}>
        <span className="text-status-success font-semibold">Fait · </span>{notice}</p>}

      {/* Synthèse */}
      <div className="bg-surface-card rounded-2xl p-4 space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div><p className="text-caption text-text-secondary">À encaisser</p><p className="text-body font-semibold tabular-nums">{fcfa(total)}</p></div>
          <div><p className="text-caption text-text-secondary">En retard</p><p className={cx('text-body font-semibold tabular-nums', overdue > 0 && 'text-status-danger')}>{fcfa(overdue)}</p></div>
          <div><p className="text-caption text-text-secondary">Encaissé (mois)</p><p className="text-body font-semibold tabular-nums text-status-success">{fcfa(paidMonth)}</p></div>
        </div>
        {total > 0 && (
          <>
            <div className="flex h-2 rounded-full overflow-hidden bg-surface-subtle">
              {aging.map((a) => a.value > 0 && <span key={a.key} style={{ width: `${(100 * a.value) / total}%`, background: a.color }} />)}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {aging.map((a) => (
                <span key={a.key} className="flex items-center gap-1 text-micro text-text-secondary">
                  <span className="w-2 h-2 rounded-full" style={{ background: a.color }} />{a.label} {fcfa(a.value)}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex gap-0.5 bg-surface-subtle rounded-[10px] p-0.5">
        {(['clients', 'factures'] as const).map((k) => (
          <button key={k} onClick={() => setView(k)} className={cx('flex-1 rounded-[8px] py-1.5 text-caption font-semibold',
            view === k ? 'bg-surface-card text-text-primary shadow-sm' : 'text-text-secondary')}>
            {k === 'clients' ? 'Par client' : 'Factures'}
          </button>
        ))}
      </div>

      {view === 'clients' ? <>
        <div className="flex gap-2">
          {([['tous', 'Tous'], ['retard', 'En retard'], ['limite', 'Limite dépassée']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={cx('rounded-full px-3 py-1 text-caption font-semibold border',
              filter === k ? 'bg-brand text-white border-brand' : 'bg-surface-card text-text-secondary border-border-default')}>{l}</button>
          ))}
        </div>
        {!sel && <ErrorNote error={error} />}
        {shown.length === 0 && <Empty>Aucune créance {filter === 'tous' ? 'en cours' : 'dans ce filtre'}.</Empty>}
        {shown.map((c) => (
          <Card key={c.client_id} onClick={() => openClient(c)}>
            <div className="flex justify-between items-start gap-3">
              <div className="min-w-0">
                <p className="text-body font-bold truncate">{c.client_name}</p>
                <p className="text-caption text-text-muted">{c.open_invoices} facture{c.open_invoices > 1 ? 's' : ''} ouverte{c.open_invoices > 1 ? 's' : ''}</p>
              </div>
              <p className="text-body font-bold text-brand-ink shrink-0 tabular-nums">{fcfa(c.balance_xof)}</p>
            </div>
            {c.credit_limit_xof > 0 && (
              <div className="h-1.5 rounded-full bg-surface-subtle overflow-hidden mt-2">
                <div className={cx('h-full rounded-full', c.over_limit ? 'bg-status-danger' : 'bg-brand')}
                  style={{ width: `${Math.min(100, (100 * c.balance_xof) / c.credit_limit_xof)}%` }} />
              </div>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
              {c.overdue_xof > 0 && <Badge tone={(c.max_days_overdue ?? 0) > 30 ? 'danger' : 'warn'}>{fcfa(c.overdue_xof)} en retard · {c.max_days_overdue} j</Badge>}
              {c.over_limit && <Badge tone="danger">Limite dépassée</Badge>}
            </div>
          </Card>
        ))}
      </> : <>
        {invoices.length === 0 && <Empty>Aucune facture.</Empty>}
        <div className="bg-surface-card rounded-2xl overflow-hidden">
          {invoices.map((i, k) => {
            const bal = Number(i.total_xof) - Number(i.paid_xof);
            const late = bal > 0 && i.status !== 'annulee' && new Date(i.due_date) < new Date(new Date().toDateString());
            return (
              <button key={i.id} onClick={() => setSelInvoice(i.id)} className={cx('w-full flex items-center justify-between gap-3 px-4 py-3 text-left', k > 0 && 'border-t border-border-default')}>
                <span className="min-w-0">
                  <span className="block text-body text-text-primary truncate">{i.clients?.name}</span>
                  <span className="block text-caption text-text-muted">{i.number} · {shortDate(i.issue_date)}</span>
                </span>
                <span className="text-right shrink-0">
                  <span className="block text-body font-semibold tabular-nums">{fcfa(i.total_xof)}</span>
                  <span className={cx('block text-micro font-semibold', bal <= 0 ? 'text-status-success' : late ? 'text-status-danger' : 'text-status-warning')}>
                    {bal <= 0 ? 'Payée' : late ? `En retard · ${fcfa(bal)}` : `À payer · ${fcfa(bal)}`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </>}

      {/* Fiche client */}
      <Sheet open={!!sel} title={sel?.client_name ?? ''} onClose={() => setSel(null)}>
        {sel && <>
          <div className="rounded-2xl bg-surface-subtle p-4 space-y-1">
            <div className="flex justify-between"><span className="text-caption text-text-secondary">Doit</span><b className="tabular-nums">{fcfa(sel.balance_xof)}</b></div>
            {sel.overdue_xof > 0 && <div className="flex justify-between text-status-danger"><span className="text-caption">En retard</span><b className="tabular-nums">{fcfa(sel.overdue_xof)} · {sel.max_days_overdue} j</b></div>}
            <div className="flex justify-between"><span className="text-caption text-text-secondary">Limite de crédit</span>
              <span className="tabular-nums">{sel.credit_limit_xof ? fcfa(sel.credit_limit_xof) : 'aucune'}</span></div>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {sel.phone && <a href={`tel:${sel.phone}`} className="flex flex-col items-center gap-1 rounded-2xl bg-surface-subtle py-3 text-micro font-semibold text-brand"><Phone size={18} />Appeler</a>}
            {sel.phone && <a href={`https://wa.me/${waNumber(sel.phone)}?text=${encodeURIComponent(reminder(sel))}`} target="_blank" rel="noreferrer"
              className="flex flex-col items-center gap-1 rounded-2xl bg-status-success-bg py-3 text-micro font-semibold text-status-success"><MessageCircle size={18} />Relevé</a>}
            <button onClick={() => { setNewInvoice({ client: sel.client_name }); setSel(null); }}
              className="flex flex-col items-center gap-1 rounded-2xl bg-surface-subtle py-3 text-micro font-semibold text-brand"><FileText size={18} />Facturer</button>
            <button onClick={() => setTerms({ limit: String(sel.credit_limit_xof || ''), days: '' })}
              className="flex flex-col items-center gap-1 rounded-2xl bg-surface-subtle py-3 text-micro font-semibold text-brand"><Pencil size={18} />Conditions</button>
          </div>
          {terms && (
            <div className="rounded-2xl border border-border-default p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Limite de crédit"><Input inputMode="numeric" value={terms.limit} onChange={(e) => setTerms({ ...terms, limit: e.target.value })} placeholder="0 = aucune" /></Field>
                <Field label="Paiement à (jours)"><Input inputMode="numeric" value={terms.days} onChange={(e) => setTerms({ ...terms, days: e.target.value })} /></Field>
              </div>
              <Button className="w-full" disabled={busy} onClick={saveTerms}>Enregistrer les conditions</Button>
            </div>
          )}

          <p className="text-caption text-text-secondary px-1">Factures ouvertes</p>
          <div className="bg-surface-card border border-border-default rounded-2xl overflow-hidden">
            {clientInvoices.map((i, k) => (
              <button key={i.invoice_id} onClick={() => setSelInvoice(i.invoice_id)} className={cx('w-full flex justify-between gap-3 px-4 py-3 text-left', k > 0 && 'border-t border-border-default')}>
                <span><span className="block text-body">{i.number}</span>
                  <span className={cx('block text-caption', i.days_overdue > 0 ? 'text-status-danger' : 'text-text-muted')}>
                    {i.days_overdue > 0 ? `En retard de ${i.days_overdue} j` : `Échéance ${shortDate(i.due_date)}`}</span></span>
                <span className="text-body font-semibold tabular-nums">{fcfa(i.balance_xof)}</span>
              </button>
            ))}
          </div>

          <p className="text-caption text-text-secondary px-1 pt-1">Encaisser</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Montant"><Input inputMode="numeric" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value.replace(/\D/g, '') })} placeholder={String(sel.balance_xof)} /></Field>
            <Field label="Mode"><Select options={METHODS} value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} /></Field>
          </div>
          <Field label="Référence (optionnel)"><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder="N° transaction Wave…" /></Field>
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => setPay({ ...pay, amount: String(sel.balance_xof) })}>Tout</Button>
            <Button className="flex-[2]" disabled={busy || !Number(pay.amount)} onClick={encaisser}>{busy ? '…' : `Encaisser ${pay.amount ? fcfa(pay.amount) : ''}`}</Button>
          </div>

          <p className="text-caption text-text-secondary px-1 pt-1 flex items-center gap-1"><NotebookPen size={14} /> Suivi de relance</p>
          <div className="rounded-2xl border border-border-default p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Type"><Select options={Object.entries(NOTE_KIND).map(([value, label]) => ({ value, label }))} value={nv.kind} onChange={(e) => setNv({ ...nv, kind: e.target.value })} /></Field>
              <Field label="Note"><Input value={nv.note} onChange={(e) => setNv({ ...nv, note: e.target.value })} placeholder="Ce qui a été dit" /></Field>
            </div>
            {nv.kind === 'promesse' && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Paiera le"><Input type="date" value={nv.date} onChange={(e) => setNv({ ...nv, date: e.target.value })} /></Field>
                <Field label="Montant promis"><Input inputMode="numeric" value={nv.amount} onChange={(e) => setNv({ ...nv, amount: e.target.value.replace(/\D/g, '') })} /></Field>
              </div>
            )}
            <Button variant="ghost" className="w-full" disabled={busy || (nv.kind === 'promesse' ? !nv.date : !nv.note)} onClick={addNote}>Ajouter au suivi</Button>
            {nv.kind === 'promesse' && <p className="text-caption text-text-muted">DEPOTEK vous préviendra si la promesse n’est pas tenue.</p>}
          </div>
          {notes.map((n) => (
            <div key={n.id} className="flex justify-between gap-2 px-1">
              <p className="text-caption text-text-secondary">
                <b>{NOTE_KIND[n.kind]}</b> · {shortDate(n.created_at)}{n.note ? ` — ${n.note}` : ''}
                {n.kind === 'promesse' && ` — ${n.promised_xof ? fcfa(n.promised_xof) : ''} le ${shortDate(n.promised_date)}`}
              </p>
              {n.kind === 'promesse' && <Badge tone={n.status === 'tenue' ? 'ok' : n.status === 'non_tenue' ? 'danger' : 'muted'}>
                {n.status === 'tenue' ? 'Tenue' : n.status === 'non_tenue' ? 'Non tenue' : 'En cours'}</Badge>}
            </div>
          ))}

          {payments.length > 0 && <>
            <p className="text-caption text-text-secondary px-1 pt-1">Derniers paiements</p>
            {payments.map((p, i) => (
              <div key={i} className="flex justify-between px-1 text-caption">
                <span className="text-text-secondary">{shortDate(p.paid_at)} · {METHODS.find((m) => m.value === p.method)?.label ?? p.method} · {p.invoices?.number}</span>
                <span className="font-semibold tabular-nums text-status-success">{fcfa(p.amount_xof)}</span>
              </div>
            ))}
          </>}
          <ErrorNote error={error} />
        </>}
      </Sheet>

      <Sheet open={!!selInvoice} title="Facture" onClose={() => setSelInvoice(null)}>
        {selInvoice && <InvoiceView invoiceId={selInvoice} />}
      </Sheet>

      <Sheet open={!!newInvoice} title="Nouvelle facture" onClose={() => setNewInvoice(null)}>
        {newInvoice && <InvoiceForm profile={profile} initialClient={newInvoice.client}
          onDone={(r) => { setNewInvoice(null); setNotice(`Facture ${r.invoice_number} créée : ${fcfa(r.total_xof)}.`); load(); setSelInvoice(r.invoice_id); }} />}
      </Sheet>
    </Screen>
  );
}
