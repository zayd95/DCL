import React, { useCallback, useEffect, useState } from 'react';
import { Snowflake, Zap, ArrowDownToLine, MoveRight, KeyRound, DoorOpen, Pencil, Archive, ChevronRight, type LucideIcon } from 'lucide-react';
import { supabase } from '../supabase';
import { Card, Badge, Empty, ErrorNote, Field, Input, Select, Button, Sheet, fcfa, qty, shortDate } from '../ui';
import { useNav } from '../nav';
import { cx } from '../cx';

export interface Room {
  room_id: string; room_code: string; room_name: string; kind: string; temp_min_c: number | null; temp_max_c: number | null;
  capacity_tonnes: number | null; capacity_cartons: number | null; categories: string[];
  depot_id: string; depot_code: string; depot_name: string;
  used_tonnes: number; used_cartons: number; value_xof: number; lots: number; products: string | null;
  fill_pct: number | null; contract_id: string | null; tenant: string | null; billing: string | null;
  price_xof: number | null; start_date: string | null; end_date: string | null; electricity_by_tenant: boolean | null;
  status: 'libre' | 'ods' | 'louee';
}

export const CATEGORIES = ['viande', 'abats', 'volaille', 'poisson', 'fromage', 'autre'];
const KIND: Record<string, string> = { frozen: 'Congelé', chilled: 'Frais', dry: 'Sec', mixed: 'Mixte' };

export function useRooms() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('v_storage_rooms').select('*').order('depot_code').order('room_code');
    setError(error?.message ?? null);
    setRooms((data ?? []) as Room[]);
  }, []);
  useEffect(() => { load(); }, [load]);
  return { rooms, error, reload: load };
}

function FillBar({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const p = Math.min(100, Math.max(0, Number(pct)));
  return (
    <div className="h-2 rounded-full bg-surface-subtle overflow-hidden mt-2">
      <div className={cx('h-full rounded-full', p >= 90 ? 'bg-status-danger' : p >= 70 ? 'bg-status-warning' : 'bg-status-success')}
        style={{ width: `${p}%` }} />
    </div>
  );
}

/** Occupation des chambres froides, par entrepôt. */
export function RoomsView({ finance, manage = false }: { finance: boolean; manage?: boolean }) {
  const { rooms, error, reload } = useRooms();
  const [sel, setSel] = useState<Room | null>(null);
  const depots = [...new Map(rooms.map((r) => [r.depot_id, r.depot_name])).entries()];
  if (!rooms.length && !error) return <Empty>Aucune chambre. Ajoutez vos entrepôts et chambres dans Réglages.</Empty>;
  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      {depots.map(([id, name]) => (
        <section key={id} className="space-y-2">
          <h2 className="text-label font-black uppercase tracking-widest text-text-secondary px-1">{name}</h2>
          {rooms.filter((r) => r.depot_id === id).map((r) => (
            <Card key={r.room_id} onClick={() => setSel(r)}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-body font-bold flex items-center gap-1"><Snowflake size={14} className="text-status-info" /> {r.room_name}</p>
                  <p className="text-caption text-text-muted">
                    {r.room_code} · {KIND[r.kind] ?? r.kind}
                    {r.temp_min_c != null && ` · ${r.temp_min_c}°/${r.temp_max_c}°C`}
                    {r.categories?.length ? ` · ${r.categories.join(', ')}` : ''}
                  </p>
                </div>
                <Badge tone={r.status === 'louee' ? 'info' : r.status === 'ods' ? 'ok' : 'muted'}>
                  {r.status === 'louee' ? 'Louée' : r.status === 'ods' ? 'Stock ODS' : 'Libre'}
                </Badge>
              </div>
              {r.status === 'louee' ? (
                <div className="mt-2 text-caption text-text-secondary space-y-0.5">
                  <p className="text-body font-bold text-text-primary">{r.tenant}</p>
                  <p>{r.billing === 'forfait' ? 'Forfait' : 'Mensuel'}{finance && r.price_xof ? ` · ${fcfa(r.price_xof)}${r.billing === 'mensuel' ? '/mois' : ''}` : ''}
                    {' · '}du {shortDate(r.start_date)}{r.end_date ? ` au ${shortDate(r.end_date)}` : ' (sans fin)'}</p>
                  {r.electricity_by_tenant && <p className="flex items-center gap-1"><Zap size={12} /> Électricité à la charge du locataire</p>}
                </div>
              ) : (
                <>
                  <p className="text-caption text-text-secondary mt-2">
                    {r.capacity_tonnes != null && `${r.used_tonnes} / ${r.capacity_tonnes} t`}
                    {r.capacity_tonnes != null && r.capacity_cartons != null && ' · '}
                    {r.capacity_cartons != null && `${r.used_cartons} / ${r.capacity_cartons} cartons`}
                    {r.fill_pct != null && ` · ${r.fill_pct} %`}
                    {finance && r.value_xof > 0 && ` · ${fcfa(r.value_xof)}`}
                  </p>
                  <FillBar pct={r.fill_pct} />
                  {r.products && <p className="text-caption text-text-muted mt-2 truncate">{r.products}</p>}
                </>
              )}
            </Card>
          ))}
        </section>
      ))}
      <RoomSheet room={sel} finance={finance} manage={manage} onClose={() => setSel(null)} onChanged={() => { setSel(null); reload(); }} />
    </div>
  );
}

