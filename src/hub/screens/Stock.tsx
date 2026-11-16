import React, { useCallback, useEffect, useState } from 'react';
import { supabase, type Profile, canSeeFinance } from '../supabase';
import { Screen, Card, Badge, Empty, ErrorNote, Sheet, fcfa, qty, shortDate, fefoTone } from '../ui';

interface ProductRow {
  product_id: string; sku: string; product_name: string; unit_type: string;
  quantity: number; value_xof: number; earliest_expiry: string | null; lots: number;
  days_of_cover: number | null; lead_time_days: number; needs_reorder: boolean;
}
interface LotRow {
  lot_number: string; depot_code: string; quantity: number; unit_type: string; expiry_date: string | null;
  days_to_expiry: number | null; fefo_status: string; value_xof: number; container_no: string | null;
  supplier: string | null; owner_client: string | null; product_name: string;
}

export function Stock({ profile }: { profile: Profile }) {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [tenantLots, setTenantLots] = useState<LotRow[]>([]);
  const [selected, setSelected] = useState<ProductRow | null>(null);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const finance = canSeeFinance(profile.role);

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

  const total = products.reduce((s, p) => s + Number(p.value_xof || 0), 0);
  const reorder = products.filter((p) => p.needs_reorder).length;

  return (
    <Screen title="Stock" subtitle={finance ? `Valeur : ${fcfa(total)}` : `${products.length} produits`}
      right={reorder > 0 ? <Badge tone="warn">{reorder} à commander</Badge> : undefined}>
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
              <p className="text-caption text-text-muted">Lot {l.lot_number} · {qty(l.quantity)} {l.unit_type} · {l.depot_code}</p>
            </Card>
          ))}
        </>
      )}

      <Sheet open={!!selected} title={selected?.product_name ?? ''} onClose={() => setSelected(null)}>
        <p className="text-caption text-text-secondary">Ordre de sortie FEFO : le premier lot sort en premier.</p>
        {lots.length === 0 && <Empty>Aucun lot en stock.</Empty>}
        {lots.map((l, i) => (
          <div key={l.lot_number + l.depot_code} className="border border-border-default rounded-2xl p-3">
            <div className="flex justify-between items-center">
              <p className="text-body font-bold">{i + 1}. Lot {l.lot_number}</p>
              <Badge tone={fefoTone(l.fefo_status)}>{l.fefo_status}</Badge>
            </div>
            <p className="text-caption text-text-secondary mt-1">
              {qty(l.quantity)} {l.unit_type} · {l.depot_code} · exp. {shortDate(l.expiry_date)}
              {l.days_to_expiry != null && ` (${l.days_to_expiry} j)`}
            </p>
            <p className="text-caption text-text-muted">
              {[l.supplier, l.container_no].filter(Boolean).join(' · ')}{finance && ` · ${fcfa(l.value_xof)}`}
            </p>
          </div>
        ))}
      </Sheet>
    </Screen>
  );
}
