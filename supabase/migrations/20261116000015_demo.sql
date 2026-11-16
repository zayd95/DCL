-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Démo réelle
--   demo_seed()   : installe un jeu de données réaliste (2 entrepôts, 6 chambres,
--                   5 produits, clients, historique d'hier, créances en retard…)
--                   en passant par les VRAIES fonctions métier.
--   demo_purge()  : efface toute la démo, sans toucher aux données réelles,
--                   et remet la numérotation des factures en ordre.
--   demo_status() : la démo est-elle installée ?
-- Tout ce qui est démo est marqué (colonne demo) : rien ne se mélange.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.depots    add column if not exists demo boolean not null default false;
alter table public.products  add column if not exists demo boolean not null default false;
alter table public.clients   add column if not exists demo boolean not null default false;
alter table public.suppliers add column if not exists demo boolean not null default false;

-- Le grand livre reste immuable, sauf pour les écritures d'un entrepôt de démo
create or replace function public.tg_immutable() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from depots d where d.id = old.depot_id and d.demo) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'Le grand livre est immuable : passez une écriture de correction (adjustment).';
end $$;

create or replace function public.demo_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('installed', exists (select 1 from depots where demo));
$$;

create or replace function public.demo_purge() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_started timestamptz;
  v_names   text[];
  v_n       integer;
  v_inv     uuid[];
begin
  perform require_role('admin');
  select value::timestamptz into v_started from app_settings where key = 'demo_started_at';
  select array_agg(name) into v_names from (
    select name from products where demo union all select name from clients where demo
    union all select name from depots where demo
    union all select su.name from storage_units su join depots d on d.id = su.depot_id where d.demo) x;

  delete from storage_billing_runs where contract_id in (
    select id from storage_contracts where client_id in (select id from clients where demo)
                                         or depot_id in (select id from depots where demo));
  delete from storage_pallet_events where contract_id in (
    select id from storage_contracts where client_id in (select id from clients where demo)
                                         or depot_id in (select id from depots where demo));
  delete from storage_contracts where client_id in (select id from clients where demo)
                                   or depot_id in (select id from depots where demo);
  select coalesce(array_agg(id), '{}') into v_inv from invoices where client_id in (select id from clients where demo);
  delete from payments where invoice_id = any(v_inv);
  delete from invoice_lines where invoice_id = any(v_inv);
  delete from stock_movements where depot_id in (select id from depots where demo);
  delete from invoices where id = any(v_inv);
  get diagnostics v_n = row_count;
  delete from stock_balances where depot_id in (select id from depots where demo);
  delete from lots where product_id in (select id from products where demo);
  delete from purchase_orders where lines::text like '%DEMO-%';
  if v_names is not null then
    delete from tasks t where (v_started is null or t.created_at >= v_started - interval '1 minute')
      and exists (select 1 from unnest(v_names) n where t.title || ' ' || t.body || ' ' || coalesce(t.action::text, '') ilike '%' || n || '%');
    delete from alerts a where (v_started is null or a.created_at >= v_started - interval '1 minute')
      and exists (select 1 from unnest(v_names) n where a.title || ' ' || a.body ilike '%' || n || '%');
  end if;
  update profiles set depot_id = null where depot_id in (select id from depots where demo);
  delete from storage_units where depot_id in (select id from depots where demo);
  delete from clients where demo;
  delete from products where demo;
  delete from suppliers where demo;
  delete from depots where demo;
  delete from app_settings where key = 'demo_started_at';

  -- Numérotation : reprend après la dernière facture réelle (pas de trou)
  update invoice_counters ic set last = coalesce((
    select max(substring(i.number from '(\d+)$')::integer) from invoices i
     where i.kind = ic.kind and i.number like '%-' || ic.year || '-%'), 0);
  return jsonb_build_object('purged', true, 'invoices', v_n);
end $$;

