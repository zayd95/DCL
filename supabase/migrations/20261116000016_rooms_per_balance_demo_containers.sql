-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — 1) Chambre suivie par solde (lot × entrepôt) : un lot transféré
--              partiellement vers un autre entrepôt a sa propre chambre là-bas.
--           2) Transfert vers une chambre précise.
--           3) Qualité des données : coût / DLC / chambre manquants → « À traiter »,
--              et update_lot_info() pour compléter un lot.
--           4) Démo bâtie sur 5 conteneurs d'import (données anonymisées « démo »).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 1. Chambre au niveau du solde ───────────────────────────────────────────
alter table public.stock_balances add column if not exists storage_unit_id uuid references public.storage_units(id) on delete set null;
create index if not exists stock_balances_unit_idx on public.stock_balances (storage_unit_id);

update public.stock_balances b set storage_unit_id = l.storage_unit_id
  from public.lots l join public.storage_units su on su.id = l.storage_unit_id
 where l.id = b.lot_id and su.depot_id = b.depot_id and b.storage_unit_id is null;

create or replace function public.tg_apply_movement() returns trigger
language plpgsql set search_path = public as $$
begin
  -- UPDATE d'abord : la CHECK (quantity >= 0) bloque toute sortie au-delà du stock
  update public.stock_balances
     set quantity = quantity + new.qty, updated_at = now(),
         storage_unit_id = coalesce(new.storage_unit_id, storage_unit_id)
   where lot_id = new.lot_id and depot_id = new.depot_id;
  if not found then
    if new.qty < 0 then
      raise exception 'Aucun stock de ce lot dans ce dépôt' using errcode = '23514';
    end if;
    insert into public.stock_balances (lot_id, depot_id, quantity, storage_unit_id, updated_at)
    values (new.lot_id, new.depot_id, new.qty, new.storage_unit_id, now());
  end if;
  return new;
end $$;

