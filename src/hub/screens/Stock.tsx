import React, { useCallback, useEffect, useState } from 'react';
import { supabase, rpc, type Profile, canSeeFinance } from '../supabase';
import { Screen, Card, Badge, Empty, ErrorNote, Sheet, Field, Input, Select, Button, fcfa, qty, shortDate, fefoTone } from '../ui';
import { RoomsView } from './Rooms';
import { cx } from '../cx';

interface ProductRow {
  product_id: string; sku: string; product_name: string; unit_type: string;
  quantity: number; value_xof: number; earliest_expiry: string | null; lots: number;
  days_of_cover: number | null; lead_time_days: number; needs_reorder: boolean;
}
interface LotRow {
  lot_number: string; depot_code: string; quantity: number; unit_type: string; expiry_date: string | null;
  days_to_expiry: number | null; fefo_status: string; value_xof: number; container_no: string | null;
  supplier: string | null; owner_client: string | null; product_name: string; room_name?: string | null;
  sku?: string; cost_unit_xof?: number | null; weight_kg?: number | null;
}

const FEFO_LABEL: Record<string, string> = {
  EXPIRE: 'Expiré', CRITIQUE: 'À écouler', ATTENTION: 'À surveiller', OK: 'OK', INCONNU: 'DLC à saisir',
};

