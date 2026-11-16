import React, { useEffect, useState } from 'react';
import { supabase, rpc, type Profile, canManage, canSeeFinance } from '../supabase';
import { Screen, Card, Sheet, Field, Input, Select, Button, ErrorNote, Badge, fcfa } from '../ui';

type Form = 'product' | 'client' | 'depot' | 'contract' | 'users' | null;

const ROLE_LABEL: Record<string, string> = { magasinier: 'Magasinier', manager: 'Manager', cfo: 'Finance', admin: 'Admin' };

export function Settings({ profile, onSignOut }: { profile: Profile; onSignOut: () => void }) {
  const [form, setForm] = useState<Form>(null);
  const [v, setV] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [counts, setCounts] = useState({ products: 0, clients: 0, depots: 0 });
  const [users, setUsers] = useState<Profile[]>([]);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [depots, setDepots] = useState<{ id: string; code: string; name: string }[]>([]);

  const refresh = async () => {
    const [p, c, d] = await Promise.all([
      supabase.from('products').select('id', { count: 'exact', head: true }),
      supabase.from('clients').select('id,name').order('name'),
      supabase.from('depots').select('id,code,name').order('code'),
    ]);
    setCounts({ products: p.count ?? 0, clients: c.data?.length ?? 0, depots: d.data?.length ?? 0 });
    setClients(c.data ?? []);
    setDepots(d.data ?? []);
    if (profile.role === 'admin') {
      const { data } = await supabase.from('profiles').select('*').order('created_at');
      setUsers((data ?? []) as Profile[]);
    }
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const open = (f: Form) => { setForm(f); setV({}); setError(null); };
  const num = (s?: string) => (s ? Number(s) : null);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      if (form === 'product') {
        const { error } = await supabase.from('products').insert({
          sku: v.sku.trim().toUpperCase(), name: v.name.trim(), category: v.category || 'viande',
          unit_type: v.unit || 'carton', unit_weight_kg: num(v.weight), default_price_xof: num(v.price),
          min_stock: num(v.min) ?? 0, lead_time_days: num(v.lead) ?? 45,
        });
        if (error) throw error;
        setDone(`Produit ${v.name} ajouté.`);
      } else if (form === 'client') {
        await rpc('create_client', {
          p_name: v.name, p_phone: v.phone, p_type: v.type || 'grossiste',
          p_credit_limit_xof: num(v.limit) ?? 0, p_payment_terms_days: num(v.terms) ?? 0,
        });
        setDone(`Client ${v.name} ajouté.`);
      } else if (form === 'depot') {
        const { error } = await supabase.from('depots').insert({
          code: v.code.trim().toUpperCase(), name: v.name.trim(), type: v.type || 'frozen', capacity_pallets: num(v.capacity),
        });
        if (error) throw error;
        setDone(`Dépôt ${v.code} ajouté.`);
      } else if (form === 'contract') {
        const { error } = await supabase.from('storage_contracts').insert({
          client_id: v.client, depot_id: v.depot || depots[0]?.id, rate_pallet_day_xof: num(v.rate) ?? 0,
          min_monthly_xof: num(v.min) ?? 0, start_date: v.start || undefined,
        });
        if (error) throw error;
        setDone('Contrat de stockage créé.');
      }
      setForm(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setRole = async (id: string, role: string) => {
    const { error } = await supabase.from('profiles').update({ role }).eq('id', id);
    if (error) setError(error.message); else refresh();
  };

  const manage = canManage(profile.role);
  const finance = canSeeFinance(profile.role);

  return (
    <Screen title="Réglages" subtitle={`${profile.full_name || 'Utilisateur'} · ${ROLE_LABEL[profile.role]}`}>
      {done && <p className="rounded-xl bg-status-success-bg text-status-success text-body p-3" onClick={() => setDone(null)}>✅ {done}</p>}
      {counts.depots === 0 && manage && (
        <p className="rounded-xl bg-status-info-bg text-status-info text-body p-3">
          Pour démarrer : 1) créez le dépôt, 2) ajoutez vos produits, 3) ajoutez vos clients.
        </p>
      )}
      {manage && <Card onClick={() => open('depot')}><p className="text-body font-bold">Dépôts</p><p className="text-caption text-text-muted">{counts.depots} · ajouter</p></Card>}
      {manage && <Card onClick={() => open('product')}><p className="text-body font-bold">Produits</p><p className="text-caption text-text-muted">{counts.products} · ajouter</p></Card>}
      {finance && <Card onClick={() => open('client')}><p className="text-body font-bold">Clients</p><p className="text-caption text-text-muted">{counts.clients} · ajouter</p></Card>}
      {finance && <Card onClick={() => open('contract')}><p className="text-body font-bold">Contrat de stockage froid</p><p className="text-caption text-text-muted">Tarif palette / jour pour un locataire</p></Card>}
      {profile.role === 'admin' && <Card onClick={() => open('users')}><p className="text-body font-bold">Utilisateurs et rôles</p><p className="text-caption text-text-muted">{users.length} compte(s)</p></Card>}
      <Button variant="ghost" className="w-full" onClick={onSignOut}>Se déconnecter</Button>
      <ErrorNote error={form ? null : error} />

      <Sheet open={form === 'depot'} title="Nouveau dépôt" onClose={() => setForm(null)}>
        <Field label="Code (ex. ALM)"><Input value={v.code ?? ''} onChange={set('code')} /></Field>
        <Field label="Nom"><Input value={v.name ?? ''} onChange={set('name')} placeholder="Hub froid Almadies" /></Field>
        <Field label="Type"><Select options={[{ value: 'frozen', label: 'Congelé' }, { value: 'chilled', label: 'Frais' }, { value: 'dry', label: 'Sec' }, { value: 'mixed', label: 'Mixte' }]}
          value={v.type ?? 'frozen'} onChange={set('type')} /></Field>
        <Field label="Capacité (palettes)"><Input inputMode="numeric" value={v.capacity ?? ''} onChange={set('capacity')} /></Field>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.code || !v.name} onClick={save}>Ajouter</Button>
      </Sheet>

      <Sheet open={form === 'product'} title="Nouveau produit" onClose={() => setForm(null)}>
        <Field label="SKU (ex. BOE-FOI-20)"><Input value={v.sku ?? ''} onChange={set('sku')} /></Field>
        <Field label="Nom"><Input value={v.name ?? ''} onChange={set('name')} placeholder="Foie de bœuf 20 kg" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Catégorie"><Select options={['viande', 'abats', 'volaille', 'poisson', 'fromage', 'autre'].map((x) => ({ value: x, label: x }))}
            value={v.category ?? 'viande'} onChange={set('category')} /></Field>
          <Field label="Unité"><Select options={['carton', 'kg', 'sac', 'palette', 'piece', 'tonne', 'litre'].map((x) => ({ value: x, label: x }))}
            value={v.unit ?? 'carton'} onChange={set('unit')} /></Field>
          <Field label="Poids / unité (kg)"><Input inputMode="decimal" value={v.weight ?? ''} onChange={set('weight')} /></Field>
          <Field label="Prix de vente (FCFA)"><Input inputMode="numeric" value={v.price ?? ''} onChange={set('price')} /></Field>
          <Field label="Stock minimum"><Input inputMode="decimal" value={v.min ?? ''} onChange={set('min')} /></Field>
          <Field label="Délai réappro (j)"><Input inputMode="numeric" value={v.lead ?? ''} onChange={set('lead')} placeholder="45" /></Field>
        </div>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.sku || !v.name} onClick={save}>Ajouter</Button>
      </Sheet>

      <Sheet open={form === 'client'} title="Nouveau client" onClose={() => setForm(null)}>
        <Field label="Nom"><Input value={v.name ?? ''} onChange={set('name')} /></Field>
        <Field label="Téléphone"><Input inputMode="tel" value={v.phone ?? ''} onChange={set('phone')} placeholder="77 000 00 00" /></Field>
        <Field label="Type"><Select options={[['grossiste', 'Grossiste'], ['detaillant', 'Détaillant'], ['restaurant', 'Restaurant'], ['supermarche', 'Supermarché'], ['locataire_froid', 'Locataire de froid'], ['autre', 'Autre']].map(([value, label]) => ({ value, label }))}
          value={v.type ?? 'grossiste'} onChange={set('type')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Limite de crédit"><Input inputMode="numeric" value={v.limit ?? ''} onChange={set('limit')} placeholder="0 = aucune" /></Field>
          <Field label="Paiement à (jours)"><Input inputMode="numeric" value={v.terms ?? ''} onChange={set('terms')} placeholder="0" /></Field>
        </div>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.name} onClick={save}>Ajouter</Button>
      </Sheet>

      <Sheet open={form === 'contract'} title="Contrat de stockage" onClose={() => setForm(null)}>
        <Field label="Client"><Select options={clients.map((c) => ({ value: c.id, label: c.name }))} value={v.client ?? ''} onChange={set('client')} /></Field>
        {depots.length > 1 && <Field label="Dépôt"><Select options={depots.map((d) => ({ value: d.id, label: d.code }))} value={v.depot ?? ''} onChange={set('depot')} /></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tarif / palette / jour"><Input inputMode="numeric" value={v.rate ?? ''} onChange={set('rate')} /></Field>
          <Field label="Minimum mensuel"><Input inputMode="numeric" value={v.min ?? ''} onChange={set('min')} placeholder="0" /></Field>
        </div>
        <Field label="Début"><Input type="date" value={v.start ?? ''} onChange={set('start')} /></Field>
        {Number(v.rate) > 0 && <p className="text-caption text-text-secondary">Ex. 10 palettes pendant 30 jours = {fcfa(Number(v.rate) * 300)}</p>}
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.client || !Number(v.rate)} onClick={save}>Créer le contrat</Button>
      </Sheet>

      <Sheet open={form === 'users'} title="Utilisateurs" onClose={() => setForm(null)}>
        <p className="text-caption text-text-secondary">Chaque personne crée son compte depuis l’écran de connexion, puis vous lui attribuez son rôle ici.</p>
        {users.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-3 border-b border-border-default pb-2">
            <div className="min-w-0">
              <p className="text-body font-bold truncate">{u.full_name || '—'}</p>
              {u.id === profile.id && <Badge tone="info">Vous</Badge>}
            </div>
            <select disabled={u.id === profile.id} value={u.role} onChange={(e) => setRole(u.id, e.target.value)}
              className="rounded-xl border border-border-strong px-2 py-2 text-body">
              {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        ))}
        <ErrorNote error={error} />
      </Sheet>
    </Screen>
  );
}
