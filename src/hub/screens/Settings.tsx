import React, { useEffect, useState } from 'react';
import { Bell, Warehouse, Snowflake, Package, Users, UserCog, Play, ChevronRight, Plus, Building2, ShieldCheck, type LucideIcon } from 'lucide-react';
import { supabase, rpc, type Profile, type Role, canManage, canSeeFinance } from '../supabase';
import { Screen, Sheet, Field, Input, Select, Button, ErrorNote, Badge, Avatar, fcfa, shortDate } from '../ui';
import type { SettingsPanel } from '../nav';
import { cx } from '../cx';
import { NotificationSettings } from './Notifications';
import { RoomForm, RoomSheet, useRooms, type Room } from './Rooms';

type Panel = SettingsPanel | 'company' | null;
type Edit = { kind: 'depot' | 'product' | 'client' | 'room'; id?: string } | null;

interface Depot { id: string; code: string; name: string; type: string; address: string | null; active: boolean }
interface Product {
  id: string; sku: string; name: string; category: string; unit_type: string; unit_weight_kg: number | null;
  default_price_xof: number | null; min_stock: number; lead_time_days: number; active: boolean;
}
interface Client {
  id: string; name: string; phone: string | null; type: string; credit_limit_xof: number; payment_terms_days: number; active: boolean;
}

const ROLE_LABEL: Record<string, string> = { magasinier: 'Magasinier', manager: 'Manager', cfo: 'Finance', admin: 'Admin' };
const ROLE_HELP: Record<string, string> = {
  magasinier: 'Réceptions, ventes, transferts, rangement. Pas de montants.',
  manager: 'Tout le stock, ventes, inventaires, dérogations, prix.',
  cfo: 'Factures, créances, encaissements, clients.',
  admin: 'Tout, plus l’équipe et les réglages.',
};
interface Member {
  id: string; full_name: string; role: Role; active: boolean; avatar_url: string | null; depot: string | null;
  email: string | null; last_sign_in_at: string | null; last_seen_at: string | null; created_at: string; provider: string | null;
}
const COMPANY_FIELDS: [string, string, string][] = [
  ['company_name', 'Raison sociale', 'OURY DIALLO SARL'], ['company_address', 'Adresse', 'Almadies, Dakar'],
  ['company_phone', 'Téléphone', '33 000 00 00'], ['company_ninea', 'NINEA', ''], ['company_rccm', 'RCCM', ''],
  ['invoice_footer', 'Pied de facture', 'Merci pour votre confiance.'],
];
const ago = (d?: string | null) => {
  if (!d) return 'jamais';
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  return m < 2 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `le ${shortDate(d)}`;
};
const CLIENT_TYPES = [['grossiste', 'Grossiste'], ['detaillant', 'Détaillant'], ['restaurant', 'Restaurant'], ['supermarche', 'Supermarché'],
  ['locataire_froid', 'Locataire de chambre'], ['autre', 'Autre']].map(([value, label]) => ({ value, label }));
const DEPOT_TYPES = [{ value: 'frozen', label: 'Congelé' }, { value: 'chilled', label: 'Frais' }, { value: 'dry', label: 'Sec' }, { value: 'mixed', label: 'Mixte' }];

/** Ligne de liste façon iOS : icône, titre, détail, chevron. */
function Row({ icon: Icon, color, title, sub, right, onClick, first, muted }: {
  icon?: LucideIcon; color?: string; title: string; sub?: string; right?: React.ReactNode; onClick?: () => void; first?: boolean; muted?: boolean;
}) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 pl-4 text-left active:bg-surface-subtle">
      {Icon && <span className="w-7 h-7 rounded-lg text-white flex items-center justify-center shrink-0" style={{ background: color }}><Icon size={15} /></span>}
      <span className={cx('flex-1 flex items-center justify-between gap-2 py-3 pr-4 min-w-0', !first && 'border-t border-border-default')}>
        <span className="min-w-0">
          <span className={cx('block text-body truncate', muted ? 'text-text-muted' : 'text-text-primary')}>{title}</span>
          {sub && <span className="block text-caption text-text-muted truncate">{sub}</span>}
        </span>
        <span className="flex items-center gap-1 shrink-0">{right}<ChevronRight size={18} className="text-text-muted" /></span>
      </span>
    </button>
  );
}
const Group = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-surface-card border border-border-default rounded-2xl overflow-hidden">{children}</div>
);
function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center justify-center gap-2 rounded-2xl bg-brand text-white py-3 text-body font-semibold">
      <Plus size={18} /> {label}
    </button>
  );
}