create or replace function public.demo_seed() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_alm uuid; v_sod uuid;
begin
  perform require_role('admin');
  if exists (select 1 from depots where demo) then perform demo_purge(); end if;
  insert into app_settings (key, value) values ('demo_started_at', now()::text)
  on conflict (key) do update set value = excluded.value;

  -- Entrepôts et chambres
  insert into depots (code, name, type, address, demo) values ('ALM-DEMO', 'Almadies (démo)', 'frozen', 'Almadies, Dakar', true)
    returning id into v_alm;
  insert into depots (code, name, type, address, demo) values ('SOD-DEMO', 'Sodida (démo)', 'frozen', 'Sodida, Dakar', true)
    returning id into v_sod;
  insert into storage_units (depot_id, code, name, kind, temp_min_c, temp_max_c, capacity_tonnes, capacity_cartons, categories) values
    (v_alm, 'CF1', 'Grand frigo viande', 'frozen', -25, -18, 40, null, '{viande,abats}'),
    (v_alm, 'CF2', 'Frigo volaille',     'frozen', -22, -18, 20, null, '{volaille}'),
    (v_alm, 'PF',  'Petit frigo fromages','chilled', 2, 6, null, 300, '{fromage}'),
    (v_sod, 'S1',  'Chambre poisson',    'frozen', -25, -18, 30, null, '{poisson}'),
    (v_sod, 'S2',  'Chambre 2',          'frozen', -25, -18, 25, null, '{}'),
    (v_sod, 'S3',  'Chambre 3',          'frozen', -25, -18, 20, null, '{}');

  insert into suppliers (name, country, demo) values ('Fournisseur Inde (démo)', 'Inde', true), ('Fournisseur Brésil (démo)', 'Brésil', true),
    ('Fournisseur Mauritanie (démo)', 'Mauritanie', true), ('Fournisseur France (démo)', 'France', true);

  insert into products (sku, name, category, unit_type, unit_weight_kg, default_price_xof, min_stock, lead_time_days, demo) values
    ('DEMO-FOIE',     'Foie de bœuf 20 kg',     'abats',    'carton', 20,  26000, 150, 45, true),
    ('DEMO-HACHE',    'Viande hachée 10 kg',    'viande',   'carton', 10,  22000, 100, 45, true),
    ('DEMO-CUISSE',   'Cuisse de poulet 10 kg', 'volaille', 'carton', 10,  15000, 300, 40, true),
    ('DEMO-THIOF',    'Filet de thiof 5 kg',    'poisson',  'carton', 5,   21000,  60, 10, true),
    ('DEMO-EMMENTAL', 'Emmental 2,5 kg',        'fromage',  'carton', 2.5,  9500, 200, 30, true);

  insert into clients (name, phone, type, credit_limit_xof, payment_terms_days, demo) values
    ('Moussa Traders (démo)',          '+221770000001', 'grossiste',       15000000, 30, true),
    ('Restaurant Le Lagon (démo)',     '+221770000002', 'restaurant',       3000000, 15, true),
    ('Boucherie Ndiaye (démo)',        '+221770000003', 'detaillant',       5000000,  7, true),
    ('Supermarché Bayal (démo)',       '+221770000004', 'supermarche',      8000000, 30, true),
    ('Poissonnerie Soumbédioune (démo)','+221770000005', 'locataire_froid',        0,  0, true),
    ('Glacier Fass (démo)',            '+221770000006', 'locataire_froid',        0,  0, true);

  -- Stock (réceptions réelles, rangées dans les chambres)
  perform receive_lot('DEMO-FOIE',  1000, 'FB-0921', 'ALM-DEMO', current_date + 210, null, 32, 'USD', 600, 'Fournisseur Inde (démo)', 'MSKU4417201', null, 'CF1');
  perform receive_lot('DEMO-HACHE', 1400, 'VH-1003', 'ALM-DEMO', current_date + 160, null, 16500, 'XOF', null, 'Fournisseur Inde (démo)', 'MSKU4417201', null, 'CF1');
  perform receive_lot('DEMO-CUISSE', 250, 'CP-0815', 'ALM-DEMO', current_date + 10,  null, 11000, 'XOF', null, 'Fournisseur Brésil (démo)', 'HLXU9902113', null, 'CF2');
  perform receive_lot('DEMO-CUISSE', 450, 'CP-1002', 'ALM-DEMO', current_date + 190, null, 11200, 'XOF', null, 'Fournisseur Brésil (démo)', 'HLXU9902113', null, 'CF2');
  perform receive_lot('DEMO-THIOF',   45, 'TH-1101', 'SOD-DEMO', current_date + 6,   null, 15000, 'XOF', null, 'Fournisseur Mauritanie (démo)', null, null, 'S1');
  perform receive_lot('DEMO-THIOF',  220, 'TH-1109', 'SOD-DEMO', current_date + 120, null, 15500, 'XOF', null, 'Fournisseur Mauritanie (démo)', null, null, 'S1');
  perform receive_lot('DEMO-EMMENTAL',120,'EM-1020', 'ALM-DEMO', current_date + 75,  null, 6800, 'XOF', null, 'Fournisseur France (démo)', null, null, 'PF');

  -- Ventes passées (créances, dont une en retard)
  perform dispatch_fefo('DEMO-HACHE', 120, 'Boucherie Ndiaye (démo)', 'ALM-DEMO', 22000, null, true, false, null);
  perform dispatch_fefo('DEMO-THIOF',  40, 'Restaurant Le Lagon (démo)', 'SOD-DEMO', 21000, null, true, false, null);
  perform dispatch_fefo('DEMO-FOIE',  150, 'Moussa Traders (démo)', 'ALM-DEMO', 26000, null, true, false, null);
  perform dispatch_fefo('DEMO-EMMENTAL', 30, 'Supermarché Bayal (démo)', 'ALM-DEMO', 9500, null, true, false, null);
  perform record_client_payment('Moussa Traders (démo)', 2000000, 'virement', 'VIR-DEMO-01');

  -- Une location déjà en cours, qui se termine bientôt
  perform rent_room('Glacier Fass (démo)', 'S3', 'mensuel', 350000, current_date - 25, current_date + 5, true, 350000, 'SOD-DEMO', null);

  -- Tout cela s'est passé hier (le journal « Aujourd'hui » se remplira en direct)
  update stock_movements set created_at = created_at - interval '1 day'
   where depot_id in (v_alm, v_sod);
  update lots set created_at = created_at - interval '1 day' where product_id in (select id from products where demo);
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

  -- Le moteur analyse tout de suite
  begin perform engine_scan(); exception when others then null; end;
  return jsonb_build_object('installed', true);
end $$;

revoke execute on function public.demo_seed(), public.demo_purge(), public.demo_status() from public, anon;
grant execute on function public.demo_seed(), public.demo_purge(), public.demo_status() to authenticated;
