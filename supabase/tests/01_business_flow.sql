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
  exception when others then assert sqlerrm ilike '%limite de crédit dépassée%', sqlerrm; end;
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

-- ─── Chambres froides & location de chambres entières ───────────────────────
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update storage_units set capacity_cartons = 40 where code = 'CF1';
insert into storage_units (depot_id, code, name, kind, categories, capacity_tonnes)
select id, 'CF2', 'Chambre poisson', 'frozen', '{poisson}', 20 from depots where code = 'ALM';
insert into storage_units (depot_id, code, name, kind, capacity_tonnes)
select id, x.code, x.name, 'chilled', 10 from depots, (values ('CF3', 'Chambre 3'), ('CF4', 'Chambre 4')) x(code, name) where depots.code = 'ALM';
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select move_lot('POU-CUI-10', 'LOT-B', 'CF1');
do $$ begin
  -- Hygiène : pas de volaille dans la chambre poisson
  begin
    perform receive_lot('POU-CUI-10', 5, 'LOT-X', 'ALM', current_date + 30, null, null, 'XOF', null, null, null, null, 'CF2');
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like 'Chambre Chambre poisson réservée à : poisson%', sqlerrm; end;
  assert (select fill_pct from v_storage_rooms where room_code = 'CF1') = 100, 'CF1 pleine (40/40 cartons)';
  assert (select status from v_storage_rooms where room_code = 'CF1') = 'ods';
end $$;
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
-- Location mensuelle depuis le 1er du mois : loyer complet facturé d'avance
select rent_room('Poissonnerie', 'CF3', 'mensuel', 300000, date_trunc('month', current_date)::date);
select bill_storage();   -- idempotent
do $$
declare v_days int := extract(day from date_trunc('month', current_date) + interval '1 month - 1 day')::int;
        v_from date := current_date + 1;
        r jsonb;
begin
  assert (select count(*) from invoices where kind = 'stockage') = 1, 'une facture de location';
  assert (select number from invoices where kind = 'stockage') like 'STO-%-00001', 'numérotation séparée';
  assert (select total_xof from invoices where kind = 'stockage') = 300000, 'loyer mensuel complet';
  assert (select description from invoice_lines il join invoices i on i.id = il.invoice_id where i.kind = 'stockage')
         like '%Électricité à la charge du locataire.', 'électricité mentionnée';
  -- Chambre déjà louée sur la période
  begin
    perform rent_room('Moussa', 'CF3', 'mensuel', 100000);
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like '%déjà louée%', sqlerrm; end;
  -- Chambre contenant du stock ODS
  begin
    perform rent_room('Moussa', 'CF1', 'mensuel', 100000);
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like '%contient encore%', sqlerrm; end;
  -- Forfait 5 jours : facturé une fois
  r := rent_room('Moussa', 'CF2', 'forfait', 150000, current_date, current_date + 5, true);
  assert (select total_xof from invoices i join clients c on c.id = i.client_id where i.kind = 'stockage' and c.name = 'Moussa Traders') = 150000, 'forfait';
  -- Prorata : début demain
  if v_from <= (date_trunc('month', current_date) + interval '1 month - 1 day')::date then
    r := rent_room('Moussa', 'CF4', 'mensuel', 310000, v_from);
    assert (select total_xof from invoices i join storage_billing_runs b on b.invoice_id = i.id
             join storage_contracts sc on sc.id = b.contract_id join storage_units u on u.id = sc.storage_unit_id where u.code = 'CF4')
           = round(310000 * ((date_trunc('month', current_date) + interval '1 month - 1 day')::date - v_from + 1)::numeric / v_days),
           'prorata premier mois';
  end if;
  assert (select status from v_storage_rooms where room_code = 'CF3') = 'louee';
end $$;
reset role;

-- Chambre louée : seule la marchandise du locataire y entre
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  begin
    perform receive_lot('Foie', 5, 'LOT-Y', 'ALM', current_date + 30, null, null, 'XOF', null, null, null, null, 'CF3');
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like '%louée à Poissonnerie Soumbedioune%', sqlerrm; end;
  perform receive_lot('Foie', 5, 'T-1', 'ALM', current_date + 30, null, null, 'XOF', null, null, null, null, 'CF3', 'Poissonnerie');
  assert (select owner_client from v_stock_lots where lot_number = 'T-1') = 'Poissonnerie Soumbedioune', 'stock du locataire';
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