interface RoomLot { lot_number: string; product_name: string; quantity: number; unit_type: string; expiry_date: string | null; fefo_status: string; owner_client: string | null }

/** Fiche d'une chambre : contenu et actions utiles (recevoir, ranger, louer, modifier, archiver). */
export function RoomSheet({ room, finance, manage, onClose, onChanged }: {
  room: Room | null; finance: boolean; manage: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { openOp } = useNav();
  const [lots, setLots] = useState<RoomLot[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [depots, setDepots] = useState<{ id: string; code: string; name: string }[]>([]);

  useEffect(() => {
    setEditing(false); setError(null); setLots([]);
    if (!room) return;
    supabase.from('v_stock_lots').select('lot_number,product_name,quantity,unit_type,expiry_date,fefo_status,owner_client')
      .eq('depot_code', room.depot_code).eq('room_code', room.room_code).order('expiry_date', { nullsFirst: false })
      .then(({ data }) => setLots((data ?? []) as RoomLot[]));
    supabase.from('depots').select('id,code,name').eq('active', true).order('code').then(({ data }) => setDepots(data ?? []));
  }, [room?.room_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!room) return null;
  const rented = room.status === 'louee';
  const empty = Number(room.lots) === 0;

  const archive = async () => {
    setError(null);
    // Supprimée si jamais utilisée, sinon archivée (l'historique reste intact)
    const del = await supabase.from('storage_units').delete().eq('id', room.room_id);
    if (del.error) {
      const up = await supabase.from('storage_units').update({ active: false }).eq('id', room.room_id);
      if (up.error) { setError(up.error.message); return; }
    }
    onChanged();
  };

  const actions: { label: string; sub: string; icon: LucideIcon; color: string; show: boolean; run: () => void }[] = [
    { label: 'Réception dans cette chambre', sub: rented ? `Marchandise de ${room.tenant}` : 'Entrée de stock rangée ici', icon: ArrowDownToLine, color: '#1a237e',
      show: true, run: () => openOp('reception', { room: room.room_id, ...(rented && room.tenant ? { owner: room.tenant } : {}) }) },
    { label: 'Ranger un lot ici', sub: 'Déplacer un lot du même entrepôt', icon: MoveRight, color: '#30B0C7',
      show: !rented, run: () => openOp('deplacer', { room: room.room_id }) },
    { label: 'Louer cette chambre', sub: 'Chambre entière, au mois ou au forfait', icon: KeyRound, color: '#1a237e',
      show: finance && room.status === 'libre', run: () => openOp('location', { room: room.room_id }) },
    { label: 'Mettre fin à la location', sub: room.tenant ?? '', icon: DoorOpen, color: '#FF3B30',
      show: finance && rented && !!room.contract_id, run: () => openOp('fin_location', { contract: room.contract_id! }) },
    { label: 'Modifier la chambre', sub: 'Nom, capacité, températures, produits', icon: Pencil, color: '#FF9500',
      show: manage, run: () => setEditing(true) },
    { label: 'Archiver la chambre', sub: empty && !rented ? 'Elle disparaît des listes' : 'Videz-la et terminez la location d’abord', icon: Archive, color: '#8E8E93',
      show: manage, run: () => { if (empty && !rented) archive(); else setError('Impossible : la chambre doit être vide et non louée.'); } },
  ];

  return (
    <Sheet open title={room.room_name} onClose={onClose}>
      {editing ? (
        <RoomForm depots={depots} room={room} onDone={() => onChanged()} />
      ) : (
        <>
          <div className="bg-surface-subtle rounded-2xl p-4">
            <p className="text-caption text-text-secondary">{room.depot_name} · {room.room_code} · {KIND[room.kind] ?? room.kind}
              {room.temp_min_c != null && ` · ${room.temp_min_c}°/${room.temp_max_c}°C`}</p>
            <p className="text-title font-bold text-text-primary mt-1 tabular-nums">
              {room.fill_pct != null ? `${room.fill_pct} %` : '—'}
              <span className="text-caption font-normal text-text-secondary"> rempli
                {room.capacity_tonnes != null && ` · ${room.used_tonnes} / ${room.capacity_tonnes} t`}
                {room.capacity_cartons != null && ` · ${room.used_cartons} / ${room.capacity_cartons} cartons`}</span>
            </p>
            <FillBar pct={room.fill_pct} />
            <p className="text-caption text-text-muted mt-2">Produits autorisés : {room.categories?.length ? room.categories.join(', ') : 'tous'}</p>
            {rented && <p className="text-caption text-text-secondary mt-1">Louée à <b>{room.tenant}</b>{room.end_date ? ` jusqu’au ${shortDate(room.end_date)}` : ''}
              {finance && room.price_xof ? ` · ${fcfa(room.price_xof)}${room.billing === 'mensuel' ? '/mois' : ''}` : ''}</p>}
          </div>

          <div className="bg-surface-card border border-border-default rounded-2xl overflow-hidden">
            {actions.filter((a) => a.show).map((a, i) => (
              <button key={a.label} onClick={a.run} className="w-full flex items-center gap-3 pl-4 text-left active:bg-surface-subtle">
                <span className="w-7 h-7 rounded-lg text-white flex items-center justify-center shrink-0" style={{ background: a.color }}><a.icon size={15} /></span>
                <span className={cx('flex-1 flex items-center justify-between gap-2 py-3 pr-4 min-w-0', i > 0 && 'border-t border-border-default')}>
                  <span className="min-w-0">
                    <span className="block text-body text-text-primary">{a.label}</span>
                    {a.sub && <span className="block text-caption text-text-muted truncate">{a.sub}</span>}
                  </span>
                  <ChevronRight size={18} className="text-text-muted shrink-0" />
                </span>
              </button>
            ))}
          </div>
          <ErrorNote error={error} />

          <p className="text-caption text-text-secondary px-1">Contenu ({lots.length} lot{lots.length > 1 ? 's' : ''})</p>
          {lots.length === 0 ? (
            <p className="text-caption text-text-muted px-1">Chambre vide. Utilisez « Réception dans cette chambre » ou « Ranger un lot ici ».</p>
          ) : (
            <div className="bg-surface-card border border-border-default rounded-2xl divide-y divide-border-default">
              {lots.map((l) => (
                <div key={l.lot_number} className="px-4 py-3">
                  <p className="text-body text-text-primary">{l.product_name}</p>
                  <p className="text-caption text-text-muted">Lot {l.lot_number} · {qty(l.quantity)} {l.unit_type} · {l.expiry_date ? `exp. ${shortDate(l.expiry_date)}` : 'DLC à saisir'}
                    {l.owner_client ? ` · à ${l.owner_client}` : ''}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

/** Formulaire de création d'une chambre froide. */
export function RoomForm({ depots, onDone, room }: { depots: { id: string; code: string; name: string }[]; onDone: (msg: string) => void; room?: Room }) {
  const str = (x: number | null | undefined) => (x == null ? '' : String(x));
  const [v, setV] = useState<Record<string, string>>(room
    ? { kind: room.kind, depot: room.depot_id, code: room.room_code, name: room.room_name, tonnes: str(room.capacity_tonnes),
        cartons: str(room.capacity_cartons), tmin: str(room.temp_min_c), tmax: str(room.temp_max_c) }
    : { kind: 'frozen', depot: depots[0]?.id ?? '' });
  const [cats, setCats] = useState<string[]>(room?.categories ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const num = (s?: string) => (s ? Number(String(s).replace(',', '.')) : null);

  const save = async () => {
    setBusy(true); setError(null);
    const row = {
      code: v.code.trim().toUpperCase(), name: v.name.trim(), kind: v.kind,
      capacity_tonnes: num(v.tonnes), capacity_cartons: num(v.cartons), categories: cats,
      temp_min_c: num(v.tmin), temp_max_c: num(v.tmax),
    };
    const { error } = room
      ? await supabase.from('storage_units').update(row).eq('id', room.room_id)
      : await supabase.from('storage_units').insert({ ...row, depot_id: v.depot || depots[0]?.id });
    setBusy(false);
    if (error) setError(error.message.includes('duplicate') ? 'Ce code de chambre existe déjà dans cet entrepôt.' : error.message);
    else onDone(room ? `Chambre ${v.name} modifiée.` : `Chambre ${v.name} ajoutée.`);
  };

  return (
    <div className="space-y-3">
      {!room && depots.length > 1 && (
        <Field label="Entrepôt"><Select options={depots.map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))} value={v.depot} onChange={set('depot')} /></Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Code"><Input value={v.code ?? ''} onChange={set('code')} placeholder="CF1" /></Field>
        <Field label="Type"><Select options={[{ value: 'frozen', label: 'Congelé' }, { value: 'chilled', label: 'Frais' }]} value={v.kind} onChange={set('kind')} /></Field>
      </div>
      <Field label="Nom"><Input value={v.name ?? ''} onChange={set('name')} placeholder="Grand frigo viande" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Capacité (tonnes)"><Input inputMode="decimal" value={v.tonnes ?? ''} onChange={set('tonnes')} placeholder="ex. 40" /></Field>
        <Field label="ou (cartons)"><Input inputMode="numeric" value={v.cartons ?? ''} onChange={set('cartons')} /></Field>
        <Field label="T° min (°C)"><Input inputMode="decimal" value={v.tmin ?? ''} onChange={set('tmin')} placeholder="-25" /></Field>
        <Field label="T° max (°C)"><Input inputMode="decimal" value={v.tmax ?? ''} onChange={set('tmax')} placeholder="-18" /></Field>
      </div>
      <Field label="Produits autorisés (aucun = tous)">
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <button key={c} type="button" onClick={() => setCats(cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])}
              className={cx('rounded-full px-3 py-1.5 text-caption font-bold border',
                cats.includes(c) ? 'bg-brand text-white border-brand' : 'bg-surface-card text-text-secondary border-border-strong')}>
              {c}
            </button>
          ))}
        </div>
      </Field>
      <ErrorNote error={error} />
      <Button className="w-full" disabled={busy || !v.code || !v.name || (!v.tonnes && !v.cartons)} onClick={save}>{room ? 'Enregistrer' : 'Ajouter la chambre'}</Button>
    </div>
  );
}
