import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Printer, MessageCircle, Banknote, AlertTriangle } from 'lucide-react';
import { supabase, rpc, type Profile, canSeeFinance, canManage } from '../supabase';
import { Field, Input, Select, Button, ErrorNote, Badge, fcfa, qty, shortDate } from '../ui';
import { cx } from '../cx';
import { useNav } from '../nav';

interface Product { sku: string; name: string; unit_type: string; default_price_xof: number | null }
interface QuoteLine {
  product: string; sku: string; unit: string; qty: number; price: number | null; default_price: number | null; available: number;
  line_total: number; cost: number; margin: number; unit_cost: number | null; warnings: string[];
}
interface Quote {
  client: string | null; credit_limit: number | null; terms_days: number | null; balance: number; overdue: number;
  total: number; cost: number; margin: number; margin_pct: number | null; over_limit: boolean; ok: boolean; due_date: string; lines: QuoteLine[];
}
type Line = { product: string; qty: string; price: string };

export const waNumber = (phone: string) => {
  const d = phone.replace(/\D/g, '');
  return d.length === 9 ? '221' + d : d;
};

/** Nouvelle facture : plusieurs produits, contrôle en direct du stock, du prix de revient, de la marge et du crédit. */
export function InvoiceForm({ profile, initialClient, onDone }: {
  profile: Profile; initialClient?: string; onDone: (r: { invoice_id: string; invoice_number: string; total_xof: number }) => void;
}) {
  const finance = canSeeFinance(profile.role);
  const manager = canManage(profile.role);
  const [products, setProducts] = useState<Product[]>([]);
  const [clients, setClients] = useState<{ name: string }[]>([]);
  const [depots, setDepots] = useState<{ code: string; name: string }[]>([]);
  const [client, setClient] = useState(initialClient ?? '');
  const [depot, setDepot] = useState('');
  const [lines, setLines] = useState<Line[]>([{ product: '', qty: '', price: '' }]);
  const [dueDays, setDueDays] = useState('');
  const [notes, setNotes] = useState('');
  const [force, setForce] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    Promise.all([
      supabase.from('products').select('sku,name,unit_type,default_price_xof').eq('active', true).order('name'),
      supabase.from('clients').select('name').eq('active', true).order('name'),
      supabase.from('depots').select('code,name').eq('active', true).order('code'),
    ]).then(([p, c, d]) => { setProducts((p.data ?? []) as Product[]); setClients(c.data ?? []); setDepots(d.data ?? []); });
  }, []);

  const payload = useMemo(() => lines.filter((l) => l.product).map((l) => ({
    product: l.product, qty: Number(l.qty.replace(',', '.')) || 0, ...(l.price ? { price: Math.round(Number(l.price.replace(/\s/g, ''))) } : {}),
  })), [lines]);

  // Aperçu en direct (prix, stock, marge, crédit)
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!payload.length) { setQuote(null); return; }
    timer.current = window.setTimeout(async () => {
      try { setQuote(await rpc<Quote>('sale_quote', { p_client: client || null, p_lines: payload, p_depot: depot || null })); }
      catch { /* aperçu indisponible */ }
    }, 350);
    return () => window.clearTimeout(timer.current);
  }, [payload, client, depot]);

  const setLine = (i: number, k: keyof Line, val: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: val } : l)));
  const qline = (sku: string) => quote?.lines.find((q) => q.sku === sku);
  const blocked = !!quote && !quote.ok;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await rpc<{ invoice_id: string; invoice_number: string; total_xof: number }>('create_sale', {
        p_client: client, p_lines: payload, p_depot: depot || null,
        p_due_days: dueDays ? Number(dueDays) : null, p_force: force, p_notes: notes || null,
      });
      onDone(r);
    } catch (e) { setError((e as Error).message.replace(/^VENTE BLOQUÉE — /, 'Bloquée : ')); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <Field label="Client"><Select options={clients.map((c) => ({ value: c.name, label: c.name }))} value={client} onChange={(e) => setClient(e.target.value)} /></Field>
      {quote?.client && finance && (
        <div className="flex flex-wrap gap-2">
          <Badge tone={quote.overdue > 0 ? 'danger' : 'muted'}>Doit {fcfa(quote.balance)}{quote.overdue > 0 ? ` · ${fcfa(quote.overdue)} en retard` : ''}</Badge>
          {quote.credit_limit ? <Badge tone={quote.over_limit ? 'danger' : 'info'}>Limite {fcfa(quote.credit_limit)}</Badge> : null}
          <Badge tone="muted">Paiement {quote.terms_days ?? 0} j</Badge>
        </div>
      )}

      {lines.map((l, i) => {
        const p = products.find((x) => x.sku === l.product);
        const q = qline(l.product);
        return (
          <div key={i} className="rounded-2xl border border-border-default p-3 space-y-2">
            <div className="flex gap-2 items-end">
              <div className="flex-1"><Field label={`Produit ${i + 1}`}>
                <Select options={products.map((x) => ({ value: x.sku, label: x.name }))} value={l.product} onChange={(e) => setLine(i, 'product', e.target.value)} />
              </Field></div>
              {lines.length > 1 && (
                <button aria-label="Retirer" onClick={() => setLines(lines.filter((_, j) => j !== i))} className="h-12 w-10 flex items-center justify-center text-text-muted">
                  <Trash2 size={18} /></button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={`Quantité${p ? ` (${p.unit_type})` : ''}`}><Input inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} /></Field>
              <Field label="Prix unitaire"><Input inputMode="numeric" value={l.price} onChange={(e) => setLine(i, 'price', e.target.value)}
                placeholder={p?.default_price_xof ? String(p.default_price_xof) : 'FCFA'} /></Field>
            </div>
            {q && (
              <p className="text-caption text-text-secondary">
                {qty(q.available)} dispo · {fcfa(q.line_total)}
                {finance && q.unit_cost != null && q.unit_cost > 0 && ` · coût ${fcfa(q.unit_cost)} · marge ${fcfa(q.margin)}`}
              </p>
            )}
            {q?.warnings.map((w) => (
              <p key={w} className="flex items-center gap-1 text-caption text-status-danger font-semibold"><AlertTriangle size={14} /> {w}</p>
            ))}
          </div>
        );
      })}
      <button onClick={() => setLines([...lines, { product: '', qty: '', price: '' }])}
        className="w-full flex items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong py-3 text-body text-brand font-semibold">
        <Plus size={18} /> Ajouter un produit
      </button>

      <div className="grid grid-cols-2 gap-3">
        {depots.length > 1 && <Field label="Entrepôt (optionnel)"><Select options={depots.map((d) => ({ value: d.code, label: d.name }))} value={depot} onChange={(e) => setDepot(e.target.value)} /></Field>}
        <Field label="Paiement à (jours)"><Input inputMode="numeric" value={dueDays} onChange={(e) => setDueDays(e.target.value)} placeholder={String(quote?.terms_days ?? 0)} /></Field>
      </div>
      <Field label="Note sur la facture"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Bon de commande n°…" /></Field>

      {quote && quote.total > 0 && (
        <div className="rounded-2xl bg-surface-subtle p-4 space-y-1">
          <div className="flex justify-between text-body"><span>Total</span><b className="tabular-nums">{fcfa(quote.total)}</b></div>
          {finance && <div className="flex justify-between text-caption text-text-secondary"><span>Marge estimée</span>
            <span className={cx('tabular-nums', quote.margin < 0 && 'text-status-danger')}>{fcfa(quote.margin)}{quote.margin_pct != null ? ` (${quote.margin_pct} %)` : ''}</span></div>}
          <div className="flex justify-between text-caption text-text-secondary"><span>Échéance</span>
            <span>{shortDate(dueDays ? new Date(Date.now() + Number(dueDays) * 864e5).toISOString() : quote.due_date)}</span></div>
          {quote.over_limit && <p className="text-caption text-status-danger font-semibold pt-1">Limite de crédit dépassée avec cette facture.</p>}
        </div>
      )}
      {blocked && manager && (
        <label className="flex items-center gap-2 text-caption text-text-secondary">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Dérogation manager (sera signalée)
        </label>
      )}
      <ErrorNote error={error} />
      <Button className="w-full" disabled={busy || !client || !payload.length || (blocked && !force)} onClick={submit}>
        {busy ? '…' : quote?.total ? `Créer la facture · ${fcfa(quote.total)}` : 'Créer la facture'}
      </Button>
      <p className="text-caption text-text-muted text-center">Les lots qui expirent en premier sortent d’abord (FEFO). Le stock et la créance se mettent à jour tout de suite.</p>
    </div>
  );
}