-- Fonctions internes non appelables par un utilisateur
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  begin
    perform next_invoice_number('vente');
    raise exception 'devait échouer';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'FONCTIONS INTERNES VERROUILLÉES' as resultat;

-- ═══ Moteur ══════════════════════════════════════════════════════════════════
select engine_scan() as taches_creees;
do $$ begin
  assert (select engine_scan()) = 0, 'moteur idempotent';
  assert exists (select 1 from tasks where kind = 'reappro' and action->>'tool' = 'bon_commande'), 'réappro préparé';
  assert exists (select 1 from tasks where kind = 'creance' and link like 'https://wa.me/221770000001?text=%'), 'relance WhatsApp prête';
  assert exists (select 1 from tasks where kind = 'chambre' and title like '%Grande chambre 1%'), 'chambre pleine signalée';
  assert exists (select 1 from tasks where kind = 'location' and title like '%Moussa%CF2%') or exists (select 1 from tasks where kind = 'location'), 'fin de location signalée';
end $$;

-- Magasinier : voit le stock (FEFO / rupture), pas les créances, ne peut pas valider un bon de commande
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$
declare v_task uuid;
begin
  assert not exists (select 1 from tasks where kind = 'creance'), 'magasinier ne voit pas les créances';
  assert not exists (select 1 from tasks where kind = 'reappro'), 'réappro réservé au manager';
  -- Vente à perte bloquée (LOT-B coûte 6 000 FCFA)
  begin
    perform dispatch_fefo('POU-CUI-10', 1, 'Poissonnerie Soumbedioune', null, 5000);
    raise exception 'devait échouer';
  exception when others then assert sqlerrm like 'VENTE BLOQUÉE — prix%', sqlerrm; end;
end $$;
reset role;

-- CFO : valide la commande proposée → bon de commande créé ; refuser une seconde fois = sans effet
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
do $$
declare v_task uuid; r jsonb;
begin
  select id into v_task from tasks where kind = 'reappro' limit 1;
  r := decide_task(v_task, 'valider');
  assert r->>'status' = 'validee', r::text;
  assert (r->'result'->>'number') like 'BC-%', r::text;
  assert (decide_task(v_task, 'refuser'))->>'message' = 'Déjà traitée', 'pas de double décision';
  assert (select count(*) from purchase_orders) = 1, 'bon de commande';
end $$;
reset role;

-- Admin : vente à perte avec dérogation → passe, et une alerte "anomalie" est créée
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select dispatch_fefo('POU-CUI-10', 1, 'Poissonnerie Soumbedioune', null, 5000, 0, true, true, 'Promo');
do $$ begin
  assert exists (select 1 from tasks where kind = 'anomalie' and title like 'Dérogation%'), 'dérogation signalée';
end $$;
reset role;

-- Telegram : décision au nom d'un utilisateur réservée au service_role
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  begin
    perform decide_task((select id from tasks limit 1), 'valider', '00000000-0000-0000-0000-00000000000a');
    raise exception 'devait échouer';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'MOTEUR OK' as resultat;

-- Document lu → réception validée par le magasinier (format produit par engine/logic.ts)
insert into tasks (kind, title, body, audience, action, dedupe_key) values ('document', 'Facture lue', '-', '{magasinier,manager,admin}',
  '{"tool":"reception","args":{"fournisseur":"Allana","conteneur":"MSCU9","devise":"EUR","reference":"INV-77",
    "lignes":[{"produit":"BOE-FOI-20","quantite":50,"lot":"L-77","expiration":"2030-01-01","cout_unitaire":30}]}}', 'document:test');
update profiles set depot_id = (select id from depots where code = 'ALM') where id = '00000000-0000-0000-0000-00000000000b';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ declare r jsonb; begin
  r := decide_task((select id from tasks where dedupe_key = 'document:test'), 'valider');
  assert r->>'status' = 'validee', r::text;
  assert (select quantity from v_stock_lots where lot_number = 'L-77') = 50, 'lot reçu';
  assert (select round(cost_unit_xof) from lots where lot_number = 'L-77') = round(30 * 655.957), 'coût converti EUR';
end $$;
reset role;
select 'DOCUMENT → RÉCEPTION OK' as resultat;

