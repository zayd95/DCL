import React, { useCallback, useEffect, useState } from 'react';
import { Snowflake, Zap } from 'lucide-react';
import { supabase } from '../supabase';
import { Card, Badge, Empty, ErrorNote, Field, Input, Select, Button, fcfa, shortDate } from '../ui';
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
export function RoomsView({ finance }: { finance: boolean }) {
  const { rooms, error } = useRooms();
  const depots = [...new Map(rooms.map((r) => [r.depot_id, r.depot_name])).entries()];
  if (!rooms.length && !error) return <Empty>Aucune chambre. Ajoutez vos entrepôts et chambres dans Réglages.</Empty>;
  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      {depots.map(([id, name]) => (
        <section key={id} className="space-y-2">
          <h2 className="text-label font-black uppercase tracking-widest text-text-secondary px-1">{name}</h2>
          {rooms.filter((r) => r.depot_id === id).map((r) => (
            <Card key={r.room_id}>
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
    </div>
  );
}

/** Formulaire de création d'une chambre froide. */
export function RoomForm({ depots, onDone }: { depots: { id: string; code: string; name: string }[]; onDone: (msg: string) => void }) {
  const [v, setV] = useState<Record<string, string>>({ kind: 'frozen', depot: depots[0]?.id ?? '' });
  const [cats, setCats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const num = (s?: string) => (s ? Number(s.replace(',', '.')) : null);

  const save = async () => {
    setBusy(true); setError(null);
    const { error } = await supabase.from('storage_units').insert({
      depot_id: v.depot || depots[0]?.id, code: v.code.trim().toUpperCase(), name: v.name.trim(), kind: v.kind,
      capacity_tonnes: num(v.tonnes), capacity_cartons: num(v.cartons), categories: cats,
      temp_min_c: num(v.tmin), temp_max_c: num(v.tmax),
    });
    setBusy(false);
    if (error) setError(error.message.includes('duplicate') ? 'Ce code de chambre existe déjà dans cet entrepôt.' : error.message);
    else onDone(`Chambre ${v.name} ajoutée.`);
  };

  return (
    <div className="space-y-3">
      {depots.length > 1 && (
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
      <Button className="w-full" disabled={busy || !v.code || !v.name || (!v.tonnes && !v.cartons)} onClick={save}>Ajouter la chambre</Button>
    </div>
  );
}
