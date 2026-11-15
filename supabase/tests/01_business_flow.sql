-- Test de bout en bout : réception → vente FEFO → créances → paiement →
-- stockage tiers → alertes → briefing, avec contrôle des rôles.
-- Lancer après 00_supabase_stub.sql + migrations (voir supabase/README.md).
\set ON_ERROR_STOP 1

-- Utilisateurs (le premier devient admin automatiquement)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'habib@ods.sn'),
  ('00000000-0000-0000-0000-00000000000b', 'magasinier@ods.sn'),
  ('00000000-0000-0000-0000-00000000000c', 'cfo@ods.sn');
update profiles set role = 'cfo' where id = '00000000-0000-0000-0000-00000000000c';

do $$ begin
  assert (select role from profiles where id = '00000000-0000-0000-0000-00000000000a') = 'admin', 'premier user = admin';
  assert (select role from profiles where id = '00000000-0000-0000-0000-00000000000b') = 'magasinier', 'défaut = magasinier';
end $$;

create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

-- ─── Admin : référentiels ────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into depots (code, name, type, capacity_pallets) values ('ALM', 'Hub Almadies', 'frozen', 120), ('PAD', 'Dépôt Port', 'frozen', 80);
insert into storage_units (depot_id, code, name, kind, temp_min_c, temp_max_c)
  select id, 'CF1', 'Grande chambre 1', 'frozen', -25, -18 from depots where code = 'ALM';
insert into products (sku, name, category, unit_type, unit_weight_kg, default_price_xof, min_stock, lead_time_days) values
  ('POU-CUI-10', 'Cuisse de poulet 10kg', 'volaille', 'carton', 10, 15000, 20, 45),
  ('BOE-FOI-20', 'Foie de boeuf 20kg',    'abats',    'carton', 20, 32000, 10, 45);
select create_client('Moussa Traders', '+221770000001', 'grossiste', 1000000, 15);
select create_client('Poissonnerie Soumbedioune', '+221770000002', 'locataire_froid', 0, 30);
reset role;

-- ─── Magasinier : réceptions ─────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select receive_lot('POU-CUI-10', 100, 'LOT-A', 'ALM', current_date + 10, null, 9, 'EUR', null, 'BRF Dubai', 'MSCU1234567', 'INV-1', 'CF1');
select receive_lot('cuisse', 50, 'LOT-B', 'alm', current_date + 60, null, 10, 'USD', 600, 'BRF Dubai', 'MSCU1234567');
select receive_lot('Foie', 30, 'LOT-F', 'ALM', current_date + 90, null, 25000, 'XOF');

do $$ begin
  begin
    perform receive_lot('POU-CUI-10', 5, 'LOT-OLD', 'ALM', current_date - 1);
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like 'Lot déjà expiré%', sqlerrm; end;
  begin
    perform receive_lot('POU-CUI-10', 5, 'LOT-USD', 'ALM', null, null, 10, 'USD');
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like 'Taux de change%', sqlerrm; end;
  -- Écriture directe interdite
  begin
    insert into stock_movements (lot_id, depot_id, type, qty) select id, (select id from depots limit 1), 'entry', 999 from lots limit 1;
    raise exception 'devait échouer';
  exception when insufficient_privilege then null; end;
end $$;

-- Vente FEFO : 60 cartons → doivent sortir de LOT-A (expire en premier)
select dispatch_fefo('POU-CUI-10', 60, 'moussa', 'ALM');
do $$ begin
  assert (select quantity from v_stock_lots where lot_number = 'LOT-A') = 40, 'FEFO : LOT-A débité en premier';
  assert (select quantity from v_stock_lots where lot_number = 'LOT-B') = 50, 'LOT-B intact';
  assert (select count(*) from invoices) = 0, 'magasinier ne voit pas les factures';
  -- 50 de plus = 750 000 → encours 1 650 000 > limite 1 000 000
  begin
    perform dispatch_fefo('POU-CUI-10', 50, 'Moussa Traders');
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like 'Limite de crédit dépassée%', sqlerrm; end;
  begin
    perform dispatch_fefo('POU-CUI-10', 50, 'Moussa Traders', null, null, null, true, true);
    raise exception 'devait échouer';
  exception when insufficient_privilege then null; end;
  -- Stock insuffisant
  begin
    perform dispatch_fefo('POU-CUI-10', 1000, 'Moussa Traders', null, 1, null, false);
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like 'Stock insuffisant%', sqlerrm; end;
  -- Inventaire réservé au manager
  begin
    perform adjust_stock('POU-CUI-10', 'LOT-A', 38, 'casse');
    raise exception 'devait échouer';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ─── Admin : dépassement forcé, transfert, inventaire ────────────────────────
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select dispatch_fefo('POU-CUI-10', 50, 'Moussa Traders', 'ALM', 15000, 0, true, true, 'Accord Habib');
do $$ begin
  -- 50 = 40 restants de LOT-A + 10 de LOT-B
  assert not exists (select 1 from v_stock_lots where lot_number = 'LOT-A'), 'LOT-A épuisé';
  assert (select quantity from v_stock_lots where lot_number = 'LOT-B') = 40, 'LOT-B = 40';
  assert (select count(*) from invoice_lines) = 3, '3 lignes (une par lot prélevé)';
  assert (select sum(total_xof) from invoices) = 1650000, 'total factures';
