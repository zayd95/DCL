-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Logique métier : rôles, résolveurs, opérations atomiques, vues
-- Toutes les fonctions d'écriture sont SECURITY DEFINER et vérifient le rôle.
-- Les identifiants sont tolérants (SKU ou nom de produit, code ou nom de dépôt,
-- nom de client) pour pouvoir être appelés tels quels par l'assistant IA.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── Rôles ───────────────────────────────────────────────────────────────────

create or replace function public.app_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- Lève une exception si l'appelant n'a pas l'un des rôles demandés.
-- Les appels serveur (service_role, cron, console SQL) passent toujours.
create or replace function public.require_role(variadic p_roles public.user_role[])
returns void language plpgsql stable security definer set search_path = public as $$
declare
  v_role public.user_role;
begin
  if auth.uid() is null and (coalesce(auth.role(), '') = 'service_role' or session_user = 'postgres') then
    return;
  end if;
  v_role := public.app_role();
  if v_role is null then
    raise exception 'Utilisateur non identifié' using errcode = '42501';
  end if;
  if v_role = 'admin' or v_role = any(p_roles) then
    return;
  end if;
  raise exception 'Action réservée à : %', array_to_string(p_roles, ', ') using errcode = '42501';
end $$;

-- ─── Résolveurs (texte → id) ─────────────────────────────────────────────────

create or replace function public.resolve_product(p text) returns public.products
language plpgsql stable security definer set search_path = public as $$
declare
  r public.products;
  n integer;
begin
  select * into r from products where lower(sku) = lower(trim(p)) and active;
  if found then return r; end if;
  select count(*) into n from products where active and name ilike '%' || trim(p) || '%';
  if n = 1 then
    select * into r from products where active and name ilike '%' || trim(p) || '%';
    return r;
  elsif n = 0 then
    raise exception 'Produit introuvable : "%"', p using errcode = 'P0002';
  else
    raise exception 'Produit ambigu : "%" correspond à % produits (%). Précisez le SKU.', p, n,
      (select string_agg(sku || ' ' || name, ', ') from products where active and name ilike '%' || trim(p) || '%')
      using errcode = 'P0003';
  end if;
end $$;

create or replace function public.resolve_depot(p text) returns public.depots
language plpgsql stable security definer set search_path = public as $$
declare
  r public.depots;
  n integer;
begin
  if p is null or trim(p) = '' then
    select count(*) into n from depots where active;
    if n = 1 then select * into r from depots where active; return r; end if;
    raise exception 'Plusieurs dépôts actifs : précisez lequel (%).',
      (select string_agg(code, ', ') from depots where active) using errcode = 'P0003';
  end if;
  select * into r from depots where active and (lower(code) = lower(trim(p)) or lower(name) = lower(trim(p)));
  if found then return r; end if;
  select count(*) into n from depots where active and name ilike '%' || trim(p) || '%';
  if n = 1 then
    select * into r from depots where active and name ilike '%' || trim(p) || '%';
    return r;
  end if;
  raise exception 'Dépôt introuvable : "%"', p using errcode = 'P0002';
end $$;

create or replace function public.resolve_client(p text) returns public.clients
language plpgsql stable security definer set search_path = public as $$
declare
  r public.clients;
  n integer;
begin
  select * into r from clients where active and lower(name) = lower(trim(p));
  if found then return r; end if;
  select count(*) into n from clients where active and name ilike '%' || trim(p) || '%';
  if n = 1 then
    select * into r from clients where active and name ilike '%' || trim(p) || '%';
    return r;
  elsif n = 0 then
    raise exception 'Client introuvable : "%". Créez-le d''abord.', p using errcode = 'P0002';
  end if;
  raise exception 'Client ambigu : "%" (%).', p,
    (select string_agg(name, ', ') from clients where active and name ilike '%' || trim(p) || '%')
    using errcode = 'P0003';
end $$;

-- ─── Numérotation des factures : FAC-2026-00001 ──────────────────────────────

create or replace function public.next_invoice_number(p_kind public.invoice_kind default 'vente')
returns text language plpgsql security definer set search_path = public as $$
declare
  v_year integer := extract(year from current_date)::integer;
  v_n    integer;
begin
  insert into invoice_counters (year, kind, last) values (v_year, p_kind, 1)
  on conflict (year, kind) do update set last = invoice_counters.last + 1
  returning last into v_n;
  return case p_kind when 'stockage' then 'STO-' else 'FAC-' end
         || v_year || '-' || lpad(v_n::text, 5, '0');
