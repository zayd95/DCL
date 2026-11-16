import React, { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Layers } from 'lucide-react';
import { supabase, rpc } from '../supabase';
import { Screen, Card, Sheet, Field, Input, Select, Button, ErrorNote, fcfa, qty } from '../ui';

interface Product { id: string; sku: string; name: string; unit_type: string; default_price_xof: number | null }
interface Named { id: string; name: string; code?: string }

type Form = 'vente' | 'reception' | 'palettes' | null;

export function Operations() {
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
          p_owner_client: v.owner,
        });
        setDone(`Lot ${v.lot} reçu : ${qty(v.qty)} × ${product?.name ?? v.product}.`);
      } else if (form === 'palettes') {
        const r = await rpc<{ pallets_now: number }>('storage_pallets', {
          p_client: v.client, p_pallets: Number(v.pallets) * (v.dir === 'out' ? -1 : 1), p_note: v.note,
        });
        setDone(`${v.client} : ${r.pallets_now} palette(s) en stock.`);
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
      <Card onClick={() => openForm('palettes')}>
        <div className="flex items-center gap-3"><Layers className="text-brand" />
          <div><p className="text-body font-bold">Palettes d’un locataire</p><p className="text-caption text-text-muted">Location de froid (facturée chaque mois)</p></div></div>
      </Card>
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
        {depots.length > 1 && <Field label="Dépôt"><Select options={depotOpts} value={v.depot ?? ''} onChange={set('depot')} /></Field>}
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

      <Sheet open={form === 'palettes'} title="Palettes d’un locataire" onClose={() => setForm(null)}>
        <Field label="Client"><Select options={clientOpts} value={v.client ?? ''} onChange={set('client')} /></Field>
        <Field label="Mouvement"><Select options={[{ value: 'in', label: 'Entrée' }, { value: 'out', label: 'Sortie' }]} value={v.dir ?? 'in'} onChange={set('dir')} /></Field>
        <Field label="Nombre de palettes"><Input inputMode="numeric" value={v.pallets ?? ''} onChange={set('pallets')} /></Field>
        <Field label="Note"><Input value={v.note ?? ''} onChange={set('note')} /></Field>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.client || !Number(v.pallets)} onClick={submit}>{busy ? '…' : 'Enregistrer'}</Button>
      </Sheet>
    </Screen>
  );
}
