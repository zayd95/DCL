-- Chambre de chaque lot visible dans la vue stock (colonnes ajoutées en fin de vue)
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
  su.name                                  as room_name
from public.stock_balances b
join public.lots     l on l.id = b.lot_id
join public.products p on p.id = l.product_id
join public.depots   d on d.id = b.depot_id
left join public.suppliers s on s.id = l.supplier_id
left join public.clients  oc on oc.id = l.owner_client_id
left join public.storage_units su on su.id = l.storage_unit_id
where b.quantity > 0;
