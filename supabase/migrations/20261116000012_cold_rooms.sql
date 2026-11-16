-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Entrepôts, chambres froides et location de chambres entières
--
--   • Un entrepôt (Almadies, Sodida…) contient plusieurs chambres froides.
--   • Capacité d'une chambre en tonnes et/ou en cartons (jamais en palettes).
--   • Une chambre peut être réservée à des familles de produits (viande, poisson,
--     fromage…) : une réception incompatible est refusée (hygiène).
--   • Chaque lot est rangé dans une chambre ; on peut le déplacer.
--   • Location : on loue une chambre ENTIÈRE à un client, au mois ou au forfait
--     sur une période. L'électricité est à la charge du locataire (par défaut).
--     Une chambre louée n'accepte que la marchandise du locataire.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── Chambres froides ────────────────────────────────────────────────────────

alter table public.storage_units
  add column capacity_tonnes  numeric(10,2) check (capacity_tonnes is null or capacity_tonnes > 0),
  add column capacity_cartons integer       check (capacity_cartons is null or capacity_cartons > 0),
  add column categories       text[] not null default '{}',   -- vide = tous produits
  add column notes            text;
alter table public.storage_units drop column if exists capacity_pallets;

-- Emplacement courant de chaque lot
alter table public.lots add column storage_unit_id uuid references public.storage_units(id);
create index lots_unit_idx on public.lots (storage_unit_id);

-- ─── Location de chambres entières ───────────────────────────────────────────

alter table public.storage_contracts
  alter column rate_pallet_day_xof drop not null,
  alter column rate_pallet_day_xof set default null,
  add column billing           text not null default 'mensuel' check (billing in ('mensuel', 'forfait')),
  add column price_xof         bigint check (price_xof is null or price_xof >= 0),  -- loyer mensuel ou forfait total
  add column electricity_by_tenant boolean not null default true,
  add column deposit_xof       bigint not null default 0,
  add column notes             text;

create or replace function public.active_contract(p_unit uuid, p_day date default current_date)
returns public.storage_contracts language sql stable security definer set search_path = public as $$
  select * from storage_contracts
   where storage_unit_id = p_unit and active and start_date <= p_day and (end_date is null or end_date >= p_day)
   order by start_date desc limit 1
$$;

-- ─── Vue d'occupation des chambres ───────────────────────────────────────────