export function Stock({ profile }: { profile: Profile }) {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [tenantLots, setTenantLots] = useState<LotRow[]>([]);
  const [selected, setSelected] = useState<ProductRow | null>(null);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const finance = canSeeFinance(profile.role);
  const [edit, setEdit] = useState<LotRow | null>(null);
  const [ev, setEv] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'produits' | 'chambres'>('produits');

  const load = useCallback(async () => {
    setLoading(true);
    const [p, t] = await Promise.all([
      supabase.from('v_stock_products').select('*').order('value_xof', { ascending: false }),
      supabase.from('v_stock_lots').select('*').not('owner_client_id', 'is', null).order('expiry_date'),
    ]);
    setError(p.error?.message ?? t.error?.message ?? null);
    setProducts((p.data ?? []) as ProductRow[]);
    setTenantLots((t.data ?? []) as LotRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // Mise à jour en direct à chaque mouvement de stock
    const ch = supabase.channel('stock').on('postgres_changes',
      { event: '*', schema: 'public', table: 'stock_balances' }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const open = async (p: ProductRow) => {
    setSelected(p);
    const { data } = await supabase.from('v_stock_lots').select('*')
      .eq('product_id', p.product_id).is('owner_client_id', null).order('expiry_date', { nullsFirst: false });
    setLots((data ?? []) as LotRow[]);
  };

  const saveLot = async () => {
    if (!edit) return;
    setBusy(true); setError(null);
    try {
      await rpc('update_lot_info', {
        p_product: edit.sku, p_lot_number: edit.lot_number, p_expiry_date: ev.expiry || undefined,
        p_cost_unit: ev.cost ? Number(ev.cost.replace(',', '.')) : undefined,
        p_cost_currency: ev.cost ? (ev.currency || 'XOF') : undefined,
        p_fx_rate_to_xof: ev.fx ? Number(ev.fx.replace(',', '.')) : undefined,
      });
      setEdit(null);
      if (selected) await open(selected);
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const total = products.reduce((s, p) => s + Number(p.value_xof || 0), 0);
  const reorder = products.filter((p) => p.needs_reorder).length;

  return (
    <Screen title="Stock" subtitle={finance ? `Valeur : ${fcfa(total)}` : `${products.length} produits`}
      right={reorder > 0 ? <Badge tone="warn">{reorder} à commander</Badge> : undefined}>
      <div className="flex gap-1 bg-surface-subtle rounded-2xl p-1">
        {(['produits', 'chambres'] as const).map((k) => (
          <button key={k} onClick={() => setView(k)}
            className={cx('flex-1 rounded-xl py-2 text-body font-bold', view === k ? 'bg-surface-card text-brand shadow-sm' : 'text-text-secondary')}>
            {k === 'produits' ? 'Produits' : 'Chambres froides'}
          </button>
        ))}
      </div>
      {view === 'chambres' ? <RoomsView finance={finance} /> : <>
      <ErrorNote error={error} />
      {!loading && products.length === 0 && <Empty>Aucun produit. Ajoutez-en dans Réglages.</Empty>}
      {products.map((p) => (
        <Card key={p.product_id} onClick={() => open(p)}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-body font-bold text-text-primary truncate">{p.product_name}</p>
              <p className="text-caption text-text-muted">{p.sku} · {p.lots} lot(s)</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-title font-black text-brand-ink">{qty(p.quantity)}</p>
              <p className="text-caption text-text-muted">{p.unit_type}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {p.earliest_expiry && <Badge tone="muted">Exp. {shortDate(p.earliest_expiry)}</Badge>}
            {p.days_of_cover != null && <Badge tone={p.days_of_cover <= p.lead_time_days ? 'warn' : 'ok'}>{p.days_of_cover} j de stock</Badge>}
            {p.needs_reorder && <Badge tone="warn">Réappro</Badge>}
            {finance && <Badge tone="info">{fcfa(p.value_xof)}</Badge>}
          </div>
        </Card>
      ))}

      {tenantLots.length > 0 && (
        <>
          <h2 className="text-label font-black uppercase tracking-widest text-text-secondary pt-4">Stock des clients (stockage)</h2>
          {tenantLots.map((l) => (
            <Card key={l.lot_number + l.depot_code}>
              <p className="text-body font-bold">{l.owner_client} — {l.product_name}</p>
              <p className="text-caption text-text-muted">Lot {l.lot_number} · {qty(l.quantity)} {l.unit_type} · {l.depot_code}{l.room_name ? ` · ${l.room_name}` : ''}</p>
            </Card>
          ))}
        </>
      )}
      </>}

      <Sheet open={!!selected} title={selected?.product_name ?? ''} onClose={() => setSelected(null)}>
        <p className="text-caption text-text-secondary">Ordre de sortie FEFO : le premier lot sort en premier.</p>
        {lots.length === 0 && <Empty>Aucun lot en stock.</Empty>}
        {lots.map((l, i) => {
          const noCost = l.cost_unit_xof == null;
          const noRoom = !l.room_name;
          const noDlc = !l.expiry_date;
          return (
            <div key={l.lot_number + l.depot_code} className="border border-border-default rounded-2xl p-3 space-y-1">
              <div className="flex justify-between items-center gap-2">
                <p className="text-body font-bold">{i + 1}. Lot {l.lot_number}</p>
                <Badge tone={l.fefo_status === 'INCONNU' ? 'warn' : fefoTone(l.fefo_status)}>{FEFO_LABEL[l.fefo_status] ?? l.fefo_status}</Badge>
              </div>
              <p className="text-caption text-text-secondary">
                {qty(l.quantity)} {l.unit_type}{l.unit_type === "carton" && Number(l.quantity) > 1 ? "s" : ""}{l.weight_kg ? ` · ${qty(Number(l.weight_kg) / 1000)} t` : ''} · {l.depot_code} · {noRoom ? <span className="text-status-warning font-semibold">sans chambre</span> : l.room_name}
              </p>
              <p className="text-caption text-text-secondary">
                {noDlc ? <span className="text-status-warning font-semibold">DLC non renseignée</span>
                  : <>Exp. {shortDate(l.expiry_date)}{l.days_to_expiry != null && ` (${l.days_to_expiry} j)`}</>}
              </p>
              <p className="text-caption text-text-muted">
                {[l.supplier, l.container_no && `Conteneur ${l.container_no}`].filter(Boolean).join(' · ')}
              </p>
              {finance && (
                <p className="text-caption text-text-secondary">
                  {noCost ? <span className="text-status-warning font-semibold">Coût à saisir — valeur non comptée</span>
                    : <>Coût {fcfa(l.cost_unit_xof)} / {l.unit_type} · valeur {fcfa(l.value_xof)}</>}
                </p>
              )}
              {finance && (noCost || noDlc) && (
                <button onClick={() => { setEdit(l); setEv({}); }} className="text-caption font-semibold text-brand pt-1">Compléter le lot ›</button>
              )}
            </div>
          );
        })}
      </Sheet>

      <Sheet open={!!edit} title={`Lot ${edit?.lot_number ?? ''}`} onClose={() => setEdit(null)}>
        {edit && !edit.expiry_date && (
          <Field label="Date limite (DLC)"><Input type="date" value={ev.expiry ?? ''} onChange={(e) => setEv({ ...ev, expiry: e.target.value })} /></Field>
        )}
        {edit && edit.cost_unit_xof == null && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Coût par ${edit.unit_type}`}><Input inputMode="decimal" value={ev.cost ?? ''} onChange={(e) => setEv({ ...ev, cost: e.target.value })} /></Field>
            <Field label="Devise"><Select options={[{ value: 'XOF', label: 'FCFA' }, { value: 'EUR', label: 'EUR' }, { value: 'USD', label: 'USD' }]}
              value={ev.currency ?? 'XOF'} onChange={(e) => setEv({ ...ev, currency: e.target.value })} /></Field>
          </div>
        )}
        {ev.currency === 'USD' && <Field label="Taux USD → FCFA"><Input inputMode="decimal" value={ev.fx ?? ''} onChange={(e) => setEv({ ...ev, fx: e.target.value })} /></Field>}
        <p className="text-caption text-text-muted">L’euro est converti au taux fixe 655,957. Le grand livre n’est pas modifié : seule la fiche du lot est complétée.</p>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || (!ev.expiry && !ev.cost)} onClick={saveLot}>{busy ? '…' : 'Enregistrer'}</Button>
      </Sheet>
    </Screen>
  );
}