end $$;

-- ─── Vues (security_invoker : respectent la RLS de l'appelant) ───────────────

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
  oc.name                                  as owner_client
from public.stock_balances b
join public.lots     l on l.id = b.lot_id
join public.products p on p.id = l.product_id
join public.depots   d on d.id = b.depot_id
left join public.suppliers s on s.id = l.supplier_id
left join public.clients  oc on oc.id = l.owner_client_id
where b.quantity > 0;

-- Stock ODS par produit, avec couverture (jours) et besoin de réappro
create or replace view public.v_stock_products with (security_invoker = true) as
with onhand as (
  select l.product_id,
         sum(b.quantity)                                   as quantity,
         sum(round(b.quantity * coalesce(l.cost_unit_xof, 0)))::bigint as value_xof,
         min(l.expiry_date) filter (where l.expiry_date >= current_date) as earliest_expiry,
         count(distinct l.id)                              as lots
  from public.stock_balances b
  join public.lots l on l.id = b.lot_id
  where b.quantity > 0 and l.owner_client_id is null
  group by l.product_id
),
sales as (
  select l.product_id, -sum(m.qty) / 30.0 as avg_daily_out
  from public.stock_movements m
  join public.lots l on l.id = m.lot_id
  where m.type = 'exit' and m.created_at >= now() - interval '30 days' and l.owner_client_id is null
  group by l.product_id
)
select
  p.id as product_id, p.sku, p.name as product_name, p.category, p.unit_type,
  coalesce(o.quantity, 0)         as quantity,
  coalesce(o.value_xof, 0)        as value_xof,
  o.earliest_expiry,
  coalesce(o.lots, 0)             as lots,
  round(coalesce(s.avg_daily_out, 0), 2) as avg_daily_out,
  case when coalesce(s.avg_daily_out, 0) > 0
       then floor(coalesce(o.quantity, 0) / s.avg_daily_out)::integer end as days_of_cover,
  p.lead_time_days,
  p.min_stock,
  (coalesce(o.quantity, 0) < p.min_stock)
    or (coalesce(s.avg_daily_out, 0) > 0
        and coalesce(o.quantity, 0) / s.avg_daily_out <= p.lead_time_days + 15) as needs_reorder
from public.products p
left join onhand o on o.product_id = p.id
left join sales  s on s.product_id = p.id
where p.active;

create or replace view public.v_receivables with (security_invoker = true) as
select
  i.id as invoice_id, i.number, i.kind, i.client_id, c.name as client_name, c.phone as client_phone,
  i.issue_date, i.due_date, i.total_xof, i.paid_xof,
  (i.total_xof - i.paid_xof)              as balance_xof,
  greatest(current_date - i.due_date, 0)  as days_overdue,
  case
    when current_date <= i.due_date        then 'a_echoir'
    when current_date - i.due_date <= 30   then '1-30j'
    when current_date - i.due_date <= 60   then '31-60j'
    else '60j+'
  end as aging_bucket
from public.invoices i
join public.clients c on c.id = i.client_id
where i.status in ('emise', 'partielle');

create or replace view public.v_client_balances with (security_invoker = true) as
select
  c.id as client_id, c.name as client_name, c.phone, c.type, c.credit_limit_xof,
  coalesce(sum(r.balance_xof), 0)::bigint                                   as balance_xof,
  coalesce(sum(r.balance_xof) filter (where r.days_overdue > 0), 0)::bigint as overdue_xof,
  max(r.days_overdue)                                                       as max_days_overdue,
  count(r.invoice_id)                                                       as open_invoices,
  (c.credit_limit_xof > 0 and coalesce(sum(r.balance_xof), 0) > c.credit_limit_xof) as over_limit
from public.clients c
left join public.v_receivables r on r.client_id = c.id
where c.active
group by c.id;

-- ─── Clients ─────────────────────────────────────────────────────────────────

create or replace function public.create_client(
  p_name text, p_phone text default null, p_type public.client_type default 'grossiste',
  p_credit_limit_xof bigint default 0, p_payment_terms_days integer default 0, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform require_role('manager', 'cfo');
  insert into clients (name, phone, type, credit_limit_xof, payment_terms_days, notes)
  values (trim(p_name), p_phone, p_type, p_credit_limit_xof, p_payment_terms_days, p_notes)
  returning id into v_id;
  return jsonb_build_object('client_id', v_id, 'name', trim(p_name));
end $$;

-- ─── Réception d'un lot ──────────────────────────────────────────────────────

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
  v_unit   uuid;
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

  v_prod  := resolve_product(p_product);
  v_depot := resolve_depot(p_depot);
  v_fx := coalesce(p_fx_rate_to_xof, case p_cost_currency when 'XOF' then 1 when 'EUR' then 655.957 end);
  if v_fx is null then raise exception 'Taux de change USD→XOF requis (p_fx_rate_to_xof)'; end if;

  if p_storage_unit is not null then
    select id into v_unit from storage_units
     where depot_id = v_depot.id and (lower(code) = lower(p_storage_unit) or lower(name) = lower(p_storage_unit));
    if v_unit is null then raise exception 'Chambre introuvable : %', p_storage_unit; end if;
  end if;
  if p_supplier is not null then
    insert into suppliers (name) values (trim(p_supplier)) on conflict (name) do nothing;
    select id into v_supp from suppliers where name = trim(p_supplier);
  end if;
  if p_owner_client is not null then
    v_owner := (resolve_client(p_owner_client)).id;
  end if;

  select id into v_lot from lots where product_id = v_prod.id and lot_number = trim(p_lot_number) for update;
  if v_lot is null then
    insert into lots (product_id, lot_number, supplier_id, container_no, invoice_ref, production_date,
                      expiry_date, original_qty, cost_unit, cost_currency, fx_rate_to_xof, owner_client_id, created_by)
    values (v_prod.id, trim(p_lot_number), v_supp, p_container_no, p_invoice_ref, p_production_date,
            p_expiry_date, p_qty, p_cost_unit, p_cost_currency, v_fx, v_owner, auth.uid())
    returning id into v_lot;
  else
    update lots set original_qty = original_qty + p_qty where id = v_lot;
  end if;

  insert into stock_movements (lot_id, depot_id, storage_unit_id, type, qty, reason, created_by)
  values (v_lot, v_depot.id, v_unit, 'entry', p_qty,
          coalesce('Réception ' || p_container_no, 'Réception'), auth.uid());

  return jsonb_build_object(
    'lot_id', v_lot, 'product', v_prod.name, 'sku', v_prod.sku, 'lot_number', trim(p_lot_number),
    'depot', v_depot.code, 'quantity', p_qty, 'expiry_date', p_expiry_date);
end $$;

-- ─── Sortie FEFO + facture ───────────────────────────────────────────────────
-- Prélève les lots qui expirent en premier, refuse les lots expirés,
-- contrôle la limite de crédit, crée la facture et ses lignes (avec coût → marge).

create or replace function public.dispatch_fefo(
  p_product text, p_qty numeric, p_client text, p_depot text default null,
  p_unit_price_xof bigint default null, p_due_days integer default null,
  p_create_invoice boolean default true, p_force boolean default false, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prod      products;
  v_client    clients;
  v_depot     depots;
  v_depot_id  uuid;
  v_price     bigint;
  v_left      numeric := p_qty;
  v_take      numeric;
  v_invoice   uuid;
  v_number    text;
  v_total     bigint;
  v_balance   bigint;
  v_available numeric;
  v_picks     jsonb := '[]'::jsonb;
  r           record;
begin
  perform require_role('magasinier', 'manager');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantité invalide'; end if;

  v_prod   := resolve_product(p_product);
  v_client := resolve_client(p_client);
  if p_depot is not null then v_depot := resolve_depot(p_depot); v_depot_id := v_depot.id; end if;
  v_price  := coalesce(p_unit_price_xof, v_prod.default_price_xof);

  if p_create_invoice and v_price is null then
    raise exception 'Prix unitaire requis pour % (aucun prix par défaut)', v_prod.name;
  end if;

  select coalesce(sum(b.quantity), 0) into v_available
    from stock_balances b join lots l on l.id = b.lot_id
   where l.product_id = v_prod.id and l.owner_client_id is null and b.quantity > 0
     and (v_depot_id is null or b.depot_id = v_depot_id)
     and (l.expiry_date is null or l.expiry_date >= current_date);
  if v_available < p_qty then
    raise exception 'Stock insuffisant pour % : demandé %, disponible % (lots non expirés)',
      v_prod.name, p_qty, v_available;
  end if;

  if p_create_invoice then
    v_total := round(p_qty * v_price);
    select coalesce(sum(total_xof - paid_xof), 0) into v_balance
      from invoices where client_id = v_client.id and status in ('emise', 'partielle');
    if v_client.credit_limit_xof > 0 and v_balance + v_total > v_client.credit_limit_xof then
      if not p_force then
        raise exception 'Limite de crédit dépassée pour % : encours % + cette vente % > limite % FCFA',
          v_client.name, v_balance, v_total, v_client.credit_limit_xof;
      end if;
      perform require_role('manager', 'cfo');
    end if;

    v_number := next_invoice_number('vente');
    insert into invoices (number, kind, client_id, issue_date, due_date, status, total_xof, notes, created_by)
    values (v_number, 'vente', v_client.id, current_date,
            current_date + coalesce(p_due_days, v_client.payment_terms_days), 'emise', v_total, p_notes, auth.uid())
    returning id into v_invoice;
  end if;

  for r in
    select b.lot_id, b.depot_id, b.quantity, l.lot_number, l.expiry_date, coalesce(l.cost_unit_xof, 0) as cost_xof
      from stock_balances b join lots l on l.id = b.lot_id
     where l.product_id = v_prod.id and l.owner_client_id is null and b.quantity > 0
       and (v_depot_id is null or b.depot_id = v_depot_id)
       and (l.expiry_date is null or l.expiry_date >= current_date)
     order by l.expiry_date nulls last, l.created_at
     for update of b
  loop
    exit when v_left <= 0;
    v_take := least(r.quantity, v_left);
    insert into stock_movements (lot_id, depot_id, type, qty, reason, client_id, invoice_id, created_by)
    values (r.lot_id, r.depot_id, 'exit', -v_take, 'Vente ' || v_client.name, v_client.id, v_invoice, auth.uid());
    if p_create_invoice then
      insert into invoice_lines (invoice_id, product_id, lot_id, description, qty, unit_price_xof, cost_xof)
      values (v_invoice, v_prod.id, r.lot_id, v_prod.name || ' — lot ' || r.lot_number, v_take, v_price,
              round(v_take * r.cost_xof));
    end if;
    v_picks := v_picks || jsonb_build_object('lot_number', r.lot_number, 'expiry_date', r.expiry_date, 'qty', v_take);
    v_left := v_left - v_take;
  end loop;

  return jsonb_build_object(
    'invoice_id', v_invoice, 'invoice_number', v_number, 'client', v_client.name,
    'product', v_prod.name, 'quantity', p_qty, 'unit_price_xof', v_price,
    'total_xof', v_total, 'picks', v_picks);
end $$;

-- ─── Transfert inter-dépôts (FEFO) ───────────────────────────────────────────

create or replace function public.transfer_stock(
  p_product text, p_qty numeric, p_from_depot text, p_to_depot text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prod  products;
  v_from  depots;
  v_to    depots;
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

  for r in
    select b.lot_id, b.quantity, l.lot_number
      from stock_balances b join lots l on l.id = b.lot_id
     where l.product_id = v_prod.id and b.depot_id = v_from.id and b.quantity > 0
     order by l.expiry_date nulls last, l.created_at
     for update of b
  loop
    exit when v_left <= 0;
    v_take := least(r.quantity, v_left);
    insert into stock_movements (lot_id, depot_id, type, qty, reason, transfer_ref, created_by)
    values (r.lot_id, v_from.id, 'transfer_out', -v_take, 'Transfert vers ' || v_to.code, v_ref, auth.uid()),
           (r.lot_id, v_to.id,   'transfer_in',   v_take, 'Transfert depuis ' || v_from.code, v_ref, auth.uid());
    v_picks := v_picks || jsonb_build_object('lot_number', r.lot_number, 'qty', v_take);
    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then
    raise exception 'Stock insuffisant à % pour % : manque %', v_from.code, v_prod.name, v_left;
  end if;
  return jsonb_build_object('transfer_ref', v_ref, 'product', v_prod.name, 'quantity', p_qty,
                            'from', v_from.code, 'to', v_to.code, 'picks', v_picks);
end $$;

-- ─── Inventaire / pertes ─────────────────────────────────────────────────────

create or replace function public.adjust_stock(
  p_product text, p_lot_number text, p_counted_qty numeric, p_reason text,
  p_depot text default null, p_is_loss boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prod  products;
  v_depot depots;
  v_lot   lots;
  v_cur   numeric;
  v_delta numeric;
begin
  perform require_role('manager');
  if p_counted_qty < 0 then raise exception 'Quantité comptée invalide'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Motif obligatoire'; end if;
  v_prod  := resolve_product(p_product);
  v_depot := resolve_depot(p_depot);
  select * into v_lot from lots where product_id = v_prod.id and lot_number = trim(p_lot_number);
  if not found then raise exception 'Lot % introuvable pour %', p_lot_number, v_prod.name; end if;

  select quantity into v_cur from stock_balances where lot_id = v_lot.id and depot_id = v_depot.id for update;
  v_cur := coalesce(v_cur, 0);
  v_delta := p_counted_qty - v_cur;
  if v_delta = 0 then
    return jsonb_build_object('product', v_prod.name, 'lot_number', v_lot.lot_number, 'delta', 0, 'message', 'Aucun écart');
  end if;
  if p_is_loss and v_delta > 0 then raise exception 'Une perte ne peut pas augmenter le stock'; end if;

  insert into stock_movements (lot_id, depot_id, type, qty, reason, created_by)
  values (v_lot.id, v_depot.id, case when p_is_loss then 'loss' else 'adjustment' end::movement_type,
          v_delta, p_reason, auth.uid());

  return jsonb_build_object('product', v_prod.name, 'lot_number', v_lot.lot_number, 'previous', v_cur,
                            'counted', p_counted_qty, 'delta', v_delta,
                            'value_impact_xof', round(v_delta * coalesce(v_lot.cost_unit_xof, 0)));
end $$;

-- ─── Paiements ───────────────────────────────────────────────────────────────

create or replace function public.record_payment(
  p_invoice_number text, p_amount_xof bigint,
  p_method public.payment_method default 'especes', p_reference text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_inv invoices;
begin
  perform require_role('manager', 'cfo');
  select * into v_inv from invoices where upper(number) = upper(trim(p_invoice_number)) for update;
  if not found then raise exception 'Facture introuvable : %', p_invoice_number; end if;
  if v_inv.status in ('annulee', 'payee') then raise exception 'Facture % déjà %', v_inv.number, v_inv.status; end if;
  insert into payments (invoice_id, amount_xof, method, reference, created_by)
  values (v_inv.id, p_amount_xof, p_method, p_reference, auth.uid());
  select * into v_inv from invoices where id = v_inv.id;
  return jsonb_build_object('invoice_number', v_inv.number, 'paid_xof', v_inv.paid_xof,
                            'balance_xof', v_inv.total_xof - v_inv.paid_xof, 'status', v_inv.status);
end $$;

-- Paiement global d'un client : imputé sur les factures les plus anciennes
create or replace function public.record_client_payment(
  p_client text, p_amount_xof bigint,
  p_method public.payment_method default 'especes', p_reference text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_client clients;
  v_left   bigint := p_amount_xof;
  v_take   bigint;
  v_alloc  jsonb := '[]'::jsonb;
  r        record;
begin
  perform require_role('manager', 'cfo');
  if p_amount_xof is null or p_amount_xof <= 0 then raise exception 'Montant invalide'; end if;
  v_client := resolve_client(p_client);
  for r in
    select id, number, total_xof - paid_xof as balance
      from invoices
     where client_id = v_client.id and status in ('emise', 'partielle')
     order by due_date, issue_date, number
     for update
  loop
    exit when v_left <= 0;
    v_take := least(r.balance, v_left);
    insert into payments (invoice_id, amount_xof, method, reference, created_by)
    values (r.id, v_take, p_method, p_reference, auth.uid());
    v_alloc := v_alloc || jsonb_build_object('invoice_number', r.number, 'amount_xof', v_take);
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then
    raise exception 'Le montant dépasse l''encours de % de % FCFA', v_client.name, v_left;
  end if;
  return jsonb_build_object('client', v_client.name, 'amount_xof', p_amount_xof, 'allocations', v_alloc,
    'remaining_balance_xof', (select balance_xof from v_client_balances where client_id = v_client.id));
end $$;

-- ─── Stockage pour tiers ─────────────────────────────────────────────────────

create or replace function public.storage_pallets(p_client text, p_pallets integer, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_client   clients;
  v_contract uuid;
  v_current  integer;
begin
  perform require_role('magasinier', 'manager');
  v_client := resolve_client(p_client);
  select id into v_contract from storage_contracts
   where client_id = v_client.id and active order by start_date desc limit 1 for update;
  if v_contract is null then raise exception 'Aucun contrat de stockage actif pour %', v_client.name; end if;
  select coalesce(sum(pallets), 0) into v_current from storage_pallet_events where contract_id = v_contract;
  if v_current + p_pallets < 0 then
    raise exception '% n''a que % palette(s) en stock', v_client.name, v_current;
  end if;
  insert into storage_pallet_events (contract_id, pallets, note, created_by)
  values (v_contract, p_pallets, p_note, auth.uid());
  return jsonb_build_object('client', v_client.name, 'pallets_now', v_current + p_pallets);
end $$;

-- Palettes × jours sur [p_from, p_to)
create or replace function public.storage_pallet_days(p_contract uuid, p_from timestamptz, p_to timestamptz)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  v_bal   integer;
  v_t     timestamptz := p_from;
  v_total numeric := 0;
  r       record;
begin
  select coalesce(sum(pallets), 0) into v_bal
    from storage_pallet_events where contract_id = p_contract and happened_at < p_from;
  for r in
    select happened_at, pallets from storage_pallet_events
     where contract_id = p_contract and happened_at >= p_from and happened_at < p_to
     order by happened_at
  loop
    v_total := v_total + v_bal * extract(epoch from (r.happened_at - v_t)) / 86400.0;
    v_bal := v_bal + r.pallets;
    v_t := r.happened_at;
  end loop;
  v_total := v_total + v_bal * extract(epoch from (p_to - v_t)) / 86400.0;
  return round(v_total, 2);
end $$;

-- Facture le mois de p_month pour tous les contrats actifs (idempotent)
create or replace function public.bill_storage(p_month date default (date_trunc('month', current_date) - interval '1 month')::date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_start  date := date_trunc('month', p_month)::date;
  v_end    date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_days   numeric;
  v_amount bigint;
  v_inv    uuid;
  v_number text;
  v_out    jsonb := '[]'::jsonb;
  c        record;
begin
  perform require_role('manager', 'cfo');
  for c in
    select sc.*, cl.name as client_name, cl.payment_terms_days
      from storage_contracts sc join clients cl on cl.id = sc.client_id
     where sc.start_date < v_end and (sc.end_date is null or sc.end_date >= v_start)
       and not exists (select 1 from storage_billing_runs b where b.contract_id = sc.id and b.period_start = v_start)
  loop
    v_days := storage_pallet_days(c.id, greatest(v_start, c.start_date)::timestamptz,
                                  least(v_end, coalesce(c.end_date + 1, v_end))::timestamptz);
    v_amount := greatest(c.min_monthly_xof, round(v_days * c.rate_pallet_day_xof))::bigint;
    continue when v_amount = 0;

    v_number := next_invoice_number('stockage');
    insert into invoices (number, kind, client_id, issue_date, due_date, status, total_xof, period_start, period_end, created_by)
    values (v_number, 'stockage', c.client_id, current_date, current_date + c.payment_terms_days, 'emise',
            v_amount, v_start, v_end - 1, auth.uid())
    returning id into v_inv;
    if v_days > 0 then
      insert into invoice_lines (invoice_id, description, qty, unit_price_xof)
      values (v_inv, 'Stockage froid ' || to_char(v_start, 'MM/YYYY') || ' (palettes × jours)',
              v_days, c.rate_pallet_day_xof);
    end if;
    if c.min_monthly_xof > round(v_days * c.rate_pallet_day_xof) then
      insert into invoice_lines (invoice_id, description, qty, unit_price_xof)
      values (v_inv, 'Complément minimum mensuel', 1, c.min_monthly_xof - round(v_days * c.rate_pallet_day_xof)::bigint);
    end if;
    insert into storage_billing_runs (contract_id, period_start, invoice_id) values (c.id, v_start, v_inv);
    v_out := v_out || jsonb_build_object('client', c.client_name, 'invoice_number', v_number,
                                         'pallet_days', v_days, 'total_xof', v_amount);
  end loop;
  return jsonb_build_object('period', to_char(v_start, 'MM/YYYY'), 'invoices', v_out);
end $$;

-- ─── Ventes / marge ──────────────────────────────────────────────────────────

create or replace function public.sales_summary(p_from date default current_date - 7, p_to date default current_date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  perform require_role('manager', 'cfo');
  with lines as (
    select i.client_id, c.name as client, il.product_id, p.name as product,
           il.qty, il.line_total_xof as revenue, coalesce(il.cost_xof, 0) as cost
      from invoices i
      join invoice_lines il on il.invoice_id = i.id
      join clients c on c.id = i.client_id
      left join products p on p.id = il.product_id
     where i.kind = 'vente' and i.status <> 'annulee' and i.issue_date between p_from and p_to
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'revenue_xof', coalesce(sum(revenue), 0),
    'cost_xof',    coalesce(sum(cost), 0),
    'margin_xof',  coalesce(sum(revenue - cost), 0),
    'margin_pct',  case when sum(revenue) > 0 then round(100.0 * sum(revenue - cost) / sum(revenue), 1) end,
    'by_product',  coalesce((select jsonb_agg(x order by x->>'revenue_xof' desc) from (
                      select jsonb_build_object('product', product, 'qty', sum(qty), 'revenue_xof', sum(revenue),
                                                'margin_xof', sum(revenue - cost)) as x
                        from lines group by product) t), '[]'::jsonb),
    'top_clients', coalesce((select jsonb_agg(x) from (
                      select jsonb_build_object('client', client, 'revenue_xof', sum(revenue)) as x
                        from lines group by client order by sum(revenue) desc limit 5) t), '[]'::jsonb),
    'payments_received_xof', (select coalesce(sum(amount_xof), 0) from payments
                               where paid_at::date between p_from and p_to)
  ) into v from lines;
  return v;
end $$;

-- ─── Alertes ─────────────────────────────────────────────────────────────────

create or replace function public.generate_alerts() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_today text := to_char(current_date, 'YYYY-MM-DD');
  v_n     integer := 0;
  v_k     integer;
begin
  -- FEFO : lots expirés ou à ≤ 15 jours
  insert into alerts (level, kind, title, body, ref, dedupe_key)
  select case when fefo_status = 'EXPIRE' then 'critical' else 'warning' end::alert_level,
         'fefo',
         case when fefo_status = 'EXPIRE' then 'Lot expiré' else 'Lot à écouler' end || ' : ' || product_name,
         'Lot ' || lot_number || ' (' || depot_code || ') : ' || quantity || ' ' || unit_type ||
           case when fefo_status = 'EXPIRE' then ', expiré depuis ' || -days_to_expiry || ' j'
                else ', expire dans ' || days_to_expiry || ' j' end ||
           ', valeur ' || to_char(value_xof, 'FM999G999G999') || ' FCFA',
         jsonb_build_object('lot_id', lot_id, 'depot_id', depot_id),
         'fefo:' || lot_id || ':' || depot_id || ':' || v_today
    from v_stock_lots where fefo_status in ('EXPIRE', 'CRITIQUE') and owner_client_id is null
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- Réapprovisionnement
  insert into alerts (level, kind, title, body, ref, dedupe_key)
  select 'warning', 'reappro', 'Réappro à lancer : ' || product_name,
         'Stock ' || quantity || ' ' || unit_type ||
           coalesce(', couverture ' || days_of_cover || ' j', '') ||
           ' pour un délai fournisseur de ' || lead_time_days || ' j',
         jsonb_build_object('product_id', product_id),
         'reappro:' || product_id || ':' || v_today
    from v_stock_products where needs_reorder
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- Créances en retard
  insert into alerts (level, kind, title, body, ref, dedupe_key)
  select case when max_days_overdue > 30 then 'critical' else 'warning' end::alert_level,
         'creance', 'Impayé : ' || client_name,
         to_char(overdue_xof, 'FM999G999G999') || ' FCFA en retard (jusqu''à ' || max_days_overdue || ' j)' ||
           coalesce(' — ' || phone, ''),
         jsonb_build_object('client_id', client_id),
         'creance:' || client_id || ':' || v_today
    from v_client_balances where overdue_xof > 0
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  return v_n;
end $$;

-- ─── Briefing du matin ───────────────────────────────────────────────────────

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
    'storage_tenants', coalesce((select jsonb_agg(jsonb_build_object('client', cl.name, 'pallets', t.pallets))
          from (select sc.client_id, sum(e.pallets) as pallets
                  from storage_contracts sc join storage_pallet_events e on e.contract_id = sc.id
                 where sc.active group by sc.client_id having sum(e.pallets) > 0) t
          join clients cl on cl.id = t.client_id), '[]'::jsonb),
    'unread_alerts', (select count(*) from alerts where read_at is null)
  );
end $$;