end $$;
select transfer_stock('foie', 10, 'ALM', 'PAD');
select adjust_stock('Foie', 'LOT-F', 18, 'Carton abîmé', 'ALM', true);
do $$ begin
  assert (select quantity from v_stock_lots where lot_number = 'LOT-F' and depot_code = 'PAD') = 10, 'transfert';
  assert (select quantity from v_stock_lots where lot_number = 'LOT-F' and depot_code = 'ALM') = 18, 'perte';
  begin
    update stock_movements set qty = 1;
    raise exception 'devait échouer';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  begin
    update stock_movements set qty = 1 where id = 1;   -- même en superuser
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like 'Le grand livre est immuable%', sqlerrm; end;
end $$;

-- ─── CFO : paiements ─────────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select record_client_payment('Moussa', 1000000, 'wave', 'WAVE-123');
do $$ begin
  assert (select balance_xof from v_client_balances where client_name = 'Moussa Traders') = 650000, 'encours après paiement';
  -- imputation à l'échéance la plus proche : FAC-2 (comptant) puis FAC-1 (15 j)
  assert (select status from invoices where number like 'FAC-%-00002') = 'payee', 'facture 2 soldée';
  assert (select status from invoices where number like 'FAC-%-00001') = 'partielle', 'facture 1 partielle';
  begin
    perform record_client_payment('Moussa', 999999999);
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like 'Le montant dépasse%', sqlerrm; end;
end $$;
select sales_summary(current_date, current_date);
reset role;

-- Simule une échéance dépassée
update invoices set due_date = current_date - 20 where status = 'partielle';

-- ─── Stockage tiers ──────────────────────────────────────────────────────────
insert into storage_contracts (client_id, depot_id, rate_pallet_day_xof, min_monthly_xof, start_date)
select c.id, d.id, 500, 0, date_trunc('month', current_date - interval '1 month')::date
  from clients c, depots d where c.name = 'Poissonnerie Soumbedioune' and d.code = 'ALM';
-- 10 palettes du 1er au 11 du mois dernier, puis 4 palettes jusqu'à la fin
insert into storage_pallet_events (contract_id, pallets, happened_at)
select id, 10, date_trunc('month', current_date - interval '1 month') from storage_contracts;
insert into storage_pallet_events (contract_id, pallets, happened_at)
select id, -6, date_trunc('month', current_date - interval '1 month') + interval '10 days' from storage_contracts;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select bill_storage();
select bill_storage();   -- idempotent
do $$
declare v_days integer := extract(day from date_trunc('month', current_date) - interval '1 day')::integer;
begin
  assert (select count(*) from invoices where kind = 'stockage') = 1, 'une seule facture de stockage';
  assert (select number from invoices where kind = 'stockage') like 'STO-%-00001', 'numérotation séparée';
  assert (select total_xof from invoices where kind = 'stockage') = (10 * 10 + 4 * (v_days - 10)) * 500,
    format('montant stockage %s', (select total_xof from invoices where kind = 'stockage'));
  assert (select sum(line_total_xof) from invoice_lines il join invoices i on i.id = il.invoice_id where i.kind = 'stockage')
       = (select total_xof from invoices where kind = 'stockage'), 'lignes = total';
end $$;
reset role;

-- ─── Alertes & briefing ──────────────────────────────────────────────────────
select generate_alerts() as alertes_creees;
select generate_alerts() as alertes_doublons;  -- doit être 0
do $$ begin
  assert exists (select 1 from alerts where kind = 'creance'), 'alerte impayé';
  assert exists (select 1 from alerts where kind = 'reappro'), 'alerte réappro';
  assert (select generate_alerts()) = 0, 'pas de doublons';
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  assert not exists (select 1 from alerts where kind = 'creance'), 'magasinier ne voit pas les créances';
  begin
    perform daily_briefing();
    raise exception 'devait échouer';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select jsonb_pretty(daily_briefing());
reset role;

select 'TOUS LES TESTS PASSENT' as resultat;
