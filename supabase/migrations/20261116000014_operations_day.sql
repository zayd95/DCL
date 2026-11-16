-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Opérations du jour : chiffres clés + journal en direct
-- Les montants ne sont renvoyés qu'aux rôles finance (manager, cfo, admin).
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.operations_day(p_date date default current_date, p_limit integer default 60)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_fin  boolean;
  v_from timestamptz := p_date::timestamptz;
  v_to   timestamptz := (p_date + 1)::timestamptz;
  v      jsonb;
begin
  perform require_role('magasinier', 'manager', 'cfo');
  v_fin := coalesce(app_role() in ('manager', 'cfo', 'admin'), true);   -- console / service : tout

  with sales as (
    select i.id, i.number, i.created_at as at, c.name as client, i.total_xof, i.created_by,
           string_agg(distinct p.name, ', ') as products, sum(il.qty) as qty
      from invoices i join clients c on c.id = i.client_id
      join invoice_lines il on il.invoice_id = i.id left join products p on p.id = il.product_id
     where i.kind = 'vente' and i.created_at >= v_from and i.created_at < v_to and i.status <> 'annulee'
     group by i.id, c.name
  ),
  moves as (
    select m.created_at as at, m.type, m.qty, m.reason, m.created_by, m.transfer_ref,
           p.name as product, p.unit_type, l.lot_number, d.code as depot, su.name as room, oc.name as owner
      from stock_movements m
      join lots l on l.id = m.lot_id join products p on p.id = l.product_id
      join depots d on d.id = m.depot_id
      left join storage_units su on su.id = coalesce(m.storage_unit_id, l.storage_unit_id)
      left join clients oc on oc.id = l.owner_client_id
     where m.created_at >= v_from and m.created_at < v_to and m.type <> 'exit'
  ),
  pays as (
    select pa.paid_at as at, pa.amount_xof, pa.method, pa.reference, pa.created_by, c.name as client, i.number
      from payments pa join invoices i on i.id = pa.invoice_id join clients c on c.id = i.client_id
     where pa.created_at >= v_from and pa.created_at < v_to
  ),
  rentals as (
    select sc.created_at as at, cl.name as client, su.name as room, sc.billing, sc.price_xof
      from storage_contracts sc join clients cl on cl.id = sc.client_id left join storage_units su on su.id = sc.storage_unit_id
     where sc.created_at >= v_from and sc.created_at < v_to
  ),
  journal as (
    select at, 'vente' as kind, client as title,
           'Vente ' || number || ' · ' || qty || ' × ' || products as detail, case when v_fin then total_xof end as amount_xof, created_by
      from sales
    union all
    select at, case type when 'entry' then 'reception' when 'transfer_in' then 'transfert'
                         when 'loss' then 'perte' else 'ajustement' end,
           case type when 'entry' then 'Réception — ' || product
                     when 'transfer_in' then 'Transfert reçu — ' || product
                     when 'loss' then 'Perte — ' || product else 'Inventaire — ' || product end,
           qty || ' ' || unit_type || ' · lot ' || lot_number || ' · ' || depot || coalesce(' · ' || room, '') ||
             coalesce(' · à ' || owner, '') || case when type in ('loss', 'adjustment') then coalesce(' · ' || reason, '') else '' end,
           null::bigint, created_by
      from moves where type in ('entry', 'transfer_in', 'loss', 'adjustment')
    union all
    select at, 'encaissement', client,
           'Encaissement ' || coalesce(method::text, '') || ' · ' || number || coalesce(' · réf. ' || reference, ''),
           case when v_fin then amount_xof end, created_by
      from pays where v_fin
    union all
    select at, 'location', 'Location — ' || coalesce(room, 'chambre') || ' à ' || client,
           case billing when 'forfait' then 'Forfait' else 'Loyer mensuel' end,
           case when v_fin then price_xof end, null::uuid
      from rentals
  )
  select jsonb_build_object(
    'date', p_date,
    'finance', v_fin,
    'sales_count',     (select count(*) from sales),
    'sales_xof',       case when v_fin then (select coalesce(sum(total_xof), 0) from sales) end,
    'margin_xof',      case when v_fin then (select coalesce(sum(il.line_total_xof - coalesce(il.cost_xof, 0)), 0)
                                               from invoice_lines il where il.invoice_id in (select id from sales)) end,
    'payments_xof',    case when v_fin then (select coalesce(sum(amount_xof), 0) from pays) end,
    'receptions_count',(select count(*) from moves where type = 'entry'),
    'qty_in',          (select coalesce(sum(qty), 0) from moves where type = 'entry'),
    'qty_out',         (select coalesce(sum(qty), 0) from sales),
    'journal', coalesce((select jsonb_agg(jsonb_build_object(
                  'at', j.at, 'kind', j.kind, 'title', j.title, 'detail', j.detail, 'amount_xof', j.amount_xof,
                  'by', pr.full_name) order by j.at desc)
                from (select * from journal order by at desc limit p_limit) j
                left join profiles pr on pr.id = j.created_by), '[]'::jsonb)
  ) into v;
  return v;
end $$;

revoke execute on function public.operations_day(date, integer) from public, anon;
grant execute on function public.operations_day(date, integer) to authenticated;

-- Journal en direct dans l'app : rafraîchi à chaque mouvement et paiement (RLS appliquée)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.stock_movements;
    alter publication supabase_realtime add table public.payments;
  end if;
end $$;