interface InvoiceData {
  inv: { id: string; number: string; kind: string; issue_date: string; due_date: string; status: string; total_xof: number; paid_xof: number; notes: string | null;
    clients: { name: string; phone: string | null } };
  lines: { product: string; unit: string; qty: number; price: number; total: number; lots: string[] }[];
  payments: { amount_xof: number; method: string; paid_at: string; reference: string | null }[];
  company: Record<string, string>;
}

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }> = {
  emise: { label: 'À payer', tone: 'warn' }, partielle: { label: 'Partiellement payée', tone: 'warn' }, payee: { label: 'Payée', tone: 'ok' },
  annulee: { label: 'Annulée', tone: 'muted' }, brouillon: { label: 'Brouillon', tone: 'muted' },
};

/** Facture : aperçu imprimable (PDF depuis l'iPhone), envoi WhatsApp, encaissement. */
export function InvoiceView({ invoiceId }: { invoiceId: string }) {
  const { openOp } = useNav();
  const [d, setD] = useState<InvoiceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [i, l, p, s] = await Promise.all([
        supabase.from('invoices').select('id,number,kind,issue_date,due_date,status,total_xof,paid_xof,notes,clients(name,phone)').eq('id', invoiceId).single(),
        supabase.from('invoice_lines').select('description,qty,unit_price_xof,product_id,products(name,unit_type),lots(lot_number)').eq('invoice_id', invoiceId),
        supabase.from('payments').select('amount_xof,method,paid_at,reference').eq('invoice_id', invoiceId).order('paid_at'),
        supabase.from('app_settings').select('key,value').like('key', 'company_%'),
      ]);
      if (i.error) { setError(i.error.message); return; }
      // Regroupe les lignes par produit et prix (une ligne par lot côté base)
      const map = new Map<string, InvoiceData['lines'][number]>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (l.data ?? []) as any[]) {
        const name = r.products?.name ?? r.description;
        const k = `${name}|${r.unit_price_xof}`;
        const cur = map.get(k) ?? { product: name, unit: r.products?.unit_type ?? '', qty: 0, price: Number(r.unit_price_xof), total: 0, lots: [] as string[] };
        cur.qty += Number(r.qty); cur.total += Number(r.qty) * Number(r.unit_price_xof);
        if (r.lots?.lot_number) cur.lots.push(r.lots.lot_number);
        map.set(k, cur);
      }
      const company: Record<string, string> = {};
      for (const r of (s.data ?? []) as { key: string; value: string }[]) company[r.key] = r.value;
      const { data: f } = await supabase.from('app_settings').select('value').eq('key', 'invoice_footer').maybeSingle();
      company.invoice_footer = f?.value ?? '';
      setD({ inv: i.data as unknown as InvoiceData['inv'], lines: [...map.values()], payments: (p.data ?? []) as InvoiceData['payments'], company });
    })();
  }, [invoiceId]);

  if (error) return <ErrorNote error={error} />;
  if (!d) return <p className="text-caption text-text-muted">Chargement…</p>;
  const { inv, lines, payments, company } = d;
  const balance = Number(inv.total_xof) - Number(inv.paid_xof);
  const late = balance > 0 && new Date(inv.due_date) < new Date(new Date().toDateString());
  const st = STATUS[inv.status] ?? { label: inv.status, tone: 'muted' as const };
  const text = `${company.company_name || 'ODS'} — Facture ${inv.number} du ${shortDate(inv.issue_date)}\n` +
    lines.map((l) => `• ${l.product} : ${qty(l.qty)} × ${fcfa(l.price)} = ${fcfa(l.total)}`).join('\n') +
    `\nTotal : ${fcfa(inv.total_xof)}` + (Number(inv.paid_xof) > 0 ? `\nDéjà payé : ${fcfa(inv.paid_xof)}` : '') +
    (balance > 0 ? `\nReste à payer : ${fcfa(balance)} avant le ${shortDate(inv.due_date)}` : '\nFacture réglée. Merci !');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge tone={late ? 'danger' : st.tone}>{late ? 'En retard' : st.label}</Badge>
        {balance > 0 && <span className="text-caption text-text-secondary">Reste {fcfa(balance)} · échéance {shortDate(inv.due_date)}</span>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button onClick={() => window.print()} className="flex flex-col items-center gap-1 rounded-2xl bg-surface-subtle py-3 text-caption font-semibold text-brand">
          <Printer size={20} /> PDF / Imprimer</button>
        <a href={`https://wa.me/${inv.clients.phone ? waNumber(inv.clients.phone) : ''}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer"
          className="flex flex-col items-center gap-1 rounded-2xl bg-status-success-bg py-3 text-caption font-semibold text-status-success">
          <MessageCircle size={20} /> WhatsApp</a>
        <button disabled={balance <= 0} onClick={() => openOp('encaissement', { client: inv.clients.name, amount: String(balance) })}
          className="flex flex-col items-center gap-1 rounded-2xl bg-surface-subtle py-3 text-caption font-semibold text-brand disabled:opacity-40">
          <Banknote size={20} /> Encaisser</button>
      </div>

      {/* Document imprimable */}
      <div className="print-area bg-white rounded-2xl border border-border-default p-5 text-[13px] text-black">
        <div className="flex justify-between gap-4">
          <div>
            <p className="text-[18px] font-black text-[#1a237e]">{company.company_name || 'OURY DIALLO SARL'}</p>
            <p>{company.company_address}</p>
            {company.company_phone && <p>Tél. {company.company_phone}</p>}
            {(company.company_ninea || company.company_rccm) && <p>{[company.company_ninea && `NINEA ${company.company_ninea}`, company.company_rccm && `RCCM ${company.company_rccm}`].filter(Boolean).join(' · ')}</p>}
          </div>
          <div className="text-right">
            <p className="text-[16px] font-black">{inv.kind === 'stockage' ? 'FACTURE STOCKAGE' : 'FACTURE'}</p>
            <p className="font-bold">{inv.number}</p>
            <p>Date : {shortDate(inv.issue_date)}</p>
            <p>Échéance : {shortDate(inv.due_date)}</p>
          </div>
        </div>
        <div className="mt-4 rounded-lg bg-[#f3f4f8] p-3">
          <p className="text-[11px] uppercase tracking-wide text-[#555]">Client</p>
          <p className="font-bold">{inv.clients.name}</p>
          {inv.clients.phone && <p>{inv.clients.phone}</p>}
        </div>
        <table className="w-full mt-4">
          <thead><tr className="text-left text-[11px] uppercase text-[#555] border-b border-[#ddd]">
            <th className="py-1">Désignation</th><th className="py-1 text-right">Qté</th><th className="py-1 text-right">P.U.</th><th className="py-1 text-right">Montant</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-b border-[#eee] align-top">
                <td className="py-2">{l.product}{l.lots.length > 0 && <span className="block text-[11px] text-[#777]">Lot {l.lots.join(', ')}</span>}</td>
                <td className="py-2 text-right tabular-nums">{qty(l.qty)} {l.unit}</td>
                <td className="py-2 text-right tabular-nums">{fcfa(l.price)}</td>
                <td className="py-2 text-right tabular-nums font-semibold">{fcfa(l.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 ml-auto w-2/3 space-y-1">
          <div className="flex justify-between font-black text-[15px]"><span>Total</span><span className="tabular-nums">{fcfa(inv.total_xof)}</span></div>
          {payments.map((p, i) => (
            <div key={i} className="flex justify-between text-[12px] text-[#555]"><span>Payé le {shortDate(p.paid_at)} ({p.method})</span><span className="tabular-nums">− {fcfa(p.amount_xof)}</span></div>
          ))}
          <div className="flex justify-between font-bold border-t border-[#ddd] pt-1"><span>Reste à payer</span><span className="tabular-nums">{fcfa(balance)}</span></div>
        </div>
        {inv.notes && <p className="mt-3 text-[12px]">Note : {inv.notes}</p>}
        {company.invoice_footer && <p className="mt-4 text-center text-[11px] text-[#777]">{company.invoice_footer}</p>}
      </div>
    </div>
  );
}