create or replace function public.move_lot(p_product text, p_lot_number text, p_room text, p_depot text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prod products;
  v_lot  lots;
  v_unit storage_units;
  v_bal  stock_balances;
begin
  perform require_role('magasinier', 'manager');
  v_prod := resolve_product(p_product);
  select * into v_lot from lots where product_id = v_prod.id and lot_number = trim(p_lot_number) for update;
  if not found then raise exception 'Lot % introuvable pour %', p_lot_number, v_prod.name; end if;
  v_unit := resolve_room(p_room, case when p_depot is not null then (resolve_depot(p_depot)).id end);
  select * into v_bal from stock_balances where lot_id = v_lot.id and depot_id = v_unit.depot_id and quantity > 0 for update;
  if not found then raise exception 'Le lot % n''est pas en stock dans cet entrepôt : faites d''abord un transfert', v_lot.lot_number; end if;
  perform check_room_entry(v_unit.id, v_prod.id, v_lot.owner_client_id);
  update stock_balances set storage_unit_id = v_unit.id where lot_id = v_lot.id and depot_id = v_unit.depot_id;
  update lots set storage_unit_id = v_unit.id
   where id = v_lot.id and (storage_unit_id is null or storage_unit_id in (select id from storage_units where depot_id = v_unit.depot_id));
  return jsonb_build_object('product', v_prod.name, 'lot_number', v_lot.lot_number, 'room', v_unit.name);
end $$;

-- ─── 2. Transfert vers une chambre ───────────────────────────────────────────
drop function if exists public.transfer_stock(text, numeric, text, text);
create or replace function public.transfer_stock(
  p_product text, p_qty numeric, p_from_depot text, p_to_depot text, p_to_room text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prod  products;
  v_from  depots;
  v_to    depots;
  v_room  storage_units;
  v_ref   uuid := gen_random_uuid();
  v_left  numeric := p_qty;
  v_take  numeric;
  v_picks jsonb := '[]'::jsonb;
  r       record;
begin
  perform require_role('magasinier', 'manager');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantité invalide'; end if;
  v_prod := resolve_product(p_product);
  v_from := resolve_depot(p_from_depot);
  v_to   := resolve_depot(p_to_depot);
  if v_from.id = v_to.id then raise exception 'Dépôts source et destination identiques'; end if;
  if nullif(trim(p_to_room), '') is not null then v_room := resolve_room(p_to_room, v_to.id); end if;

  for r in
    select b.lot_id, b.quantity, l.lot_number, l.owner_client_id
      from stock_balances b join lots l on l.id = b.lot_id
     where l.product_id = v_prod.id and b.depot_id = v_from.id and b.quantity > 0
     order by l.expiry_date nulls last, l.created_at
     for update of b
  loop
    exit when v_left <= 0;
    if v_room.id is not null then perform check_room_entry(v_room.id, v_prod.id, r.owner_client_id); end if;
    v_take := least(r.quantity, v_left);
    insert into stock_movements (lot_id, depot_id, storage_unit_id, type, qty, reason, transfer_ref, created_by)
    values (r.lot_id, v_from.id, null,      'transfer_out', -v_take, 'Transfert vers ' || v_to.code, v_ref, auth.uid()),
           (r.lot_id, v_to.id,   v_room.id, 'transfer_in',   v_take, 'Transfert depuis ' || v_from.code, v_ref, auth.uid());
    v_picks := v_picks || jsonb_build_object('lot_number', r.lot_number, 'qty', v_take);
    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then
    raise exception 'Stock insuffisant à % pour % : manque %', v_from.code, v_prod.name, v_left;
  end if;
  return jsonb_build_object('transfer_ref', v_ref, 'product', v_prod.name, 'quantity', p_qty,
                            'from', v_from.code, 'to', v_to.code, 'room', v_room.name, 'picks', v_picks);
end $$;
revoke execute on function public.transfer_stock(text, numeric, text, text, text) from public, anon;
grant execute on function public.transfer_stock(text, numeric, text, text, text) to authenticated;

-- Vues : la chambre vient du solde
create or replace view public.v_stock_lots with (security_invoker = true) as
select
  b.lot_id,
  b.depot_id,
  d.code                                   as depot_code,
  d.name                                   as depot_name,
  p.id                                     as product_id,
  p.sku,
  p.name                                   as product_name,
  p.category,
  p.unit_type,
  l.lot_number,
  l.container_no,
  s.name                                   as supplier,
  l.expiry_date,
  l.created_at::date                       as received_on,
  b.quantity,
  round(b.quantity * coalesce(p.unit_weight_kg, case p.unit_type when 'kg' then 1 when 'tonne' then 1000 else null end), 1) as weight_kg,
  round(b.quantity * coalesce(l.cost_unit_xof, 0))::bigint as value_xof,
  (l.expiry_date - current_date)           as days_to_expiry,
  case
    when l.expiry_date is null                   then 'INCONNU'
    when l.expiry_date <  current_date           then 'EXPIRE'
    when l.expiry_date <= current_date + 15      then 'CRITIQUE'
    when l.expiry_date <= current_date + 45      then 'ATTENTION'
    else 'OK'
  end                                      as fefo_status,
  l.owner_client_id,
  oc.name                                  as owner_client,
  su.code                                  as room_code,
  su.name                                  as room_name,
  l.cost_unit_xof                          as cost_unit_xof,
  l.cost_unit                              as cost_unit,
  l.cost_currency                          as cost_currency
from public.stock_balances b
join public.lots     l on l.id = b.lot_id
join public.products p on p.id = l.product_id
join public.depots   d on d.id = b.depot_id
left join public.suppliers s on s.id = l.supplier_id
left join public.clients  oc on oc.id = l.owner_client_id
left join public.storage_units su on su.id = b.storage_unit_id
where b.quantity > 0;

create or replace view public.v_storage_rooms with (security_invoker = true) as
with stock as (
  select b.storage_unit_id,
         sum(b.quantity * coalesce(p.unit_weight_kg, case p.unit_type when 'kg' then 1 when 'tonne' then 1000 end, 0)) as kg,
         sum(b.quantity) filter (where p.unit_type = 'carton') as cartons,
         sum(round(b.quantity * coalesce(l.cost_unit_xof, 0)))::bigint as value_xof,
         count(distinct l.id) as lots,
         string_agg(distinct p.name, ', ') as products
    from stock_balances b
    join lots l on l.id = b.lot_id
    join products p on p.id = l.product_id
   where b.quantity > 0 and b.storage_unit_id is not null
   group by b.storage_unit_id
)
select
  u.id as room_id, u.code as room_code, u.name as room_name, u.kind, u.temp_min_c, u.temp_max_c,
  u.capacity_tonnes, u.capacity_cartons, u.categories,
  d.id as depot_id, d.code as depot_code, d.name as depot_name,
  round(coalesce(s.kg, 0) / 1000.0, 2)     as used_tonnes,
  coalesce(s.cartons, 0)                    as used_cartons,
  coalesce(s.value_xof, 0)                  as value_xof,
  coalesce(s.lots, 0)                       as lots,
  s.products,
  greatest(
    case when u.capacity_tonnes  > 0 then 100.0 * coalesce(s.kg, 0) / 1000.0 / u.capacity_tonnes end,
    case when u.capacity_cartons > 0 then 100.0 * coalesce(s.cartons, 0) / u.capacity_cartons end
  )::numeric(6,1)                           as fill_pct,
  c.id as contract_id, cl.name as tenant, c.billing, c.price_xof, c.start_date, c.end_date, c.electricity_by_tenant,
  case when c.id is not null then 'louee' when coalesce(s.lots, 0) > 0 then 'ods' else 'libre' end as status
from storage_units u
join depots d on d.id = u.depot_id
left join stock s on s.storage_unit_id = u.id
left join lateral (select * from active_contract(u.id)) c on c.id is not null
left join clients cl on cl.id = c.client_id
where u.active and d.active;
grant select on public.v_storage_rooms, public.v_stock_lots to authenticated;

-- rent_room : une chambre « contient du stock » d'après les soldes
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.rent_room(text, text, text, bigint, date, date, boolean, bigint, text, text)'::regprocedure) into v_src;
  if position('where l.storage_unit_id = v_unit.id and b.quantity > 0' in v_src) > 0 then
    v_src := replace(v_src, 'where l.storage_unit_id = v_unit.id and b.quantity > 0', 'where b.storage_unit_id = v_unit.id and b.quantity > 0');
    execute v_src;
  end if;
end $$;

-- ─── 3. Qualité des données ──────────────────────────────────────────────────
create or replace function public.update_lot_info(
  p_product text, p_lot_number text, p_expiry_date date default null,
  p_cost_unit numeric default null, p_cost_currency public.currency_code default null, p_fx_rate_to_xof numeric default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prod products;
  v_lot  lots;
  v_fx   numeric;
begin
  perform require_role('manager', 'cfo');
  v_prod := resolve_product(p_product);
  select * into v_lot from lots where product_id = v_prod.id and lot_number = trim(p_lot_number) for update;
  if not found then raise exception 'Lot % introuvable pour %', p_lot_number, v_prod.name; end if;
  if p_cost_unit is not null and p_cost_unit < 0 then raise exception 'Coût invalide'; end if;
  v_fx := case coalesce(p_cost_currency, v_lot.cost_currency)
            when 'XOF' then 1 when 'EUR' then 655.957
            else coalesce(p_fx_rate_to_xof, v_lot.fx_rate_to_xof) end;
  if p_cost_currency = 'USD' and p_fx_rate_to_xof is null then raise exception 'Taux de change USD → FCFA requis'; end if;
  update lots set
    expiry_date    = coalesce(p_expiry_date, expiry_date),
    cost_unit      = coalesce(p_cost_unit, cost_unit),
    cost_currency  = coalesce(p_cost_currency, cost_currency),
    fx_rate_to_xof = case when p_cost_unit is not null or p_cost_currency is not null then v_fx else fx_rate_to_xof end
   where id = v_lot.id;
  update tasks set status = 'resolue'
   where status = 'ouverte' and dedupe_key in ('cout:' || v_lot.id, 'dlc:' || v_lot.id)
     and ((dedupe_key like 'cout:%' and p_cost_unit is not null) or (dedupe_key like 'dlc:%' and p_expiry_date is not null));
  return jsonb_build_object('product', v_prod.name, 'lot_number', v_lot.lot_number,
    'expiry_date', coalesce(p_expiry_date, v_lot.expiry_date), 'cost_unit', coalesce(p_cost_unit, v_lot.cost_unit));
end $$;
revoke execute on function public.update_lot_info(text, text, date, numeric, public.currency_code, numeric) from public, anon;
grant execute on function public.update_lot_info(text, text, date, numeric, public.currency_code, numeric) to authenticated;

create or replace function public.engine_scan_data() returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer := 0; v_k integer;
begin
  -- Coût d'achat manquant : valeur du stock et marges faussées
  insert into tasks (kind, severity, title, body, audience, dedupe_key)
  select 'donnees', 'warning', 'Coût manquant : lot ' || l.lot_number || ' (' || p.name || ')',
         'Facture fournisseur non saisie' || coalesce(' — conteneur ' || l.container_no, '') ||
         '. La valeur du stock et la marge des ventes de ce lot sont faussées. Scannez la facture ou complétez le coût dans la fiche du lot.',
         '{manager,cfo,admin}', 'cout:' || l.id
    from lots l join products p on p.id = l.product_id
   where l.cost_unit is null and l.owner_client_id is null
     and exists (select 1 from stock_balances b where b.lot_id = l.id and b.quantity > 0)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- Date limite manquante : le FEFO ne peut pas protéger ce lot
  insert into tasks (kind, severity, title, body, audience, dedupe_key)
  select 'donnees', 'info', 'Date limite à saisir : lot ' || l.lot_number || ' (' || p.name || ')',
         'Sans date limite, DEPOTEK ne peut pas prévenir avant péremption. Relevez la DLC sur un carton et complétez la fiche du lot.',
         '{magasinier,manager,cfo,admin}', 'dlc:' || l.id
    from lots l join products p on p.id = l.product_id
   where l.expiry_date is null and l.owner_client_id is null
     and exists (select 1 from stock_balances b where b.lot_id = l.id and b.quantity > 0)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- Stock rangé nulle part
  insert into tasks (kind, severity, title, body, audience, dedupe_key)
  select 'donnees', 'info', 'Lot sans chambre : ' || l.lot_number || ' (' || p.name || ')',
         qty_txt || ' en stock à ' || d.name || ' sans chambre froide affectée. Rangez-le (Opérations › Changer de chambre) pour suivre le remplissage.',
         '{magasinier,manager,admin}', 'sanschambre:' || b.lot_id || ':' || b.depot_id
    from (select b.*, trim(to_char(b.quantity, 'FM999G999G990')) || ' carton(s)' as qty_txt from stock_balances b) b
    join lots l on l.id = b.lot_id join products p on p.id = l.product_id join depots d on d.id = b.depot_id
   where b.quantity > 0 and b.storage_unit_id is null
     and exists (select 1 from storage_units su where su.depot_id = b.depot_id and su.active)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- Résolution automatique quand l'information est complétée
  update tasks t set status = 'resolue'
   where t.status = 'ouverte' and t.kind = 'donnees' and (
     (t.dedupe_key like 'cout:%' and exists (select 1 from lots l where 'cout:' || l.id = t.dedupe_key and l.cost_unit is not null))
  or (t.dedupe_key like 'dlc:%'  and exists (select 1 from lots l where 'dlc:'  || l.id = t.dedupe_key and l.expiry_date is not null))
  or (t.dedupe_key like 'sanschambre:%' and not exists (
        select 1 from stock_balances b where 'sanschambre:' || b.lot_id || ':' || b.depot_id = t.dedupe_key
           and b.quantity > 0 and b.storage_unit_id is null)));
  return v_n;
end $$;
revoke execute on function public.engine_scan_data() from public, anon, authenticated;
grant execute on function public.engine_scan_data() to service_role;

do $$
declare v_src text;
begin
  select pg_get_functiondef('public.engine_scan()'::regprocedure) into v_src;
  if position('engine_scan_data' in v_src) = 0 then
    v_src := replace(v_src, E'  return v_n;\nend', E'  v_n := v_n + engine_scan_data();\n  return v_n;\nend');
    execute v_src;
  end if;
end $$;

-- ─── 4. Démo : 5 conteneurs d'import (anonymisés) + chambres adaptées ───────
create or replace function public.demo_seed() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_alm uuid; v_sod uuid;
begin
  perform require_role('admin');
  if exists (select 1 from depots where demo) or exists (select 1 from products where demo) then perform demo_purge(); end if;
  insert into app_settings (key, value) values ('demo_started_at', now()::text)
  on conflict (key) do update set value = excluded.value;

  insert into depots (code, name, type, address, demo) values ('ALM-DEMO', 'Almadies (démo)', 'frozen', 'Almadies, Dakar', true)
    returning id into v_alm;
  insert into depots (code, name, type, address, demo) values ('SOD-DEMO', 'Sodida (démo)', 'frozen', 'Sodida, Dakar', true)
    returning id into v_sod;
  insert into storage_units (depot_id, code, name, kind, temp_min_c, temp_max_c, capacity_tonnes, capacity_cartons, categories) values
    (v_alm, 'CF1', 'Grand frigo viande',  'frozen', -25, -18, 40,  null, '{viande,abats}'),
    (v_alm, 'CF2', 'Frigo volaille',      'frozen', -22, -18, 20,  null, '{volaille}'),
    (v_alm, 'PF',  'Petit frigo fromages','chilled',  2,   6, null, 300, '{fromage}'),
    (v_alm, 'CB1', 'Chambre buffle 1',    'frozen', -25, -18, 70,  null, '{viande}'),
    (v_alm, 'CB2', 'Chambre buffle 2',    'frozen', -25, -18, 70,  null, '{viande}'),
    (v_alm, 'CP',  'Chambre poisson',     'frozen', -25, -20, 35,  null, '{poisson}'),
    (v_sod, 'S1',  'Chambre poisson',     'frozen', -25, -18, 30,  null, '{poisson}'),
    (v_sod, 'S2',  'Chambre 2',           'frozen', -25, -18, 25,  null, '{}'),
    (v_sod, 'S3',  'Chambre 3',           'frozen', -25, -18, 20,  null, '{}');

  insert into suppliers (name, country, demo) values
    ('Fournisseur Inde (démo)', 'Inde', true), ('Fournisseur Brésil (démo)', 'Brésil', true),
    ('Fournisseur Mauritanie (démo)', 'Mauritanie', true), ('Fournisseur France (démo)', 'France', true),
    ('Fournisseur Égypte (démo)', 'Égypte', true)
  on conflict (name) do update set demo = true;

  insert into products (sku, name, category, unit_type, unit_weight_kg, default_price_xof, min_stock, lead_time_days, demo) values
    ('DEMO-FOIE',         'Foie de bœuf 20 kg',          'abats',    'carton', 20,  26000, 150, 45, true),
    ('DEMO-HACHE',        'Viande hachée 10 kg',         'viande',   'carton', 10,  22000, 100, 45, true),
    ('DEMO-CUISSE',       'Cuisse de poulet 10 kg',      'volaille', 'carton', 10,  15000, 300, 40, true),
    ('DEMO-THIOF',        'Filet de thiof 5 kg',         'poisson',  'carton', 5,   21000,  60, 10, true),
    ('DEMO-EMMENTAL',     'Emmental 2,5 kg',             'fromage',  'carton', 2.5,  9500, 200, 30, true),
    ('DEMO-BUF-HQ',       'Buffle HQ 20 kg',             'viande',   'carton', 20,  64000, 400, 60, true),
    ('DEMO-BUF-FQ-FILET', 'Buffle FQ + filet 20 kg',     'viande',   'carton', 20,  59000, 400, 60, true),
    ('DEMO-BUF-FQ',       'Buffle FQ 20 kg',             'viande',   'carton', 20,  57000, 400, 60, true),
    ('DEMO-BUF-HALAL',    'Buffle désossé halal 20 kg',  'viande',   'carton', 20,  60000, 300, 45, true),
    ('DEMO-TILAPIA',      'Tilapia entier 10 kg',        'poisson',  'carton', 10,   9000, 800, 60, true);

  insert into clients (name, phone, type, credit_limit_xof, payment_terms_days, demo) values
    ('Moussa Traders (démo)',            '+221770000001', 'grossiste',   40000000, 30, true),
    ('Restaurant Le Lagon (démo)',       '+221770000002', 'restaurant',   3000000, 15, true),
    ('Boucherie Ndiaye (démo)',          '+221770000003', 'detaillant',   5000000,  7, true),
    ('Supermarché Bayal (démo)',         '+221770000004', 'supermarche', 20000000, 30, true),
    ('Poissonnerie Soumbédioune (démo)', '+221770000005', 'locataire_froid',     0,  0, true),
    ('Glacier Fass (démo)',              '+221770000006', 'locataire_froid',     0,  0, true);

  -- Les 5 conteneurs d'import (coûts en EUR, taux fixe 655,957 ; un lot sans facture)
  perform receive_lot('DEMO-BUF-HQ',       1400, 'BHQ-0049', 'ALM-DEMO', null, null, 89,      'EUR', 655.957, 'Fournisseur Inde (démo)',   'SEGU9482221', null, 'CB1');
  perform receive_lot('DEMO-BUF-FQ-FILET', 1412, 'BFF-0103', 'ALM-DEMO', null, null, 81.4476, 'EUR', 655.957, 'Fournisseur Inde (démo)',   'TEMU9415214', null, 'CB1');
  perform receive_lot('DEMO-BUF-FQ',       1425, 'BFQ-0141', 'ALM-DEMO', null, null, 79,      'EUR', 655.957, 'Fournisseur Inde (démo)',   'UACU4772843', null, 'CB2');
  perform receive_lot('DEMO-BUF-HALAL',    1395, 'BHL-EG01', 'ALM-DEMO', null, null, null,    'XOF', null,    'Fournisseur Égypte (démo)', 'CGMU5674030', null, 'CB2');
  perform receive_lot('DEMO-TILAPIA',      2700, 'TIL-0113', 'ALM-DEMO', date '2028-02-29', null, 11.6667, 'EUR', 655.957, 'Fournisseur Inde (démo)', 'GESU9581446', null, 'CP');

  -- Petits stocks complémentaires
  perform receive_lot('DEMO-FOIE',  1000, 'FB-0921', 'ALM-DEMO', current_date + 210, null, 32, 'USD', 600, 'Fournisseur Inde (démo)', 'MSKU4417201', null, 'CF1');
  perform receive_lot('DEMO-HACHE', 1400, 'VH-1003', 'ALM-DEMO', current_date + 160, null, 16500, 'XOF', null, 'Fournisseur Inde (démo)', 'MSKU4417201', null, 'CF1');
  perform receive_lot('DEMO-CUISSE', 250, 'CP-0815', 'ALM-DEMO', current_date + 10,  null, 11000, 'XOF', null, 'Fournisseur Brésil (démo)', 'HLXU9902113', null, 'CF2');
  perform receive_lot('DEMO-CUISSE', 450, 'CP-1002', 'ALM-DEMO', current_date + 190, null, 11200, 'XOF', null, 'Fournisseur Brésil (démo)', 'HLXU9902113', null, 'CF2');
  perform receive_lot('DEMO-THIOF',   45, 'TH-1101', 'SOD-DEMO', current_date + 6,   null, 15000, 'XOF', null, 'Fournisseur Mauritanie (démo)', null, null, 'S1');
  perform receive_lot('DEMO-THIOF',  220, 'TH-1109', 'SOD-DEMO', current_date + 120, null, 15500, 'XOF', null, 'Fournisseur Mauritanie (démo)', null, null, 'S1');
  perform receive_lot('DEMO-EMMENTAL',120,'EM-1020', 'ALM-DEMO', current_date + 75,  null, 6800, 'XOF', null, 'Fournisseur France (démo)', null, null, 'PF');

  -- Transfert : une partie du tilapia part à Sodida, chambre poisson
  perform transfer_stock('DEMO-TILAPIA', 600, 'ALM-DEMO', 'SOD-DEMO', 'S1');

  -- Ventes (FEFO + factures), paiements
  perform dispatch_fefo('DEMO-BUF-HQ',    300, 'Moussa Traders (démo)',      'ALM-DEMO', 64000, null, true, false, null);
  perform dispatch_fefo('DEMO-BUF-FQ',    150, 'Supermarché Bayal (démo)',   'ALM-DEMO', 57000, null, true, false, null);
  perform dispatch_fefo('DEMO-BUF-HALAL', 100, 'Supermarché Bayal (démo)',   'ALM-DEMO', 60000, null, true, false, null);
  perform dispatch_fefo('DEMO-TILAPIA',   150, 'Restaurant Le Lagon (démo)', 'SOD-DEMO',  9000, null, true, false, null);
  perform dispatch_fefo('DEMO-HACHE',     120, 'Boucherie Ndiaye (démo)',    'ALM-DEMO', 22000, null, true, false, null);
  perform dispatch_fefo('DEMO-THIOF',      40, 'Restaurant Le Lagon (démo)', 'SOD-DEMO', 21000, null, true, false, null);
  perform dispatch_fefo('DEMO-FOIE',      150, 'Moussa Traders (démo)',      'ALM-DEMO', 26000, null, true, false, null);
  perform dispatch_fefo('DEMO-EMMENTAL',   30, 'Supermarché Bayal (démo)',   'ALM-DEMO',  9500, null, true, false, null);
  perform record_client_payment('Moussa Traders (démo)',    10000000, 'wave',     'WAVE-DEMO-01');
  perform record_client_payment('Supermarché Bayal (démo)',  8550000, 'virement', 'VIR-DEMO-02');

  -- Location d'une chambre entière, en fin de contrat
  perform rent_room('Glacier Fass (démo)', 'S3', 'mensuel', 350000, current_date - 25, current_date + 5, true, 350000, 'SOD-DEMO', null);

  -- Chronologie : conteneurs arrivés il y a 2 semaines, le reste hier
  update stock_movements set created_at = created_at - interval '1 day' where depot_id in (v_alm, v_sod);
  update stock_movements m set created_at = created_at - interval '13 days'
   where m.type = 'entry' and m.lot_id in (select id from lots where lot_number in ('BHQ-0049','BFF-0103','BFQ-0141','BHL-EG01','TIL-0113'));
  update lots set created_at = created_at - interval '1 day' where product_id in (select id from products where demo);
  update lots set created_at = created_at - interval '13 days' where lot_number in ('BHQ-0049','BFF-0103','BFQ-0141','BHL-EG01','TIL-0113');
  update invoices set created_at = created_at - interval '1 day', issue_date = issue_date - 1, due_date = due_date - 1
   where client_id in (select id from clients where demo);
  update invoices set issue_date = current_date - 19, due_date = current_date - 12
   where client_id = (select id from clients where name = 'Boucherie Ndiaye (démo)');
  update invoices set issue_date = current_date - 18, due_date = current_date - 3
   where client_id = (select id from clients where name = 'Restaurant Le Lagon (démo)');
  update payments set created_at = created_at - interval '1 day', paid_at = paid_at - interval '1 day'
   where invoice_id in (select id from invoices where client_id in (select id from clients where demo));
  update storage_contracts set created_at = created_at - interval '1 day'
   where client_id in (select id from clients where demo);

  begin perform engine_scan(); exception when others then null; end;
  return jsonb_build_object('installed', true);
end $$;

-- La purge enlève aussi les produits et fournisseurs démo sans entrepôt démo
create or replace function public.demo_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('installed', exists (select 1 from depots where demo) or exists (select 1 from products where demo));
$$;
