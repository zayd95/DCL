import React, { useCallback, useEffect, useState } from 'react';
import { Phone, MessageCircle } from 'lucide-react';
import { supabase, rpc } from '../supabase';
import { Screen, Card, Badge, Empty, ErrorNote, Sheet, Field, Input, Select, Button, fcfa, shortDate } from '../ui';

interface ClientBalance {
  client_id: string; client_name: string; phone: string | null; credit_limit_xof: number;
  balance_xof: number; overdue_xof: number; max_days_overdue: number | null; open_invoices: number; over_limit: boolean;
}
interface Receivable {
  invoice_id: string; number: string; kind: string; issue_date: string; due_date: string;
  total_xof: number; paid_xof: number; balance_xof: number; days_overdue: number;
}

const METHODS = [
  { value: 'especes', label: 'Espèces' }, { value: 'wave', label: 'Wave' },
  { value: 'orange_money', label: 'Orange Money' }, { value: 'virement', label: 'Virement' },
  { value: 'cheque', label: 'Chèque' }, { value: 'autre', label: 'Autre' },
];

/** Numéro sénégalais → format international pour WhatsApp */
const waNumber = (phone: string) => {
  const d = phone.replace(/\D/g, '');
  return d.length === 9 ? '221' + d : d;
};

export function Receivables() {
  const [rows, setRows] = useState<ClientBalance[]>([]);
  const [sel, setSel] = useState<ClientBalance | null>(null);
  const [invoices, setInvoices] = useState<Receivable[]>([]);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('especes');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('v_client_balances').select('*').gt('balance_xof', 0)
      .order('overdue_xof', { ascending: false }).order('balance_xof', { ascending: false });
    setError(error?.message ?? null);
    setRows((data ?? []) as ClientBalance[]);
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = async (c: ClientBalance) => {
    setSel(c); setAmount(''); setReference(''); setError(null);
    const { data } = await supabase.from('v_receivables').select('*').eq('client_id', c.client_id).order('due_date');
    setInvoices((data ?? []) as Receivable[]);
  };

  const pay = async () => {
    if (!sel) return;
    setBusy(true); setError(null);
    try {
      const r = await rpc<{ remaining_balance_xof: number }>('record_client_payment', {
        p_client: sel.client_name, p_amount_xof: Math.round(Number(amount)), p_method: method, p_reference: reference,
      });
      setNotice(`${fcfa(amount)} encaissés pour ${sel.client_name}. Reste dû : ${fcfa(r.remaining_balance_xof)}.`);
      setSel(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const total = rows.reduce((s, r) => s + Number(r.balance_xof), 0);
  const overdue = rows.reduce((s, r) => s + Number(r.overdue_xof), 0);

  const reminder = (c: ClientBalance) =>
    `Bonjour ${c.client_name}, petit rappel : votre solde chez ODS est de ${fcfa(c.balance_xof)}` +
    (c.overdue_xof > 0 ? `, dont ${fcfa(c.overdue_xof)} échus.` : '.') + ' Merci de nous indiquer la date de règlement.';

  return (
    <Screen title="Créances" subtitle={`${fcfa(total)} dus · ${fcfa(overdue)} en retard`}>
      {notice && <p className="rounded-xl bg-status-success-bg text-status-success text-body p-3" onClick={() => setNotice(null)}>{notice}</p>}
      {!sel && <ErrorNote error={error} />}
      {rows.length === 0 && <Empty>Aucune créance en cours.</Empty>}
      {rows.map((c) => (
        <Card key={c.client_id} onClick={() => open(c)}>
          <div className="flex justify-between items-start gap-3">
            <div className="min-w-0">
              <p className="text-body font-bold truncate">{c.client_name}</p>
              <p className="text-caption text-text-muted">{c.open_invoices} facture(s) ouverte(s)</p>
            </div>
            <p className="text-title font-black text-brand-ink shrink-0">{fcfa(c.balance_xof)}</p>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {c.overdue_xof > 0 && <Badge tone={(c.max_days_overdue ?? 0) > 30 ? 'danger' : 'warn'}>
              {fcfa(c.overdue_xof)} en retard · {c.max_days_overdue} j</Badge>}
            {c.over_limit && <Badge tone="danger">Limite dépassée</Badge>}
          </div>
        </Card>
      ))}

      <Sheet open={!!sel} title={sel?.client_name ?? ''} onClose={() => setSel(null)}>
        {sel?.phone && (
          <div className="flex gap-2">
            <a href={`tel:${sel.phone}`} className="flex-1 flex items-center justify-center gap-2 bg-surface-subtle rounded-xl py-3 text-body font-bold">
              <Phone size={16} /> Appeler</a>
            <a href={`https://wa.me/${waNumber(sel.phone)}?text=${encodeURIComponent(reminder(sel))}`} target="_blank" rel="noreferrer"
              className="flex-1 flex items-center justify-center gap-2 bg-status-success-bg text-status-success rounded-xl py-3 text-body font-bold">
              <MessageCircle size={16} /> Relancer</a>
          </div>
        )}
        <div className="space-y-2">
          {invoices.map((i) => (
            <div key={i.invoice_id} className="flex justify-between border-b border-border-default pb-2">
              <div>
                <p className="text-body font-bold">{i.number}</p>
                <p className="text-caption text-text-muted">Échéance {shortDate(i.due_date)}{i.days_overdue > 0 && ` · ${i.days_overdue} j de retard`}</p>
              </div>
              <p className="text-body font-bold">{fcfa(i.balance_xof)}</p>
            </div>
          ))}
        </div>
        <h3 className="text-label font-black uppercase tracking-widest text-text-secondary pt-2">Encaisser un paiement</h3>
        <Field label="Montant (FCFA)"><Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Mode"><Select options={METHODS} value={method} onChange={(e) => setMethod(e.target.value)} /></Field>
        <Field label="Référence (optionnel)"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="N° transaction Wave…" /></Field>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !Number(amount)} onClick={pay}>
          {busy ? '…' : `Encaisser ${amount ? fcfa(amount) : ''}`}
        </Button>
        <p className="text-caption text-text-muted">Le paiement est imputé sur les factures dont l’échéance est la plus proche.</p>
      </Sheet>
    </Screen>
  );
}