export function Settings({ profile, onSignOut, onProfileChange, onStartDemo, initialPanel }: {
  profile: Profile; onSignOut: () => void; onProfileChange: () => void; onStartDemo?: () => void;
  initialPanel?: { p?: SettingsPanel; n: number };
}) {
  const manage = canManage(profile.role);
  const finance = canSeeFinance(profile.role);
  const admin = profile.role === 'admin';
  const [panel, setPanel] = useState<Panel>(null);
  const [edit, setEdit] = useState<Edit>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [v, setV] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { rooms, reload: reloadRooms } = useRooms();
  const [depots, setDepots] = useState<Depot[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [team, setTeam] = useState<Member[]>([]);
  const [company, setCompany] = useState<Record<string, string>>({});
  const [me, setMe] = useState({ name: profile.full_name ?? '', phone: profile.phone ?? '' });
  const [demoInstalled, setDemoInstalled] = useState(false);

  const refresh = async () => {
    const [d, p, c] = await Promise.all([
      supabase.from('depots').select('id,code,name,type,address,active').order('active', { ascending: false }).order('code'),
      supabase.from('products').select('id,sku,name,category,unit_type,unit_weight_kg,default_price_xof,min_stock,lead_time_days,active')
        .order('active', { ascending: false }).order('name'),
      supabase.from('clients').select('id,name,phone,type,credit_limit_xof,payment_terms_days,active').order('active', { ascending: false }).order('name'),
    ]);
    setDepots((d.data ?? []) as Depot[]);
    setProducts((p.data ?? []) as Product[]);
    setClients((c.data ?? []) as Client[]);
    rpc<Member[]>('team', {}).then(setTeam).catch(() => undefined);
    const { data: cs } = await supabase.from('app_settings').select('key,value');
    setCompany(Object.fromEntries(((cs ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value])));
    if (admin) rpc<{ installed: boolean }>('demo_status', {}).then((r) => setDemoInstalled(r.installed)).catch(() => undefined);
    reloadRooms();
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (initialPanel?.p) setPanel(initialPanel.p); }, [initialPanel?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const num = (s?: string) => (s === undefined || s === '' ? null : Number(String(s).replace(',', '.').replace(/\s/g, '')));
  const str = (x: unknown) => (x == null ? '' : String(x));
  const activeDepots = depots.filter((d) => d.active);

  const openEdit = (e: Edit) => {
    setError(null); setEdit(e);
    if (!e?.id) { setV({}); return; }
    if (e.kind === 'depot') { const d = depots.find((x) => x.id === e.id)!; setV({ code: d.code, name: d.name, type: d.type, address: str(d.address) }); }
    if (e.kind === 'product') {
      const p = products.find((x) => x.id === e.id)!;
      setV({ sku: p.sku, name: p.name, category: p.category, unit: p.unit_type, weight: str(p.unit_weight_kg), price: str(p.default_price_xof),
        min: str(p.min_stock), lead: str(p.lead_time_days) });
    }
    if (e.kind === 'client') {
      const c = clients.find((x) => x.id === e.id)!;
      setV({ name: c.name, phone: str(c.phone), type: c.type, limit: str(c.credit_limit_xof), terms: str(c.payment_terms_days) });
    }
  };

  const save = async () => {
    if (!edit) return;
    setBusy(true); setError(null);
    try {
      if (edit.kind === 'depot') {
        const row = { code: v.code.trim().toUpperCase(), name: v.name.trim(), type: v.type || 'frozen', address: v.address || null };
        const { error } = edit.id ? await supabase.from('depots').update(row).eq('id', edit.id) : await supabase.from('depots').insert(row);
        if (error) throw error;
        setDone(edit.id ? `Entrepôt ${row.name} modifié.` : `Entrepôt ${row.name} ajouté.`);
      } else if (edit.kind === 'product') {
        const row = {
          sku: v.sku.trim().toUpperCase(), name: v.name.trim(), category: v.category || 'viande', unit_type: v.unit || 'carton',
          unit_weight_kg: num(v.weight), default_price_xof: num(v.price), min_stock: num(v.min) ?? 0, lead_time_days: num(v.lead) ?? 45,
        };
        const { error } = edit.id ? await supabase.from('products').update(row).eq('id', edit.id) : await supabase.from('products').insert(row);
        if (error) throw error;
        setDone(edit.id ? `Produit ${row.name} modifié.` : `Produit ${row.name} ajouté.`);
      } else if (edit.kind === 'client') {
        if (edit.id) {
          const { error } = await supabase.from('clients').update({
            name: v.name.trim(), phone: v.phone || null, type: v.type || 'grossiste',
            credit_limit_xof: num(v.limit) ?? 0, payment_terms_days: num(v.terms) ?? 0,
          }).eq('id', edit.id);
          if (error) throw error;
        } else {
          await rpc('create_client', { p_name: v.name, p_phone: v.phone, p_type: v.type || 'grossiste',
            p_credit_limit_xof: num(v.limit) ?? 0, p_payment_terms_days: num(v.terms) ?? 0 });
        }
        setDone(edit.id ? `Client ${v.name} modifié.` : `Client ${v.name} ajouté.`);
      }
      setEdit(null);
      refresh();
    } catch (e) {
      const m = (e as Error).message;
      setError(m.includes('duplicate') ? 'Ce code ou ce nom existe déjà.' : m);
    } finally {
      setBusy(false);
    }
  };

  // Archiver = masquer des listes de saisie ; l'historique (factures, mouvements) reste intact
  const toggleActive = async (table: 'depots' | 'products' | 'clients', id: string, active: boolean) => {
    setBusy(true); setError(null);
    const { error } = await supabase.from(table).update({ active }).eq('id', id);
    setBusy(false);
    if (error) { setError(error.message); return; }
    setEdit(null); setDone(active ? 'Réactivé.' : 'Archivé : il n’apparaît plus dans les listes de saisie.'); refresh();
  };

  const setMember = async (id: string, patch: { role?: string; active?: boolean; depot?: string }) => {
    setBusy(true); setError(null);
    try {
      await rpc('admin_set_user', { p_user: id, p_role: patch.role ?? null, p_active: patch.active ?? null, p_depot: patch.depot ?? null });
      if (patch.active === true) await supabase.from('tasks').update({ status: 'resolue' }).eq('dedupe_key', `compte:${id}`);
      refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const saveMe = async () => {
    setBusy(true); setError(null);
    const { error } = await supabase.from('profiles').update({ full_name: me.name.trim(), phone: me.phone || null }).eq('id', profile.id);
    setBusy(false);
    if (error) { setError(error.message); return; }
    setPanel(null); setDone('Profil mis à jour.'); onProfileChange();
  };

  const saveCompany = async () => {
    setBusy(true); setError(null);
    try {
      for (const [k] of COMPANY_FIELDS) await rpc('set_setting', { p_key: k, p_value: company[k] ?? '' });
      setPanel(null); setDone('Informations de facturation enregistrées.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const pending = team.filter((t) => !t.active);
  const leads = team.filter((t) => t.active && (t.role === 'admin' || t.role === 'manager'));
  const mine = team.find((t) => t.id === profile.id);
  const current = edit?.id ? (edit.kind === 'depot' ? depots : edit.kind === 'product' ? products : clients).find((x) => x.id === edit.id) : undefined;
  const sections: { key: Panel; icon: LucideIcon; color: string; title: string; sub: string; show: boolean }[] = [
    { key: 'notifications', icon: Bell, color: '#FF3B30', title: 'Notifications du moteur', sub: `iPhone · Telegram${profile.telegram_chat_id ? ' lié' : ''}`, show: true },
    { key: 'depots', icon: Warehouse, color: '#1a237e', title: 'Entrepôts', sub: activeDepots.map((d) => d.name).join(', ') || 'Aucun', show: manage },
    { key: 'rooms', icon: Snowflake, color: '#007AFF', title: 'Chambres froides', sub: `${rooms.length} chambre${rooms.length > 1 ? 's' : ''}`, show: manage },
    { key: 'products', icon: Package, color: '#FF9500', title: 'Produits', sub: `${products.filter((p) => p.active).length} actif(s)`, show: manage },
    { key: 'clients', icon: Users, color: '#34C759', title: 'Clients', sub: `${clients.filter((c) => c.active).length} actif(s)`, show: finance },
    { key: 'team', icon: UserCog, color: '#AF52DE', title: 'Équipe et accès',
      sub: pending.length ? `${pending.length} compte(s) à valider` : `${team.filter((t) => t.active).length} membre(s)`, show: true },
    { key: 'company', icon: Building2, color: '#1a237e', title: 'Entreprise (factures)', sub: company.company_name || 'À compléter', show: admin },
    { key: 'demo', icon: Play, color: '#8E8E93', title: 'Démo en direct', sub: demoInstalled ? 'Installée · relancer ou supprimer' : 'Une journée type jouée en direct', show: admin && !!onStartDemo },
  ];

  return (
    <Screen title="Réglages" subtitle={`${profile.full_name || 'Utilisateur'} · ${ROLE_LABEL[profile.role]}`}>
      {done && <p className="rounded-2xl bg-surface-card text-caption px-4 py-3" onClick={() => setDone(null)}>
        <span className="text-status-success font-semibold">Fait · </span>{done}</p>}
      {activeDepots.length === 0 && manage && (
        <p className="rounded-2xl bg-surface-card text-caption text-text-secondary px-4 py-3">
          Pour démarrer : 1) vos entrepôts, 2) leurs chambres froides, 3) vos produits, 4) vos clients.
        </p>
      )}
      <button onClick={() => { setMe({ name: profile.full_name ?? '', phone: profile.phone ?? '' }); setPanel('profile'); }}
        className="w-full flex items-center gap-3 bg-surface-card border border-border-default rounded-2xl p-4 text-left">
        <Avatar name={profile.full_name} url={profile.avatar_url} size={56} />
        <span className="flex-1 min-w-0">
          <span className="block text-body font-semibold text-text-primary truncate">{profile.full_name || profile.email}</span>
          <span className="block text-caption text-text-secondary truncate">{profile.email}</span>
          <span className="block text-caption text-brand font-semibold">{ROLE_LABEL[profile.role]}{mine?.depot ? ` · ${mine.depot}` : ''}</span>
        </span>
        <ChevronRight size={18} className="text-text-muted" />
      </button>
      {leads.length > 0 && (
        <div className="flex items-center gap-2 px-1">
          <div className="flex -space-x-2">{leads.slice(0, 4).map((l) => <span key={l.id} className="ring-2 ring-surface-page rounded-full"><Avatar name={l.full_name} url={l.avatar_url} size={24} /></span>)}</div>
          <p className="text-caption text-text-secondary">Responsables : {leads.map((l) => `${l.full_name.split(' ')[0]} (${ROLE_LABEL[l.role]})`).join(', ')}</p>
        </div>
      )}
      <Group>
        {sections.filter((s) => s.show).map((s, i) => (
          <Row key={s.key} first={i === 0} icon={s.icon} color={s.color} title={s.title} sub={s.sub} onClick={() => { setError(null); setPanel(s.key); }} />
        ))}
      </Group>
      <Button variant="ghost" className="w-full" onClick={onSignOut}>Se déconnecter</Button>

      {/* ── Entrepôts ── */}
      <Sheet open={panel === 'depots'} title="Entrepôts" onClose={() => setPanel(null)}>
        <AddButton label="Ajouter un entrepôt" onClick={() => openEdit({ kind: 'depot' })} />
        <Group>
          {depots.map((d, i) => (
            <Row key={d.id} first={i === 0} muted={!d.active} title={`${d.name}${d.active ? '' : ' (archivé)'}`}
              sub={`${d.code} · ${rooms.filter((r) => r.depot_id === d.id).length} chambre(s)${d.address ? ` · ${d.address}` : ''}`}
              onClick={() => openEdit({ kind: 'depot', id: d.id })} />
          ))}
        </Group>
      </Sheet>

      {/* ── Chambres ── */}
      <Sheet open={panel === 'rooms'} title="Chambres froides" onClose={() => setPanel(null)}>
        {activeDepots.length > 0
          ? <AddButton label="Ajouter une chambre" onClick={() => openEdit({ kind: 'room' })} />
          : <p className="text-caption text-text-muted">Créez d’abord un entrepôt.</p>}
        {activeDepots.map((d) => (
          <div key={d.id} className="space-y-1">
            <p className="text-caption text-text-secondary px-1">{d.name}</p>
            <Group>
              {rooms.filter((r) => r.depot_id === d.id).map((r, i) => (
                <Row key={r.room_id} first={i === 0} title={r.room_name}
                  sub={`${r.room_code} · ${r.capacity_tonnes != null ? `${r.capacity_tonnes} t` : `${r.capacity_cartons} cartons`} · ${r.fill_pct ?? 0} % · ${r.status === 'louee' ? `louée à ${r.tenant}` : r.status === 'libre' ? 'libre' : 'stock ODS'}`}
                  onClick={() => setRoom(r)} />
              ))}
              {rooms.filter((r) => r.depot_id === d.id).length === 0 && <p className="text-caption text-text-muted px-4 py-3">Aucune chambre.</p>}
            </Group>
          </div>
        ))}
      </Sheet>
      <RoomSheet room={room} finance={finance} manage={manage} onClose={() => setRoom(null)}
        onChanged={() => { setRoom(null); setDone('Chambre mise à jour.'); refresh(); }} />

      {/* ── Produits ── */}
      <Sheet open={panel === 'products'} title="Produits" onClose={() => setPanel(null)}>
        <AddButton label="Ajouter un produit" onClick={() => openEdit({ kind: 'product' })} />
        <Group>
          {products.map((p, i) => (
            <Row key={p.id} first={i === 0} muted={!p.active} title={`${p.name}${p.active ? '' : ' (archivé)'}`}
              sub={`${p.sku} · ${p.category}${p.default_price_xof ? ` · ${fcfa(p.default_price_xof)}` : ' · prix à définir'} · min ${p.min_stock}`}
              onClick={() => openEdit({ kind: 'product', id: p.id })} />
          ))}
        </Group>
      </Sheet>

      {/* ── Clients ── */}
      <Sheet open={panel === 'clients'} title="Clients" onClose={() => setPanel(null)}>
        <AddButton label="Ajouter un client" onClick={() => openEdit({ kind: 'client' })} />
        <Group>
          {clients.map((c, i) => (
            <Row key={c.id} first={i === 0} muted={!c.active} title={`${c.name}${c.active ? '' : ' (archivé)'}`}
              sub={`${CLIENT_TYPES.find((t) => t.value === c.type)?.label ?? c.type}${c.phone ? ` · ${c.phone}` : ''} · crédit ${c.credit_limit_xof ? fcfa(c.credit_limit_xof) : 'aucun'} · ${c.payment_terms_days} j`}
              onClick={() => openEdit({ kind: 'client', id: c.id })} />
          ))}
        </Group>
      </Sheet>

      {/* ── Formulaires création / modification ── */}
      <Sheet open={edit?.kind === 'room'} title="Nouvelle chambre froide" onClose={() => setEdit(null)}>
        <RoomForm depots={activeDepots} onDone={(m) => { setDone(m); setEdit(null); refresh(); }} />
      </Sheet>

      <Sheet open={edit?.kind === 'depot'} title={edit?.id ? 'Modifier l’entrepôt' : 'Nouvel entrepôt'} onClose={() => setEdit(null)}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code"><Input value={v.code ?? ''} onChange={set('code')} placeholder="ALM" /></Field>
          <Field label="Type"><Select options={DEPOT_TYPES} value={v.type ?? 'frozen'} onChange={set('type')} /></Field>
        </div>
        <Field label="Nom"><Input value={v.name ?? ''} onChange={set('name')} placeholder="Entrepôt Almadies" /></Field>
        <Field label="Adresse / quartier"><Input value={v.address ?? ''} onChange={set('address')} placeholder="Almadies, Sodida…" /></Field>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.code || !v.name} onClick={save}>{edit?.id ? 'Enregistrer' : 'Ajouter'}</Button>
        {edit?.id && current && (
          <Button variant="ghost" className="w-full" disabled={busy} onClick={() => toggleActive('depots', edit.id!, !current.active)}>
            {current.active ? 'Archiver l’entrepôt' : 'Réactiver l’entrepôt'}</Button>
        )}
      </Sheet>

      <Sheet open={edit?.kind === 'product'} title={edit?.id ? 'Modifier le produit' : 'Nouveau produit'} onClose={() => setEdit(null)}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU"><Input value={v.sku ?? ''} onChange={set('sku')} placeholder="BOE-FOI-20" /></Field>
          <Field label="Catégorie"><Select options={['viande', 'abats', 'volaille', 'poisson', 'fromage', 'autre'].map((x) => ({ value: x, label: x }))}
            value={v.category ?? 'viande'} onChange={set('category')} /></Field>
        </div>
        <Field label="Nom"><Input value={v.name ?? ''} onChange={set('name')} placeholder="Foie de bœuf 20 kg" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unité"><Select options={['carton', 'kg', 'sac', 'piece', 'tonne'].map((x) => ({ value: x, label: x }))}
            value={v.unit ?? 'carton'} onChange={set('unit')} /></Field>
          <Field label="Poids / unité (kg)"><Input inputMode="decimal" value={v.weight ?? ''} onChange={set('weight')} /></Field>
          <Field label="Prix de vente (FCFA)"><Input inputMode="numeric" value={v.price ?? ''} onChange={set('price')} /></Field>
          <Field label="Stock minimum"><Input inputMode="decimal" value={v.min ?? ''} onChange={set('min')} /></Field>
          <Field label="Délai réappro (j)"><Input inputMode="numeric" value={v.lead ?? ''} onChange={set('lead')} placeholder="45" /></Field>
        </div>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.sku || !v.name} onClick={save}>{edit?.id ? 'Enregistrer' : 'Ajouter'}</Button>
        {edit?.id && current && (
          <Button variant="ghost" className="w-full" disabled={busy} onClick={() => toggleActive('products', edit.id!, !current.active)}>
            {current.active ? 'Archiver le produit' : 'Réactiver le produit'}</Button>
        )}
      </Sheet>

      <Sheet open={edit?.kind === 'client'} title={edit?.id ? 'Modifier le client' : 'Nouveau client'} onClose={() => setEdit(null)}>
        <Field label="Nom"><Input value={v.name ?? ''} onChange={set('name')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Téléphone"><Input inputMode="tel" value={v.phone ?? ''} onChange={set('phone')} placeholder="77 000 00 00" /></Field>
          <Field label="Type"><Select options={CLIENT_TYPES} value={v.type ?? 'grossiste'} onChange={set('type')} /></Field>
          <Field label="Limite de crédit"><Input inputMode="numeric" value={v.limit ?? ''} onChange={set('limit')} placeholder="0 = aucune" /></Field>
          <Field label="Paiement à (jours)"><Input inputMode="numeric" value={v.terms ?? ''} onChange={set('terms')} placeholder="0" /></Field>
        </div>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !v.name} onClick={save}>{edit?.id ? 'Enregistrer' : 'Ajouter'}</Button>
        {edit?.id && current && (
          <Button variant="ghost" className="w-full" disabled={busy} onClick={() => toggleActive('clients', edit.id!, !current.active)}>
            {current.active ? 'Archiver le client' : 'Réactiver le client'}</Button>
        )}
      </Sheet>

      {/* ── Mon profil ── */}
      <Sheet open={panel === 'profile'} title="Mon profil" onClose={() => setPanel(null)}>
        <div className="flex flex-col items-center gap-2 py-2">
          <Avatar name={profile.full_name} url={profile.avatar_url} size={80} />
          <p className="text-caption text-text-secondary">{mine?.provider === 'google' ? 'Connecté avec Google' : 'Connecté par email'}</p>
        </div>
        <Field label="Nom affiché"><Input value={me.name} onChange={(e) => setMe({ ...me, name: e.target.value })} /></Field>
        <Field label="Téléphone"><Input inputMode="tel" value={me.phone} onChange={(e) => setMe({ ...me, phone: e.target.value })} placeholder="77 000 00 00" /></Field>
        <div className="rounded-2xl bg-surface-subtle p-4 space-y-1 text-caption text-text-secondary">
          <p>Email : <b className="text-text-primary">{profile.email}</b></p>
          <p>Rôle : <b className="text-text-primary">{ROLE_LABEL[profile.role]}</b> — {ROLE_HELP[profile.role]}</p>
          {mine?.depot && <p>Entrepôt : <b className="text-text-primary">{mine.depot}</b></p>}
          <p>Dernière connexion : {ago(mine?.last_sign_in_at)}</p>
          <p className="pt-1">Le rôle est attribué par un administrateur.</p>
        </div>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy || !me.name.trim()} onClick={saveMe}>Enregistrer</Button>
        <Button variant="ghost" className="w-full" onClick={onSignOut}>Se déconnecter</Button>
      </Sheet>

      {/* ── Équipe ── */}
      <Sheet open={panel === 'team'} title="Équipe et accès" onClose={() => setPanel(null)}>
        <p className="flex gap-2 text-caption text-text-secondary"><ShieldCheck size={16} className="text-brand shrink-0" />
          Tout nouveau compte (email ou Google) est bloqué tant qu’un administrateur ne l’a pas validé. Un compte désactivé perd l’accès immédiatement.</p>
        {admin && pending.length > 0 && <>
          <p className="text-caption text-text-secondary px-1">À valider</p>
          {pending.map((u) => (
            <div key={u.id} className="rounded-2xl border border-status-warning p-3 space-y-2">
              <div className="flex items-center gap-3">
                <Avatar name={u.full_name} url={u.avatar_url} size={40} />
                <div className="min-w-0"><p className="text-body font-semibold truncate">{u.full_name || '—'}</p>
                  <p className="text-caption text-text-muted truncate">{u.email} · {u.provider === 'google' ? 'Google' : 'email'} · demandé {ago(u.created_at)}</p></div>
              </div>
              <div className="flex gap-2">
                {(['magasinier', 'manager', 'cfo'] as const).map((r) => (
                  <button key={r} disabled={busy} onClick={() => setMember(u.id, { role: r, active: true })}
                    className="flex-1 rounded-xl bg-brand text-white py-2 text-caption font-semibold">{ROLE_LABEL[r]}</button>
                ))}
              </div>
            </div>
          ))}
        </>}
        <p className="text-caption text-text-secondary px-1">Membres</p>
        <Group>
          {team.filter((u) => u.active).map((u, i) => (
            <div key={u.id} className={cx('px-4 py-3 space-y-2', i > 0 && 'border-t border-border-default')}>
              <div className="flex items-center gap-3">
                <Avatar name={u.full_name} url={u.avatar_url} size={40} />
                <div className="flex-1 min-w-0">
                  <p className="text-body truncate">{u.full_name || '—'} {u.id === profile.id && <Badge tone="info">Vous</Badge>}</p>
                  <p className="text-caption text-text-muted truncate">{ROLE_LABEL[u.role]}{u.depot ? ` · ${u.depot}` : ''}{admin && u.email ? ` · ${u.email}` : ''}</p>
                  {admin && <p className="text-micro text-text-muted">Vu {ago(u.last_seen_at ?? u.last_sign_in_at)}{u.provider ? ` · ${u.provider === 'google' ? 'Google' : 'email'}` : ''}</p>}
                </div>
              </div>
              {admin && u.id !== profile.id && (
                <div className="flex gap-2">
                  <select value={u.role} disabled={busy} onChange={(e) => setMember(u.id, { role: e.target.value })}
                    className="flex-1 rounded-xl border border-border-strong px-2 py-2 text-caption bg-surface-card">
                    {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <select value="" disabled={busy} onChange={(e) => e.target.value && setMember(u.id, { depot: e.target.value })}
                    className="flex-1 rounded-xl border border-border-strong px-2 py-2 text-caption bg-surface-card">
                    <option value="">{u.depot ?? 'Entrepôt…'}</option>
                    {activeDepots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                  <button disabled={busy} onClick={() => setMember(u.id, { active: false })}
                    className="rounded-xl bg-status-danger-bg text-status-danger px-3 text-caption font-semibold">Désactiver</button>
                </div>
              )}
            </div>
          ))}
        </Group>
        <ErrorNote error={error} />
      </Sheet>

      {/* ── Entreprise ── */}
      <Sheet open={panel === 'company'} title="Entreprise (factures)" onClose={() => setPanel(null)}>
        <p className="text-caption text-text-secondary">Ces informations figurent en tête de chaque facture.</p>
        {COMPANY_FIELDS.map(([k, label, ph]) => (
          <Field key={k} label={label}><Input value={company[k] ?? ''} placeholder={ph} onChange={(e) => setCompany({ ...company, [k]: e.target.value })} /></Field>
        ))}
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy} onClick={saveCompany}>Enregistrer</Button>
      </Sheet>

      <Sheet open={panel === 'notifications'} title="Notifications" onClose={() => setPanel(null)}>
        <NotificationSettings profile={profile} onChange={onProfileChange} />
      </Sheet>

      {/* ── Démo ── */}
      <Sheet open={panel === 'demo'} title="Démo en direct" onClose={() => setPanel(null)}>
        <p className="text-body text-text-secondary">
          DEPOTEK joue une journée type avec ses vraies règles : conteneur reçu, vente FEFO, vente à perte et dépassement de crédit
          bloqués, encaissement Wave, perte, chambre qui se remplit, location d’une chambre entière.
        </p>
        <p className="text-caption text-text-muted">
          Tout est marqué « démo » et se supprime en un geste, sans toucher à vos vraies données ni à la numérotation des factures.
        </p>
        <Button className="w-full" onClick={() => { setPanel(null); onStartDemo?.(); }}>Lancer la démo en direct</Button>
        {demoInstalled && (
          <Button variant="ghost" className="w-full" disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try { await rpc('demo_purge', {}); setDemoInstalled(false); setPanel(null); setDone('Données de démo supprimées.'); refresh(); }
            catch (e) { setError((e as Error).message); } finally { setBusy(false); }
          }}>Supprimer les données de démo</Button>
        )}
        <ErrorNote error={error} />
      </Sheet>
    </Screen>
  );
}
