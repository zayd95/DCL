import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, Banknote, ClipboardCheck, DoorOpen, KeyRound, MoveRight,
  UserPlus, AlertTriangle, ChevronRight, Camera, Sparkles, type LucideIcon,
} from 'lucide-react';
import { supabase, rpc, type Profile, type Role, canSeeFinance, uploadDocument } from '../supabase';
import { cx } from '../cx';
import { useRooms } from './Rooms';
import { Screen, Sheet, Field, Input, Select, Button, ErrorNote, fcfa, qty } from '../ui';

interface Product { id: string; sku: string; name: string; unit_type: string; default_price_xof: number | null }
interface Named { id: string; name: string; code?: string }
interface LotRow { sku: string; product_name: string; lot_number: string; depot_code: string; room_name: string | null; quantity: number; unit_type: string }
interface JournalItem { at: string; kind: string; title: string; detail: string | null; amount_xof: number | null; by: string | null }
interface Day {
  finance: boolean; sales_count: number; sales_xof: number | null; margin_xof: number | null; payments_xof: number | null;
  receptions_count: number; qty_in: number; qty_out: number; journal: JournalItem[];
}

type Form = 'vente' | 'reception' | 'encaissement' | 'transfert' | 'deplacer' | 'inventaire' | 'client' | 'location' | 'fin_location';

const ACTIONS: { key: Form; label: string; icon: LucideIcon; roles: Role[]; color?: string }[] = [
  { key: 'vente', label: 'Vente', icon: ArrowUpFromLine, roles: ['magasinier', 'manager', 'cfo', 'admin'] },
  { key: 'reception', label: 'Réception', icon: ArrowDownToLine, roles: ['magasinier', 'manager', 'admin'] },
  { key: 'encaissement', label: 'Encaisser', icon: Banknote, roles: ['manager', 'cfo', 'admin'], color: '#34C759' },
  { key: 'transfert', label: 'Transfert', icon: ArrowLeftRight, roles: ['magasinier', 'manager', 'admin'], color: '#007AFF' },
  { key: 'deplacer', label: 'Changer de chambre', icon: MoveRight, roles: ['magasinier', 'manager', 'admin'], color: '#30B0C7' },
  { key: 'inventaire', label: 'Inventaire / perte', icon: ClipboardCheck, roles: ['manager', 'admin'], color: '#FF9500' },
  { key: 'client', label: 'Nouveau client', icon: UserPlus, roles: ['manager', 'cfo', 'admin'], color: '#AF52DE' },
  { key: 'location', label: 'Louer une chambre', icon: KeyRound, roles: ['manager', 'cfo', 'admin'], color: '#1a237e' },
  { key: 'fin_location', label: 'Fin de location', icon: DoorOpen, roles: ['manager', 'cfo', 'admin'], color: '#FF3B30' },
];

const KIND: Record<string, { icon: LucideIcon; color: string }> = {
  vente: { icon: ArrowUpFromLine, color: '#1a237e' },
  reception: { icon: ArrowDownToLine, color: '#1a237e' },
  encaissement: { icon: Banknote, color: '#34C759' },
  transfert: { icon: ArrowLeftRight, color: '#007AFF' },
  location: { icon: KeyRound, color: '#1a237e' },
  perte: { icon: AlertTriangle, color: '#FF3B30' },
  ajustement: { icon: ClipboardCheck, color: '#FF9500' },
};

const PAY = [
  { value: 'especes', label: 'Espèces' }, { value: 'wave', label: 'Wave' }, { value: 'orange_money', label: 'Orange Money' },
  { value: 'virement', label: 'Virement' }, { value: 'cheque', label: 'Chèque' }, { value: 'autre', label: 'Autre' },
];

const isoDay = (offset: number) => {
  const d = new Date(); d.setDate(d.getDate() - offset);
  return d.toLocaleDateString('fr-CA', { timeZone: 'Africa/Dakar' });
};
const hhmm = (s: string) => new Date(s).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Dakar' });