create or replace view public.v_storage_rooms with (security_invoker = true) as
with stock as (
  select l.storage_unit_id,
         sum(b.quantity * coalesce(p.unit_weight_kg, case p.unit_type when 'kg' then 1 when 'tonne' then 1000 end, 0)) as kg,
         sum(b.quantity) filter (where p.unit_type = 'carton') as cartons,
         sum(round(b.quantity * coalesce(l.cost_unit_xof, 0)))::bigint as value_xof,
         count(distinct l.id) as lots,
         string_agg(distinct p.name, ', ') as products
    from stock_balances b
    join lots l on l.id = b.lot_id
    join products p on p.id = l.product_id
   where b.quantity > 0 and l.storage_unit_id is not null
   group by l.storage_unit_id
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

-- ─── Résolution d'une chambre ────────────────────────────────────────────────

create or replace function public.resolve_room(p text, p_depot uuid default null) returns public.storage_units
language plpgsql stable security definer set search_path = public as $$
declare
  r public.storage_units;
  n integer;
begin
  select count(*) into n from storage_units
   where active and (p_depot is null or depot_id = p_depot) and (lower(code) = lower(trim(p)) or lower(name) = lower(trim(p)));
  if n = 1 then
    select * into r from storage_units
     where active and (p_depot is null or depot_id = p_depot) and (lower(code) = lower(trim(p)) or lower(name) = lower(trim(p)));
    return r;
  elsif n = 0 then
    raise exception 'Chambre introuvable : "%"', p using errcode = 'P0002';
  end if;
  raise exception 'Chambre ambiguë : "%" existe dans plusieurs entrepôts, précisez l''entrepôt', p using errcode = 'P0003';
end $$;

-- Contrôle d'entrée dans une chambre : famille de produit et location
create or replace function public.check_room_entry(p_unit uuid, p_product uuid, p_owner uuid) returns void
language plpgsql stable security definer set search_path = public as $$
declare
  u   storage_units;
  cat text;
  c   storage_contracts;
begin
  select * into u from storage_units where id = p_unit;
  select category into cat from products where id = p_product;
  if cardinality(u.categories) > 0 and not (cat = any(u.categories)) then
    raise exception 'Chambre % réservée à : % (produit de catégorie « % »)', u.name, array_to_string(u.categories, ', '), cat;
  end if;
  c := active_contract(p_unit);
  if c.id is not null and p_owner is distinct from c.client_id then
    raise exception 'Chambre % louée à %, elle n''accepte que sa marchandise', u.name, (select name from clients where id = c.client_id);
  end if;
end $$;

-- ─── Réception : rangement dans une chambre ──────────────────────────────────

create or replace function public.receive_lot(
  p_product text, p_qty numeric, p_lot_number text, p_depot text default null,
  p_expiry_date date default null, p_production_date date default null,
  p_cost_unit numeric default null, p_cost_currency public.currency_code default 'XOF',
  p_fx_rate_to_xof numeric default null, p_supplier text default null,
  p_container_no text default null, p_invoice_ref text default null,
  p_storage_unit text default null, p_owner_client text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prod   products;
  v_depot  depots;
  v_unit   storage_units;
  v_supp   uuid;
  v_owner  uuid;
  v_lot    uuid;
  v_fx     numeric;
begin
  perform require_role('magasinier', 'manager');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantité invalide'; end if;
  if p_expiry_date is not null and p_expiry_date < current_date then
    raise exception 'Lot déjà expiré (%) : réception refusée', p_expiry_date;
  end if;

  v_prod := resolve_product(p_product);
  if p_storage_unit is not null and nullif(trim(p_storage_unit), '') is not null then
    v_unit := resolve_room(p_storage_unit, case when p_depot is not null then (resolve_depot(p_depot)).id end);
    select * into v_depot from depots where id = v_unit.depot_id;
  else
    v_depot := resolve_depot(p_depot);
  end if;
  v_fx := coalesce(p_fx_rate_to_xof, case p_cost_currency when 'XOF' then 1 when 'EUR' then 655.957 end);
  if v_fx is null then raise exception 'Taux de change USD→XOF requis (p_fx_rate_to_xof)'; end if;

  if p_supplier is not null then
    insert into suppliers (name) values (trim(p_supplier)) on conflict (name) do nothing;
    select id into v_supp from suppliers where name = trim(p_supplier);
  end if;
  if p_owner_client is not null and nullif(trim(p_owner_client), '') is not null then
    v_owner := (resolve_client(p_owner_client)).id;
  end if;
  if v_unit.id is not null then perform check_room_entry(v_unit.id, v_prod.id, v_owner); end if;

  select id into v_lot from lots where product_id = v_prod.id and lot_number = trim(p_lot_number) for update;
  if v_lot is null then
    insert into lots (product_id, lot_number, supplier_id, container_no, invoice_ref, production_date,
                      expiry_date, original_qty, cost_unit, cost_currency, fx_rate_to_xof, owner_client_id,
                      storage_unit_id, created_by)
    values (v_prod.id, trim(p_lot_number), v_supp, p_container_no, p_invoice_ref, p_production_date,
            p_expiry_date, p_qty, p_cost_unit, p_cost_currency, v_fx, v_owner, v_unit.id, auth.uid())
    returning id into v_lot;
  else
    update lots set original_qty = original_qty + p_qty, storage_unit_id = coalesce(v_unit.id, storage_unit_id) where id = v_lot;
  end if;

  insert into stock_movements (lot_id, depot_id, storage_unit_id, type, qty, reason, created_by)
  values (v_lot, v_depot.id, v_unit.id, 'entry', p_qty,
          coalesce('Réception ' || p_container_no, 'Réception'), auth.uid());

  return jsonb_build_object(
    'lot_id', v_lot, 'product', v_prod.name, 'sku', v_prod.sku, 'lot_number', trim(p_lot_number),
    'depot', v_depot.code, 'room', v_unit.name, 'quantity', p_qty, 'expiry_date', p_expiry_date);
end $$;

-- ─── Déplacer un lot vers une autre chambre du même entrepôt ─────────────────

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
  select * into v_bal from stock_balances where lot_id = v_lot.id and depot_id = v_unit.depot_id and quantity > 0;
  if not found then raise exception 'Le lot % n''est pas en stock dans cet entrepôt : faites d''abord un transfert', v_lot.lot_number; end if;
  perform check_room_entry(v_unit.id, v_prod.id, v_lot.owner_client_id);
  update lots set storage_unit_id = v_unit.id where id = v_lot.id;
  return jsonb_build_object('product', v_prod.name, 'lot_number', v_lot.lot_number, 'room', v_unit.name);
end $$;

-- ─── Louer une chambre entière ───────────────────────────────────────────────

create or replace function public.rent_room(
  p_client text, p_room text, p_billing text, p_price_xof bigint,
  p_start date default current_date, p_end date default null,
  p_electricity_by_tenant boolean default true, p_deposit_xof bigint default 0,
  p_depot text default null, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_client clients;
  v_unit   storage_units;
  v_id     uuid;
  v_ods    integer;
begin
  perform require_role('manager', 'cfo');
  if p_billing not in ('mensuel', 'forfait') then raise exception 'Facturation : mensuel ou forfait'; end if;
  if p_price_xof is null or p_price_xof <= 0 then raise exception 'Prix requis'; end if;
  if p_billing = 'forfait' and p_end is null then raise exception 'Une location au forfait doit avoir une date de fin'; end if;
  if p_end is not null and p_end < p_start then raise exception 'Date de fin avant la date de début'; end if;
  v_client := resolve_client(p_client);
  v_unit := resolve_room(p_room, case when p_depot is not null then (resolve_depot(p_depot)).id end);

  if exists (select 1 from storage_contracts c where c.storage_unit_id = v_unit.id and c.active
              and c.start_date <= coalesce(p_end, 'infinity'::date) and coalesce(c.end_date, 'infinity'::date) >= p_start) then
    raise exception 'La chambre % est déjà louée sur cette période', v_unit.name;
  end if;
  select count(*) into v_ods from lots l join stock_balances b on b.lot_id = l.id
   where l.storage_unit_id = v_unit.id and b.quantity > 0 and l.owner_client_id is distinct from v_client.id;
  if v_ods > 0 then
    raise exception 'La chambre % contient encore % lot(s) : videz-la ou déplacez les lots avant de la louer', v_unit.name, v_ods;
  end if;

  insert into storage_contracts (client_id, depot_id, storage_unit_id, billing, price_xof, start_date, end_date,
                                 electricity_by_tenant, deposit_xof, notes)
  values (v_client.id, v_unit.depot_id, v_unit.id, p_billing, p_price_xof, p_start, p_end,
          p_electricity_by_tenant, coalesce(p_deposit_xof, 0), p_notes)
  returning id into v_id;

  -- Première facture tout de suite (loyer du mois en cours au prorata, ou forfait)
  return jsonb_build_object('contract_id', v_id, 'client', v_client.name, 'room', v_unit.name,
                            'billing', p_billing, 'price_xof', p_price_xof,
                            'invoices', bill_storage(greatest(p_start, current_date)) -> 'invoices');
end $$;

create or replace function public.end_rental(p_contract uuid, p_end date default current_date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c storage_contracts;
begin
  perform require_role('manager', 'cfo');
  update storage_contracts set end_date = p_end, active = (p_end >= current_date)
   where id = p_contract returning * into c;
  if not found then raise exception 'Contrat introuvable'; end if;
  return jsonb_build_object('contract_id', c.id, 'end_date', c.end_date);
end $$;

-- ─── Facturation des locations ───────────────────────────────────────────────
-- Mensuel : loyer facturé d'avance pour le mois, au prorata des jours loués le
-- premier et le dernier mois. Forfait : facturé une seule fois, au démarrage.
-- Idempotent (une facture par contrat et par mois).

create or replace function public.bill_storage(p_month date default current_date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_start  date := date_trunc('month', p_month)::date;
  v_end    date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_from   date;
  v_to     date;
  v_amount bigint;
  v_inv    uuid;
  v_number text;
  v_label  text;
  v_out    jsonb := '[]'::jsonb;
  c        record;
begin
  perform require_role('manager', 'cfo');
  for c in
    select sc.*, cl.name as client_name, cl.payment_terms_days, u.name as room_name, d.name as depot_name
      from storage_contracts sc
      join clients cl on cl.id = sc.client_id
      left join storage_units u on u.id = sc.storage_unit_id
      join depots d on d.id = sc.depot_id
     where sc.active and sc.price_xof is not null
       and sc.start_date <= v_end and (sc.end_date is null or sc.end_date >= v_start)
  loop
    if c.billing = 'forfait' then
      continue when exists (select 1 from storage_billing_runs b where b.contract_id = c.id);
      v_amount := c.price_xof;
      v_label := 'Location chambre ' || coalesce(c.room_name, '') || ' (' || c.depot_name || ') du ' ||
                 to_char(c.start_date, 'DD/MM/YYYY') || ' au ' || to_char(c.end_date, 'DD/MM/YYYY') || ' — forfait';
      v_from := c.start_date;
    else
      continue when exists (select 1 from storage_billing_runs b where b.contract_id = c.id and b.period_start = v_start);
      v_from := greatest(v_start, c.start_date);
      v_to   := least(v_end, coalesce(c.end_date, v_end));
      v_amount := round(c.price_xof * ((v_to - v_from + 1)::numeric / (v_end - v_start + 1)));
      v_label := 'Location chambre ' || coalesce(c.room_name, '') || ' (' || c.depot_name || ') — ' ||
                 to_char(v_start, 'MM/YYYY') ||
                 case when v_from > v_start or v_to < v_end
                      then ' (' || (v_to - v_from + 1) || ' j sur ' || (v_end - v_start + 1) || ')' else '' end;
    end if;
    if c.electricity_by_tenant then v_label := v_label || '. Électricité à la charge du locataire.'; end if;
    continue when v_amount <= 0;

    v_number := next_invoice_number('stockage');
    insert into invoices (number, kind, client_id, issue_date, due_date, status, total_xof, period_start, period_end, created_by)
    values (v_number, 'stockage', c.client_id, current_date, current_date + c.payment_terms_days, 'emise',
            v_amount, v_from, coalesce(v_to, c.end_date), auth.uid())
    returning id into v_inv;
    insert into invoice_lines (invoice_id, description, qty, unit_price_xof) values (v_inv, v_label, 1, v_amount);
    insert into storage_billing_runs (contract_id, period_start, invoice_id)
    values (c.id, case when c.billing = 'forfait' then c.start_date else v_start end, v_inv);
    v_out := v_out || jsonb_build_object('client', c.client_name, 'room', c.room_name,
                                         'invoice_number', v_number, 'total_xof', v_amount);
  end loop;
  return jsonb_build_object('period', to_char(v_start, 'MM/YYYY'), 'invoices', v_out);
end $$;

-- ─── Moteur : règles chambres ────────────────────────────────────────────────

create or replace function public.engine_scan_rooms() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_n integer := 0;
  v_k integer;
begin
  -- Chambre pleine à plus de 90 %
  insert into tasks (kind, severity, title, body, audience, dedupe_key)
  select 'chambre', case when fill_pct >= 100 then 'critical' else 'warning' end::alert_level,
         'Chambre presque pleine : ' || room_name || ' (' || depot_name || ')',
         'Remplissage ' || fill_pct || ' %' ||
           case when capacity_tonnes is not null then ' — ' || used_tonnes || ' t / ' || capacity_tonnes || ' t' else '' end ||
           case when capacity_cartons is not null then ' — ' || used_cartons || ' / ' || capacity_cartons || ' cartons' else '' end ||
           '. Prévoyez une autre chambre pour les prochaines réceptions.',
         '{magasinier,manager,cfo,admin}', 'chambre:' || room_id || ':' || to_char(current_date, 'IYYY-IW')
    from v_storage_rooms where fill_pct >= 90 and status <> 'louee'
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- Fin de location dans 7 jours ou moins
  insert into tasks (kind, severity, title, body, dedupe_key)
  select 'location', 'warning', 'Fin de location : ' || cl.name || ' — chambre ' || u.name,
         'Le contrat se termine le ' || to_char(c.end_date, 'DD/MM/YYYY') ||
           '. Renouveler avec le client, ou prévoir la libération de la chambre.',
         'location:' || c.id || ':' || c.end_date
    from storage_contracts c join clients cl on cl.id = c.client_id join storage_units u on u.id = c.storage_unit_id
   where c.active and c.end_date between current_date and current_date + 7
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- Contrats échus : désactivés
  update storage_contracts set active = false where active and end_date < current_date;
  return v_n;
end $$;

-- engine_scan() appelle désormais aussi les règles chambres
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.engine_scan()'::regprocedure) into v_src;
  if position('engine_scan_rooms' in v_src) = 0 then
    v_src := replace(v_src, E'  return v_n;\nend', E'  v_n := v_n + engine_scan_rooms();\n  return v_n;\nend');
    execute v_src;
  end if;
end $$;

-- ─── Briefing : chambres louées et remplissage ─────────────────────────────

create or replace function public.daily_briefing(p_date date default current_date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_yday date := p_date - 1;
begin
  perform require_role('manager', 'cfo');
  return jsonb_build_object(
    'date', p_date,
    'stock_value_xof', (select coalesce(sum(value_xof), 0) from v_stock_lots where owner_client_id is null),
    'stock_by_product', coalesce((select jsonb_agg(jsonb_build_object(
        'product', product_name, 'quantity', quantity, 'unit', unit_type, 'value_xof', value_xof,
        'days_of_cover', days_of_cover) order by value_xof desc)
        from v_stock_products where quantity > 0), '[]'::jsonb),
    'yesterday', sales_summary(v_yday, v_yday),
    'receivables_xof', (select coalesce(sum(balance_xof), 0) from v_client_balances),
    'overdue_xof',     (select coalesce(sum(overdue_xof), 0) from v_client_balances),
    'top_debtors', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('client', client_name, 'balance_xof', balance_xof, 'overdue_xof', overdue_xof,
                                  'max_days_overdue', max_days_overdue, 'phone', phone) as x
          from v_client_balances where balance_xof > 0 order by overdue_xof desc, balance_xof desc limit 5) t), '[]'::jsonb),
    'fefo', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('product', product_name, 'lot', lot_number, 'quantity', quantity,
                                  'days_to_expiry', days_to_expiry, 'status', fefo_status, 'value_xof', value_xof) as x
          from v_stock_lots where fefo_status in ('EXPIRE', 'CRITIQUE', 'ATTENTION') and owner_client_id is null
          order by expiry_date limit 10) t), '[]'::jsonb),
    'reorder', coalesce((select jsonb_agg(jsonb_build_object('product', product_name, 'quantity', quantity,
                                  'days_of_cover', days_of_cover, 'lead_time_days', lead_time_days))
          from v_stock_products where needs_reorder), '[]'::jsonb),
    'rented_rooms', coalesce((select jsonb_agg(jsonb_build_object('client', tenant, 'room', room_name, 'depot', depot_name,
                                  'end_date', end_date, 'price_xof', price_xof, 'billing', billing))
          from v_storage_rooms where status = 'louee'), '[]'::jsonb),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('room', room_name, 'depot', depot_code, 'fill_pct', fill_pct, 'status', status)
                                  order by depot_code, room_code)
          from v_storage_rooms), '[]'::jsonb),
    'unread_alerts', (select count(*) from alerts where read_at is null)
  );
end $$;

-- ─── Droits ──────────────────────────────────────────────────────────────────

grant select on public.v_storage_rooms to authenticated;
-- active_contract est lue par la vue (RLS des contrats : lecture ouverte aux utilisateurs connectés)
revoke execute on function public.active_contract(uuid, date) from public, anon;
grant execute on function public.active_contract(uuid, date) to authenticated;
revoke execute on function public.resolve_room(text, uuid),
  public.check_room_entry(uuid, uuid, uuid), public.engine_scan_rooms() from public, anon, authenticated;
grant execute on function public.engine_scan_rooms() to service_role;
grant execute on function public.move_lot(text, text, text, text),
  public.rent_room(text, text, text, bigint, date, date, boolean, bigint, text, text),
  public.end_rental(uuid, date) to authenticated;
revoke execute on function public.move_lot(text, text, text, text),
  public.rent_room(text, text, text, bigint, date, date, boolean, bigint, text, text),
  public.end_rental(uuid, date) from anon, public;