-- ═══ Opérations du jour ═════════════════════════════════════════════════════
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
do $$ declare r jsonb; begin
  r := operations_day();
  assert (r->>'sales_count')::int >= 3, r::text;
  assert (r->>'sales_xof')::bigint > 0 and (r->>'payments_xof')::bigint > 0, 'montants visibles pour la finance';
  assert jsonb_array_length(r->'journal') > 5, 'journal';
  assert exists (select 1 from jsonb_array_elements(r->'journal') e where e->>'kind' = 'location'), 'location au journal';
  assert exists (select 1 from jsonb_array_elements(r->'journal') e where e->>'kind' = 'encaissement'), 'encaissement au journal';
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ declare r jsonb; begin
  r := operations_day();
  assert r->>'sales_xof' is null and r->>'payments_xof' is null, 'magasinier : pas de montants';
  assert not exists (select 1 from jsonb_array_elements(r->'journal') e where e->>'amount_xof' is not null), 'journal sans montants';
  assert not exists (select 1 from jsonb_array_elements(r->'journal') e where e->>'kind' = 'encaissement'), 'pas d''encaissements';
end $$;
reset role;
select 'OPERATIONS OK' as resultat;

-- ═══ Démo : installation, scénario, purge ═══════════════════════════════════
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ declare r jsonb; n_real int; c_before int; begin
  select count(*) into n_real from invoices;
  select last into c_before from invoice_counters where kind = 'vente' and year = extract(year from current_date);
  perform demo_seed();
  assert (demo_status()->>'installed')::boolean, 'démo installée';
  assert (select count(*) from v_storage_rooms where depot_code like '%-DEMO') = 6, 'chambres démo';
  assert exists (select 1 from v_client_balances where client_name = 'Boucherie Ndiaye (démo)' and overdue_xof > 0), 'créance en retard';
  r := operations_day(current_date - 1);
  assert (r->>'sales_count')::int >= 4, 'historique hier : ' || r::text;
  -- scénario en direct
  perform receive_lot('DEMO-CUISSE', 800, 'CP-LIVE', 'ALM-DEMO', current_date + 240, null, 11200, 'XOF', null, null, null, null, 'CF2');
  r := dispatch_fefo('DEMO-CUISSE', 60, 'Moussa Traders (démo)', 'ALM-DEMO', 15000, null, true, false, null);
  assert r->'picks'->0->>'lot_number' = 'CP-0815', 'FEFO : le lot qui expire en premier sort d''abord';
  begin perform dispatch_fefo('DEMO-FOIE', 10, 'Restaurant Le Lagon (démo)', 'ALM-DEMO', 15000, null, true, false, null);
        assert false, 'vente à perte non bloquée';
  exception when others then assert sqlerrm like 'VENTE BLOQUÉE%', sqlerrm; end;
  begin perform dispatch_fefo('DEMO-HACHE', 300, 'Boucherie Ndiaye (démo)', 'ALM-DEMO', 22000, null, true, false, null);
        assert false, 'crédit non bloqué';
  exception when others then assert sqlerrm like 'VENTE BLOQUÉE%', sqlerrm; end;
  perform record_client_payment('Boucherie Ndiaye (démo)', 1500000, 'wave', null);
  perform adjust_stock('DEMO-THIOF', 'TH-1101', 2, 'Cartons abîmés (démo)', 'SOD-DEMO', true);
  perform receive_lot('DEMO-FOIE', 400, 'FB-LIVE', 'ALM-DEMO', current_date + 200, null, 32, 'USD', 600, null, null, null, 'CF1');
  assert (select fill_pct from v_storage_rooms where room_code = 'CF1' and depot_code = 'ALM-DEMO') >= 90, 'chambre pleine';
  perform rent_room('Poissonnerie Soumbédioune (démo)', 'S2', 'mensuel', 400000, current_date, null, true, 400000, 'SOD-DEMO', null);
  r := operations_day();
  assert jsonb_array_length(r->'journal') >= 6, 'journal du jour : ' || r::text;
  -- purge
  perform demo_purge();
  assert not (demo_status()->>'installed')::boolean;
  assert (select count(*) from invoices) = n_real, 'factures réelles intactes';
  assert (select count(*) from stock_movements m join depots d on d.id = m.depot_id where d.code like '%-DEMO') = 0;
end $$;
reset role;
do $$ begin
  assert coalesce((select last from invoice_counters where kind = 'vente' and year = extract(year from current_date)), 0)
         = coalesce((select max(substring(number from '(\d+)$')::int) from invoices where kind = 'vente'), 0), 'numérotation sans trou';
  assert not exists (select 1 from depots where demo) and not exists (select 1 from products where demo), 'purge complète';
end $$;
select 'DEMO OK' as resultat;