export function Operations({ profile }: { profile: Profile }) {
  const finance = canSeeFinance(profile.role);
  const { rooms, reload: reloadRooms } = useRooms();
  const [dayOffset, setDayOffset] = useState(0);
  const [day, setDay] = useState<Day | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [clients, setClients] = useState<Named[]>([]);
  const [depots, setDepots] = useState<Named[]>([]);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [v, setV] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const docRef = useRef<HTMLInputElement>(null);

  const scanDoc = async (file: File) => {
    setBusy(true); setError(null);
    try {
      await uploadDocument(profile.id, file);
      setForm(null);
      setDone('Document envoyé. DEPOTEK le lit et prépare la réception : validez-la dans DEPOTEK › À traiter.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  // ── Journal du jour, rafraîchi en direct ──────────────────────────────────
  const loadDay = useCallback(async () => {
    try { setDay(await rpc<Day>('operations_day', { p_date: isoDay(dayOffset) })); } catch { /* garde l'affichage */ }
  }, [dayOffset]);
  useEffect(() => { loadDay(); }, [loadDay]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const ping = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(loadDay, 600); };
    const ch = supabase.channel('ops-journal')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stock_movements' }, ping)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'payments' }, ping)
      .subscribe();
    return () => { supabase.removeChannel(ch); window.clearTimeout(timer.current); };
  }, [loadDay]);

  // ── Données des formulaires ───────────────────────────────────────────────
  useEffect(() => {
    if (!form) return;
    (async () => {
      const [p, c, d, l] = await Promise.all([
        supabase.from('products').select('id,sku,name,unit_type,default_price_xof').eq('active', true).order('name'),
        supabase.from('clients').select('id,name').eq('active', true).order('name'),
        supabase.from('depots').select('id,name,code').eq('active', true).order('code'),
        supabase.from('v_stock_lots').select('sku,product_name,lot_number,depot_code,room_name,quantity,unit_type')
          .gt('quantity', 0).order('product_name').limit(300),
      ]);
      setProducts((p.data ?? []) as Product[]);
      setClients((c.data ?? []) as Named[]);
      setDepots((d.data ?? []) as Named[]);
      setLots((l.data ?? []) as LotRow[]);
    })();
  }, [form]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const openForm = (f: Form) => { setForm(f); setV({}); setError(null); setDone(null); };
  const product = products.find((p) => p.sku === v.product);
  const depotCode = v.depot || (depots.length === 1 ? depots[0].code : '');
  const lot = lots.find((l) => `${l.sku}|${l.lot_number}|${l.depot_code}` === v.lot_key);
  const n = (s?: string) => (s ? Number(s.replace(',', '.')) : undefined);
  const int = (s?: string) => (s ? Math.round(Number(s.replace(/\s/g, ''))) : undefined);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      let msg = '';
      switch (form) {
        case 'vente': {
          const r = await rpc<{ invoice_number: string; total_xof: number; picks: { lot_number: string; qty: number }[] }>('dispatch_fefo', {
            p_product: v.product, p_qty: n(v.qty), p_client: v.client, p_depot: depotCode || undefined,
            p_unit_price_xof: int(v.price), p_notes: v.note,
          });
          msg = `Facture ${r.invoice_number} : ${fcfa(r.total_xof)}. Lots : ${r.picks.map((p) => `${p.lot_number} (${qty(p.qty)})`).join(', ')}`;
          break;
        }
        case 'reception': {
          const room = rooms.find((r) => r.room_id === v.room);
          await rpc('receive_lot', {
            p_product: v.product, p_qty: n(v.qty), p_lot_number: v.lot, p_depot: room?.depot_code ?? (depotCode || undefined),
            p_expiry_date: v.expiry || undefined, p_cost_unit: n(v.cost), p_cost_currency: v.currency || 'XOF',
            p_fx_rate_to_xof: n(v.fx), p_supplier: v.supplier, p_container_no: v.container,
            p_owner_client: v.owner || undefined, p_storage_unit: room?.room_code,
          });
          msg = `Lot ${v.lot} reçu : ${qty(v.qty)} × ${product?.name ?? v.product}${room ? ` → ${room.room_name}` : ''}.`;
          break;
        }
        case 'encaissement': {
          const r = await rpc<{ amount_xof: number; remaining_balance_xof: number }>('record_client_payment', {
            p_client: v.client, p_amount_xof: int(v.amount), p_method: v.method || 'especes', p_reference: v.ref,
          });
          msg = `${fcfa(r.amount_xof)} encaissés de ${v.client}. Reste dû : ${fcfa(r.remaining_balance_xof)}.`;
          break;
        }
        case 'transfert':
          await rpc('transfer_stock', {
            p_product: v.product, p_qty: n(v.qty), p_from_depot: v.from, p_to_depot: v.to,
            p_to_room: rooms.find((r) => r.room_id === v.room)?.room_code,
          });
          msg = `${qty(v.qty)} × ${product?.name ?? v.product} transférés ${v.from} → ${v.to}${v.room ? ` (${rooms.find((r) => r.room_id === v.room)?.room_name})` : ''}.`;
          break;
        case 'deplacer': {
          const room = rooms.find((r) => r.room_id === v.room);
          await rpc('move_lot', { p_product: lot?.sku, p_lot_number: lot?.lot_number, p_room: room?.room_code, p_depot: lot?.depot_code });
          msg = `Lot ${lot?.lot_number} rangé dans ${room?.room_name}.`;
          break;
        }
        case 'inventaire': {
          const r = await rpc<{ delta: number; value_impact_xof: number }>('adjust_stock', {
            p_product: lot?.sku, p_lot_number: lot?.lot_number, p_counted_qty: n(v.counted), p_reason: v.reason,
            p_depot: lot?.depot_code, p_is_loss: v.loss === 'oui',
          });
          msg = Number(r.delta) === 0 ? 'Aucun écart.' : `Écart ${qty(r.delta)} sur le lot ${lot?.lot_number} (impact ${fcfa(r.value_impact_xof)}).`;
          break;
        }
        case 'client':
          await rpc('create_client', {
            p_name: v.name, p_phone: v.phone, p_type: v.type || 'grossiste',
            p_credit_limit_xof: int(v.credit) ?? 0, p_payment_terms_days: int(v.terms) ?? 0,
          });
          msg = `Client ${v.name} créé.`;
          break;
        case 'location': {
          const room = rooms.find((r) => r.room_id === v.room);
          const r = await rpc<{ invoices: { invoice_number: string; total_xof: number }[] }>('rent_room', {
            p_client: v.client, p_room: room?.room_code, p_depot: room?.depot_code, p_billing: v.billing || 'mensuel',
            p_price_xof: int(v.price), p_start: v.start || undefined, p_end: v.end || undefined,
            p_electricity_by_tenant: v.elec !== 'non', p_deposit_xof: int(v.deposit),
          });
          const inv = r.invoices?.[0];
          msg = `Chambre ${room?.room_name} louée à ${v.client}.` + (inv ? ` Facture ${inv.invoice_number} : ${fcfa(inv.total_xof)}.` : '');
          break;
        }
        case 'fin_location': {
          const room = rooms.find((r) => r.contract_id === v.contract);
          await rpc('end_rental', { p_contract: v.contract, p_end: v.end || undefined });
          msg = `Location de ${room?.room_name} (${room?.tenant}) terminée${v.end ? ` le ${v.end}` : ''}.`;
          break;
        }
      }
      setDone(msg); setForm(null); reloadRooms(); loadDay();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ── Options ───────────────────────────────────────────────────────────────
  const productOpts = products.map((p) => ({ value: p.sku, label: `${p.name} (${p.unit_type})` }));
  const clientOpts = clients.map((c) => ({ value: c.name, label: c.name }));
  const depotOpts = depots.map((d) => ({ value: d.code!, label: `${d.code} — ${d.name}` }));
  const lotOpts = lots.map((l) => ({
    value: `${l.sku}|${l.lot_number}|${l.depot_code}`,
    label: `${l.product_name} · lot ${l.lot_number} · ${qty(l.quantity)} ${l.unit_type} · ${l.depot_code}${l.room_name ? ` · ${l.room_name}` : ''}`,
  }));
  const roomLabel = (r: (typeof rooms)[number]) => `${r.depot_code} · ${r.room_name}${r.fill_pct != null ? ` (${r.fill_pct} %)` : ''}`;
  const receptionRooms = rooms.filter((r) => r.status !== 'louee' || (v.owner && r.tenant === v.owner)).map((r) => ({ value: r.room_id, label: roomLabel(r) }));
  const moveRooms = rooms.filter((r) => lot && r.depot_code === lot.depot_code && r.room_name !== lot.room_name)
    .map((r) => ({ value: r.room_id, label: roomLabel(r) }));
  const freeRooms = rooms.filter((r) => r.status === 'libre')
    .map((r) => ({ value: r.room_id, label: `${r.depot_code} · ${r.room_name}${r.capacity_tonnes ? ` · ${r.capacity_tonnes} t` : ''}` }));
  const rentedRooms = rooms.filter((r) => r.status === 'louee' && r.contract_id)
    .map((r) => ({ value: r.contract_id!, label: `${r.room_name} — ${r.tenant}` }));
  const total = Number(v.qty || 0) * Number(v.price || product?.default_price_xof || 0);
  const actions = ACTIONS.filter((a) => a.roles.includes(profile.role));
  const primary = actions.filter((a) => a.key === 'vente' || a.key === 'reception');
  const secondary = actions.filter((a) => a.key !== 'vente' && a.key !== 'reception');
  const title = ACTIONS.find((a) => a.key === form)?.label ?? '';

  const kpis = day ? (finance
    ? [
      { label: 'Ventes', value: fcfa(day.sales_xof), sub: `${day.sales_count} facture${day.sales_count > 1 ? 's' : ''}` },
      { label: 'Marge', value: fcfa(day.margin_xof), sub: day.sales_xof ? `${Math.round((Number(day.margin_xof) / Number(day.sales_xof)) * 100)} %` : '—' },
      { label: 'Encaissé', value: fcfa(day.payments_xof), sub: 'paiements reçus' },
      { label: 'Mouvements', value: `+${qty(day.qty_in)} / −${qty(day.qty_out)}`, sub: `${day.receptions_count} réception${day.receptions_count > 1 ? 's' : ''}` },
    ]
    : [
      { label: 'Ventes', value: String(day.sales_count), sub: 'sorties facturées' },
      { label: 'Réceptions', value: String(day.receptions_count), sub: 'lots entrés' },
      { label: 'Entrées', value: qty(day.qty_in), sub: 'unités' },
      { label: 'Sorties', value: qty(day.qty_out), sub: 'unités' },
    ]) : [];

  return (
    <Screen title="Opérations"
      subtitle={new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Dakar' })}>
      {done && <p className="rounded-2xl bg-surface-card text-text-primary text-caption px-4 py-3" onClick={() => setDone(null)}><span className="text-status-success font-semibold">Fait · </span>{done}</p>}

      <div className="flex gap-0.5 bg-surface-subtle rounded-[10px] p-0.5">
        {[0, 1].map((o) => (
          <button key={o} onClick={() => setDayOffset(o)}
            className={cx('flex-1 rounded-[8px] py-1.5 text-caption font-semibold transition',
              dayOffset === o ? 'bg-surface-card text-text-primary shadow-sm' : 'text-text-secondary')}>
            {o === 0 ? 'Aujourd’hui' : 'Hier'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 bg-surface-card rounded-2xl overflow-hidden divide-x divide-border-default">
        {[kpis.slice(0, 2), kpis.slice(2, 4)].map((col, c) => (
          <div key={c} className="divide-y divide-border-default">
            {col.map((k) => (
              <div key={k.label} className="px-4 py-3">
                <p className="text-caption text-text-secondary">{k.label}</p>
                <p className="text-body font-semibold text-text-primary tabular-nums truncate mt-0.5">{k.value}</p>
                <p className="text-micro text-text-muted">{k.sub}</p>
              </div>
            ))}
          </div>
        ))}
      </div>

      {primary.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {primary.map(({ key, label, icon: Icon }, i) => (
            <button key={key} onClick={() => openForm(key)}
              className={cx('rounded-2xl py-3.5 flex items-center justify-center gap-2 text-body font-semibold active:opacity-80 transition',
                i === 0 ? 'bg-brand text-white' : 'bg-surface-card text-brand')}>
              <Icon size={18} />{label}
            </button>
          ))}
        </div>
      )}

      {secondary.length > 0 && <>
        <p className="text-caption text-text-secondary px-4 pt-3">Autres opérations</p>
        <div className="bg-surface-card rounded-2xl overflow-hidden">
          {secondary.map(({ key, label, icon: Icon, color }, i) => (
            <button key={key} onClick={() => openForm(key)}
              className="w-full flex items-center gap-3 pl-4 active:bg-surface-subtle transition">
              <span className="w-7 h-7 rounded-lg text-white flex items-center justify-center shrink-0" style={{ background: color }}><Icon size={15} /></span>
              <span className={cx('flex-1 flex items-center justify-between py-3 pr-4 text-left', i > 0 && 'border-t border-border-default')}>
                <span className="text-body text-text-primary">{label}</span>
                <ChevronRight size={18} className="text-text-muted" />
              </span>
            </button>
          ))}
        </div>
      </>}

      <div className="flex items-center justify-between px-4 pt-3">
        <p className="text-caption text-text-secondary">Journal {dayOffset === 0 ? 'du jour' : 'd’hier'}</p>
        {dayOffset === 0 && <span className="flex items-center gap-1.5 text-micro text-text-muted"><span className="w-1.5 h-1.5 rounded-full bg-status-success" />En direct</span>}
      </div>
      {day && day.journal.length === 0
        ? <div className="bg-surface-card rounded-2xl py-8 text-center text-caption text-text-muted">Aucune opération {dayOffset === 0 ? 'pour l’instant' : 'hier'}.</div>
        : (
          <div className="bg-surface-card rounded-2xl overflow-hidden">
            {day?.journal.map((j, i) => {
              const k = KIND[j.kind] ?? KIND.ajustement;
              return (
                <div key={i} className="flex gap-3 pl-4">
                  <span className="w-7 h-7 mt-3 rounded-full flex items-center justify-center shrink-0 text-white" style={{ background: k.color }}><k.icon size={14} /></span>
                  <div className={cx('min-w-0 flex-1 py-3 pr-4', i > 0 && 'border-t border-border-default')}>
                    <div className="flex justify-between gap-3">
                      <p className="text-body text-text-primary truncate">{j.title}</p>
                      <p className="text-caption text-text-muted shrink-0 tabular-nums">{hhmm(j.at)}</p>
                    </div>
                    <div className="flex justify-between gap-3">
                      <p className="text-caption text-text-secondary truncate">{j.detail}{j.by ? ` · ${j.by}` : ''}</p>
                      {j.amount_xof != null && <p className="text-caption font-semibold text-text-primary shrink-0 tabular-nums">{fcfa(j.amount_xof)}</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      <Sheet open={form !== null} title={title} onClose={() => setForm(null)}>
        {form === 'vente' && <>
          <p className="flex gap-2 rounded-xl bg-surface-subtle px-3 py-2 text-caption text-text-secondary">
            <Sparkles size={16} className="text-brand shrink-0 mt-0.5" />
            <span>Plus rapide dans l’Assistant : « Vends 20 cartons de cuisse à Moussa à 15 000 ».</span>
          </p>
          <Field label="Produit"><Select options={productOpts} value={v.product ?? ''} onChange={set('product')} /></Field>
          <Field label="Client"><Select options={clientOpts} value={v.client ?? ''} onChange={set('client')} /></Field>
          <Field label="Quantité"><Input inputMode="decimal" value={v.qty ?? ''} onChange={set('qty')} /></Field>
          <Field label={`Prix unitaire (FCFA)${product?.default_price_xof ? ` — défaut ${fcfa(product.default_price_xof)}` : ''}`}>
            <Input inputMode="numeric" value={v.price ?? ''} onChange={set('price')} /></Field>
          {depots.length > 1 && <Field label="Entrepôt (optionnel)"><Select options={depotOpts} value={v.depot ?? ''} onChange={set('depot')} /></Field>}
          <Field label="Note"><Input value={v.note ?? ''} onChange={set('note')} /></Field>
          {total > 0 && <p className="text-body font-bold text-brand-ink">Total : {fcfa(total)}</p>}
          <p className="text-caption text-text-muted">Lots prélevés automatiquement selon FEFO. Vente bloquée si prix sous le coût ou crédit dépassé.</p>
        </>}

        {form === 'reception' && <>
          <input ref={docRef} type="file" accept="image/*,application/pdf" capture="environment" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) scanDoc(f); e.target.value = ''; }} />
          <button onClick={() => docRef.current?.click()} disabled={busy}
            className="w-full flex items-center gap-3 rounded-2xl bg-surface-subtle px-4 py-3 text-left">
            <Camera size={20} className="text-brand shrink-0" />
            <span>
              <span className="block text-body font-semibold text-text-primary">Photographier le bon de livraison</span>
              <span className="block text-caption text-text-muted">DEPOTEK remplit tout : produits, quantités, lots, dates</span>
            </span>
          </button>
          <p className="text-caption text-text-muted text-center">ou saisir à la main</p>
          <Field label="Produit"><Select options={productOpts} value={v.product ?? ''} onChange={set('product')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantité"><Input inputMode="decimal" value={v.qty ?? ''} onChange={set('qty')} /></Field>
            <Field label="N° de lot"><Input value={v.lot ?? ''} onChange={set('lot')} /></Field>
          </div>
          <Field label="Date d’expiration"><Input type="date" value={v.expiry ?? ''} onChange={set('expiry')} /></Field>
          <Field label="Marchandise d’un locataire (optionnel)"><Select options={clientOpts} value={v.owner ?? ''} onChange={set('owner')} /></Field>
          <Field label="Chambre froide"><Select options={receptionRooms} value={v.room ?? ''} onChange={set('room')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Coût unitaire"><Input inputMode="decimal" value={v.cost ?? ''} onChange={set('cost')} /></Field>
            <Field label="Devise"><Select options={[{ value: 'XOF', label: 'FCFA' }, { value: 'EUR', label: 'EUR' }, { value: 'USD', label: 'USD' }]}
              value={v.currency ?? 'XOF'} onChange={set('currency')} /></Field>
          </div>
          {v.currency === 'USD' && <Field label="Taux USD → FCFA"><Input inputMode="decimal" value={v.fx ?? ''} onChange={set('fx')} /></Field>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fournisseur"><Input value={v.supplier ?? ''} onChange={set('supplier')} /></Field>
            <Field label="N° conteneur"><Input value={v.container ?? ''} onChange={set('container')} /></Field>
          </div>
        </>}

        {form === 'encaissement' && <>
          <Field label="Client"><Select options={clientOpts} value={v.client ?? ''} onChange={set('client')} /></Field>
          <Field label="Montant (FCFA)"><Input inputMode="numeric" value={v.amount ?? ''} onChange={set('amount')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Mode"><Select options={PAY} value={v.method ?? 'especes'} onChange={set('method')} /></Field>
            <Field label="Référence"><Input value={v.ref ?? ''} onChange={set('ref')} /></Field>
          </div>
          <p className="text-caption text-text-muted">Imputé automatiquement sur les factures les plus anciennes du client.</p>
        </>}

        {form === 'transfert' && <>
          <Field label="Produit"><Select options={productOpts} value={v.product ?? ''} onChange={set('product')} /></Field>
          <Field label="Quantité"><Input inputMode="decimal" value={v.qty ?? ''} onChange={set('qty')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="De"><Select options={depotOpts} value={v.from ?? ''} onChange={set('from')} /></Field>
            <Field label="Vers"><Select options={depotOpts.filter((d) => d.value !== v.from)} value={v.to ?? ''} onChange={set('to')} /></Field>
          </div>
          {v.to && <Field label="Chambre d’arrivée"><Select options={rooms.filter((r) => r.depot_code === v.to && r.status !== 'louee')
            .map((r) => ({ value: r.room_id, label: roomLabel(r) }))} value={v.room ?? ''} onChange={set('room')} /></Field>}
          {depots.length < 2 && <p className="text-caption text-text-muted">Ajoute un deuxième entrepôt dans Réglages pour transférer.</p>}
        </>}

        {form === 'deplacer' && <>
          <Field label="Lot"><Select options={lotOpts} value={v.lot_key ?? ''} onChange={set('lot_key')} /></Field>
          <Field label="Nouvelle chambre"><Select options={moveRooms} value={v.room ?? ''} onChange={set('room')} /></Field>
        </>}

        {form === 'inventaire' && <>
          <Field label="Lot compté"><Select options={lotOpts} value={v.lot_key ?? ''} onChange={set('lot_key')} /></Field>
          {lot && <p className="text-caption text-text-muted">Quantité système : {qty(lot.quantity)} {lot.unit_type}</p>}
          <Field label="Quantité comptée"><Input inputMode="decimal" value={v.counted ?? ''} onChange={set('counted')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type"><Select options={[{ value: 'non', label: 'Comptage' }, { value: 'oui', label: 'Perte / avarie' }]}
              value={v.loss ?? 'non'} onChange={set('loss')} /></Field>
            <Field label="Motif"><Input value={v.reason ?? ''} onChange={set('reason')} /></Field>
          </div>
        </>}

        {form === 'client' && <>
          <Field label="Nom"><Input value={v.name ?? ''} onChange={set('name')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Téléphone"><Input inputMode="tel" value={v.phone ?? ''} onChange={set('phone')} /></Field>
            <Field label="Type"><Select options={[
              { value: 'grossiste', label: 'Grossiste' }, { value: 'detaillant', label: 'Détaillant' }, { value: 'restaurant', label: 'Restaurant' },
              { value: 'supermarche', label: 'Supermarché' }, { value: 'locataire_froid', label: 'Locataire chambre' }, { value: 'autre', label: 'Autre' },
            ]} value={v.type ?? 'grossiste'} onChange={set('type')} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Limite de crédit"><Input inputMode="numeric" value={v.credit ?? ''} onChange={set('credit')} /></Field>
            <Field label="Délai (jours)"><Input inputMode="numeric" value={v.terms ?? ''} onChange={set('terms')} /></Field>
          </div>
        </>}

        {form === 'location' && <>
          <Field label="Client"><Select options={clientOpts} value={v.client ?? ''} onChange={set('client')} /></Field>
          <Field label="Chambre (libres uniquement)"><Select options={freeRooms} value={v.room ?? ''} onChange={set('room')} /></Field>
          {freeRooms.length === 0 && <p className="text-caption text-text-muted">Aucune chambre libre : une chambre doit être vide pour être louée.</p>}
          <Field label="Facturation"><Select options={[{ value: 'mensuel', label: 'Loyer mensuel' }, { value: 'forfait', label: 'Forfait pour la période' }]}
            value={v.billing ?? 'mensuel'} onChange={set('billing')} /></Field>
          <Field label={(v.billing ?? 'mensuel') === 'mensuel' ? 'Loyer par mois (FCFA)' : 'Prix total du forfait (FCFA)'}>
            <Input inputMode="numeric" value={v.price ?? ''} onChange={set('price')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Début"><Input type="date" value={v.start ?? ''} onChange={set('start')} /></Field>
            <Field label={(v.billing ?? 'mensuel') === 'forfait' ? 'Fin' : 'Fin (optionnel)'}><Input type="date" value={v.end ?? ''} onChange={set('end')} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Électricité (Senelec)"><Select options={[{ value: 'oui', label: 'Payée par le locataire' }, { value: 'non', label: 'Incluse dans le prix' }]}
              value={v.elec ?? 'oui'} onChange={set('elec')} /></Field>
            <Field label="Caution (FCFA)"><Input inputMode="numeric" value={v.deposit ?? ''} onChange={set('deposit')} /></Field>
          </div>
          <p className="text-caption text-text-muted">
            {(v.billing ?? 'mensuel') === 'mensuel'
              ? 'Facturé d’avance chaque mois, au prorata le premier et le dernier mois. Première facture créée tout de suite.'
              : 'Facturé une seule fois, tout de suite.'} La chambre n’acceptera que la marchandise de ce client.
          </p>
        </>}

        {form === 'fin_location' && <>
          <Field label="Chambre louée"><Select options={rentedRooms} value={v.contract ?? ''} onChange={set('contract')} /></Field>
          {rentedRooms.length === 0 && <p className="text-caption text-text-muted">Aucune chambre louée en ce moment.</p>}
          <Field label="Date de fin (défaut : aujourd’hui)"><Input type="date" value={v.end ?? ''} onChange={set('end')} /></Field>
        </>}

        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !ready(form, v)} onClick={submit}>{busy ? '…' : 'Valider'}</Button>
      </Sheet>
    </Screen>
  );
}

function ready(form: Form | null, v: Record<string, string>): boolean {
  const num = (s?: string) => Number((s ?? '').replace(',', '.')) > 0;
  switch (form) {
    case 'vente': return !!v.product && !!v.client && num(v.qty);
    case 'reception': return !!v.product && !!v.lot && num(v.qty);
    case 'encaissement': return !!v.client && num(v.amount);
    case 'transfert': return !!v.product && num(v.qty) && !!v.from && !!v.to && v.from !== v.to;
    case 'deplacer': return !!v.lot_key && !!v.room;
    case 'inventaire': return !!v.lot_key && v.counted !== undefined && v.counted !== '' && !!v.reason;
    case 'client': return !!v.name?.trim();
    case 'location': return !!v.client && !!v.room && num(v.price) && (v.billing !== 'forfait' || !!v.end);
    case 'fin_location': return !!v.contract;
  }
  return false;
}
