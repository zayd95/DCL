import React, { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, KeyRound } from 'lucide-react';
import { supabase, rpc, type Profile, canSeeFinance } from '../supabase';
import { useRooms } from './Rooms';
import { Screen, Card, Sheet, Field, Input, Select, Button, ErrorNote, fcfa, qty } from '../ui';

interface Product { id: string; sku: string; name: string; unit_type: string; default_price_xof: number | null }
interface Named { id: string; name: string; code?: string }

type Form = 'vente' | 'reception' | 'location' | null;

export function Operations({ profile }: { profile: Profile }) {
  const { rooms, reload: reloadRooms } = useRooms();
  const [form, setForm] = useState<Form>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [clients, setClients] = useState<Named[]>([]);
  const [depots, setDepots] = useState<Named[]>([]);
  const [v, setV] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [p, c, d] = await Promise.all([
        supabase.from('products').select('id,sku,name,unit_type,default_price_xof').eq('active', true).order('name'),
        supabase.from('clients').select('id,name').eq('active', true).order('name'),
        supabase.from('depots').select('id,name,code').eq('active', true).order('code'),
      ]);
      setProducts((p.data ?? []) as Product[]);
      setClients((c.data ?? []) as Named[]);
      setDepots((d.data ?? []) as Named[]);
    })();
  }, [form]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const openForm = (f: Form) => { setForm(f); setV({}); setError(null); };
  const product = products.find((p) => p.sku === v.product);
  const depotCode = v.depot || (depots.length === 1 ? depots[0].code : '');

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (form === 'vente') {
        const r = await rpc<{ invoice_number: string; total_xof: number; picks: { lot_number: string; qty: number }[] }>('dispatch_fefo', {
          p_product: v.product, p_qty: Number(v.qty), p_client: v.client, p_depot: depotCode,
          p_unit_price_xof: v.price ? Math.round(Number(v.price)) : undefined, p_notes: v.note,
        });
        setDone(`Facture ${r.invoice_number} : ${fcfa(r.total_xof)}. Lots : ${r.picks.map((p) => `${p.lot_number} (${qty(p.qty)})`).join(', ')}`);
      } else if (form === 'reception') {
        await rpc('receive_lot', {
          p_product: v.product, p_qty: Number(v.qty), p_lot_number: v.lot, p_depot: depotCode,
          p_expiry_date: v.expiry, p_cost_unit: v.cost ? Number(v.cost) : undefined, p_cost_currency: v.currency || 'XOF',
          p_fx_rate_to_xof: v.fx ? Number(v.fx) : undefined, p_supplier: v.supplier, p_container_no: v.container,
          p_owner_client: v.owner, p_storage_unit: rooms.find((r) => r.room_id === v.room)?.room_code,
        });
        setDone(`Lot ${v.lot} reçu : ${qty(v.qty)} × ${product?.name ?? v.product}.`);
        reloadRooms();
      } else if (form === 'location') {
        const room = rooms.find((r) => r.room_id === v.room);
        const r = await rpc<{ invoices: { invoice_number: string; total_xof: number }[] }>('rent_room', {
          p_client: v.client, p_room: room?.room_code, p_depot: room?.depot_code, p_billing: v.billing || 'mensuel',
          p_price_xof: Math.round(Number(v.price)), p_start: v.start || undefined, p_end: v.end || undefined,
          p_electricity_by_tenant: v.elec !== 'non', p_deposit_xof: v.deposit ? Math.round(Number(v.deposit)) : undefined,
        });
        const inv = r.invoices?.[0];
        setDone(`Chambre ${room?.room_name} louée à ${v.client}.` + (inv ? ` Facture ${inv.invoice_number} : ${fcfa(inv.total_xof)}.` : ''));
        reloadRooms();
      }
      setForm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const productOpts = products.map((p) => ({ value: p.sku, label: `${p.name} (${p.unit_type})` }));
  const clientOpts = clients.map((c) => ({ value: c.name, label: c.name }));
  const depotOpts = depots.map((d) => ({ value: d.code!, label: `${d.code} — ${d.name}` }));
  const total = Number(v.qty || 0) * Number(v.price || product?.default_price_xof || 0);
  // Réception : chambres non louées, ou louées au propriétaire de la marchandise
  const receptionRooms = rooms
    .filter((r) => r.status !== 'louee' || (v.owner && r.tenant === v.owner))
    .map((r) => ({ value: r.room_id, label: `${r.depot_code} · ${r.room_name}${r.fill_pct != null ? ` (${r.fill_pct} %)` : ''}` }));
  const freeRooms = rooms.filter((r) => r.status === 'libre')
    .map((r) => ({ value: r.room_id, label: `${r.depot_code} · ${r.room_name}${r.capacity_tonnes ? ` · ${r.capacity_tonnes} t` : ''}` }));

  return (
    <Screen title="Opérations" subtitle="Ventes, réceptions, stockage">
      {done && <p className="rounded-xl bg-status-success-bg text-status-success text-body p-3" onClick={() => setDone(null)}>✅ {done}</p>}
      <Card onClick={() => openForm('vente')}>
        <div className="flex items-center gap-3"><ArrowUpFromLine className="text-brand" />
          <div><p className="text-body font-bold">Vente / sortie</p><p className="text-caption text-text-muted">FEFO automatique + facture</p></div></div>
      </Card>
      <Card onClick={() => openForm('reception')}>
        <div className="flex items-center gap-3"><ArrowDownToLine className="text-brand" />
          <div><p className="text-body font-bold">Réception d’un lot</p><p className="text-caption text-text-muted">Entrée de stock avec date d’expiration</p></div></div>
      </Card>
      {canSeeFinance(profile.role) && (
        <Card onClick={() => openForm('location')}>
          <div className="flex items-center gap-3"><KeyRound className="text-brand" />
            <div><p className="text-body font-bold">Louer une chambre froide</p><p className="text-caption text-text-muted">Chambre entière, au mois ou au forfait</p></div></div>
        </Card>
      )}
      <p className="text-caption text-text-muted px-1 pt-2">Astuce : tout cela se fait aussi en une phrase dans l’Assistant.</p>

      <Sheet open={form === 'vente'} title="Vente / sortie" onClose={() => setForm(null)}>
        <Field label="Produit"><Select options={productOpts} value={v.product ?? ''} onChange={set('product')} /></Field>
        <Field label="Client"><Select options={clientOpts} value={v.client ?? ''} onChange={set('client')} /></Field>
        <Field label="Quantité"><Input inputMode="decimal" value={v.qty ?? ''} onChange={set('qty')} /></Field>
        <Field label={`Prix unitaire (FCFA)${product?.default_price_xof ? ` — défaut ${fcfa(product.default_price_xof)}` : ''}`}>
          <Input inputMode="numeric" value={v.price ?? ''} onChange={set('price')} /></Field>
        {depots.length > 1 && <Field label="Dépôt (optionnel)"><Select options={depotOpts} value={v.depot ?? ''} onChange={set('depot')} /></Field>}
        <Field label="Note"><Input value={v.note ?? ''} onChange={set('note')} /></Field>
        {total > 0 && <p className="text-body font-bold text-brand-ink">Total : {fcfa(total)}</p>}
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.product || !v.client || !Number(v.qty)} onClick={submit}>{busy ? '…' : 'Valider la vente'}</Button>
      </Sheet>

      <Sheet open={form === 'reception'} title="Réception d’un lot" onClose={() => setForm(null)}>
        <Field label="Produit"><Select options={productOpts} value={v.product ?? ''} onChange={set('product')} /></Field>
        <Field label="Quantité"><Input inputMode="decimal" value={v.qty ?? ''} onChange={set('qty')} /></Field>
        <Field label="N° de lot"><Input value={v.lot ?? ''} onChange={set('lot')} /></Field>
        <Field label="Date d’expiration"><Input type="date" value={v.expiry ?? ''} onChange={set('expiry')} /></Field>
        <Field label="Chambre froide"><Select options={receptionRooms} value={v.room ?? ''} onChange={set('room')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Coût unitaire"><Input inputMode="decimal" value={v.cost ?? ''} onChange={set('cost')} /></Field>
          <Field label="Devise"><Select options={[{ value: 'XOF', label: 'FCFA' }, { value: 'EUR', label: 'EUR' }, { value: 'USD', label: 'USD' }]}
            value={v.currency ?? 'XOF'} onChange={set('currency')} /></Field>
        </div>
        {v.currency === 'USD' && <Field label="Taux USD → FCFA"><Input inputMode="decimal" value={v.fx ?? ''} onChange={set('fx')} /></Field>}
        <Field label="Fournisseur"><Input value={v.supplier ?? ''} onChange={set('supplier')} /></Field>
        <Field label="N° conteneur"><Input value={v.container ?? ''} onChange={set('container')} /></Field>
        <Field label="Marchandise d’un client (stockage tiers)"><Select options={clientOpts} value={v.owner ?? ''} onChange={set('owner')} /></Field>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.product || !v.lot || !Number(v.qty)} onClick={submit}>{busy ? '…' : 'Enregistrer la réception'}</Button>
      </Sheet>

      <Sheet open={form === 'location'} title="Louer une chambre froide" onClose={() => setForm(null)}>
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
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.client || !v.room || !Number(v.price) || ((v.billing === 'forfait') && !v.end)} onClick={submit}>
          {busy ? '…' : 'Louer la chambre'}</Button>
      </Sheet>
    </Screen>
  );
}
