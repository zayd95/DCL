import React, { useEffect, useState } from 'react';
import { Bell, Warehouse, Snowflake, Package, Users, UserCog, Play, ChevronRight, Plus, type LucideIcon } from 'lucide-react';
import { supabase, rpc, type Profile, canManage, canSeeFinance } from '../supabase';
import { Screen, Sheet, Field, Input, Select, Button, ErrorNote, Badge, fcfa } from '../ui';
import { cx } from '../cx';
import { NotificationSettings } from './Notifications';
import { RoomForm, RoomSheet, useRooms, type Room } from './Rooms';

type Panel = 'depots' | 'rooms' | 'products' | 'clients' | 'users' | 'notifications' | 'demo' | null;
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

export function Settings({ profile, onSignOut, onProfileChange, onStartDemo }: {
  profile: Profile; onSignOut: () => void; onProfileChange: () => void; onStartDemo?: () => void;
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
  const [users, setUsers] = useState<Profile[]>([]);
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
    if (admin) {
      const { data } = await supabase.from('profiles').select('*').order('created_at');
      setUsers((data ?? []) as Profile[]);
      rpc<{ installed: boolean }>('demo_status', {}).then((r) => setDemoInstalled(r.installed)).catch(() => undefined);
    }
    reloadRooms();
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const setRole = async (id: string, role: string) => {
    const { error } = await supabase.from('profiles').update({ role }).eq('id', id);
    if (error) setError(error.message); else refresh();
  };

  const current = edit?.id ? (edit.kind === 'depot' ? depots : edit.kind === 'product' ? products : clients).find((x) => x.id === edit.id) : undefined;
  const sections: { key: Panel; icon: LucideIcon; color: string; title: string; sub: string; show: boolean }[] = [
    { key: 'notifications', icon: Bell, color: '#FF3B30', title: 'Notifications du moteur', sub: `iPhone · Telegram${profile.telegram_chat_id ? ' lié' : ''}`, show: true },
    { key: 'depots', icon: Warehouse, color: '#1a237e', title: 'Entrepôts', sub: activeDepots.map((d) => d.name).join(', ') || 'Aucun', show: manage },
    { key: 'rooms', icon: Snowflake, color: '#007AFF', title: 'Chambres froides', sub: `${rooms.length} chambre${rooms.length > 1 ? 's' : ''}`, show: manage },
    { key: 'products', icon: Package, color: '#FF9500', title: 'Produits', sub: `${products.filter((p) => p.active).length} actif(s)`, show: manage },
    { key: 'clients', icon: Users, color: '#34C759', title: 'Clients', sub: `${clients.filter((c) => c.active).length} actif(s)`, show: finance },
    { key: 'users', icon: UserCog, color: '#AF52DE', title: 'Utilisateurs et rôles', sub: `${users.length} compte(s)`, show: admin },
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

      {/* ── Utilisateurs ── */}
      <Sheet open={panel === 'users'} title="Utilisateurs" onClose={() => setPanel(null)}>
        <p className="text-caption text-text-secondary">Chaque personne crée son compte depuis l’écran de connexion, puis vous lui attribuez son rôle ici.</p>
        <Group>
          {users.map((u, i) => (
            <div key={u.id} className={cx('flex items-center justify-between gap-3 px-4 py-3', i > 0 && 'border-t border-border-default')}>
              <div className="min-w-0 flex items-center gap-2">
                <p className="text-body truncate">{u.full_name || '—'}</p>
                {u.id === profile.id && <Badge tone="info">Vous</Badge>}
              </div>
              <select disabled={u.id === profile.id} value={u.role} onChange={(e) => setRole(u.id, e.target.value)}
                className="rounded-xl border border-border-strong px-2 py-2 text-body bg-surface-card">
                {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          ))}
        </Group>
        <ErrorNote error={error} />
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
