-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Moteur (surveillance en continu)
--
--   • tasks          : le fil « À traiter ». Le moteur y dépose ce qu'il a détecté
--                      ou préparé ; l'utilisateur valide / refuse en un clic
--                      (app, Telegram ou notification iPhone).
--   • engine_scan()  : toutes les règles de surveillance, idempotentes (dedupe_key).
--   • decide_task()  : valide / refuse une tâche et exécute l'action préparée.
--   • Autonomie choisie par Habib : le moteur BLOQUE seul les ventes à risque
--     (lot expiré, sous le prix de revient, au-delà de la limite de crédit).
--     Tout le reste est préparé et attend une validation.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── Fil « À traiter » ───────────────────────────────────────────────────────

create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,       -- reappro | rupture | fefo | creance | credit | anomalie | document
  severity    public.alert_level not null default 'warning',
  title       text not null,
  body        text not null,
  action      jsonb,               -- { tool, args, summary } : action préparée, exécutée à la validation
  link        text,                -- lien utile (ex. relance WhatsApp pré-rédigée)
  audience    public.user_role[] not null default '{manager,cfo,admin}',
  status      text not null default 'ouverte'
              check (status in ('ouverte', 'validee', 'refusee', 'resolue', 'echec')),
  dedupe_key  text unique,
  result      jsonb,
  decided_by  uuid references auth.users(id),
  decided_at  timestamptz,
  notified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index tasks_open_idx on public.tasks (created_at desc) where status = 'ouverte';
create index tasks_notify_idx on public.tasks (created_at) where notified_at is null;

-- ─── Bons de commande fournisseur (préparés par le moteur) ───────────────────

create table public.purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique,
  supplier    text,
  status      text not null default 'brouillon' check (status in ('brouillon', 'envoyee', 'recue', 'annulee')),
  lines       jsonb not null default '[]'::jsonb,   -- [{ sku, product, qty, unit }]
  notes       text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

-- ─── Documents reçus (app, Telegram) ─────────────────────────────────────────

create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  storage_path  text not null,
  mime          text not null,
  source        text not null default 'app' check (source in ('app', 'telegram')),
  uploaded_by   uuid references auth.users(id),
  status        text not null default 'a_lire' check (status in ('a_lire', 'lu', 'erreur')),
  doc_type      text,                -- facture_fournisseur | bon_commande | recu_paiement | autre
  extracted     jsonb,
  error         text,
  task_id       uuid references public.tasks(id),
  created_at    timestamptz not null default now()
);
create index documents_pending_idx on public.documents (created_at) where status = 'a_lire';

-- ─── Notifications ───────────────────────────────────────────────────────────

create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

create table public.telegram_links (
  code        text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  expires_at  timestamptz not null default now() + interval '15 minutes'
);

-- ─── Ventes à risque : blocage du prix sous le coût de revient ───────────────

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
  v_forced    boolean := false;
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
        raise exception 'VENTE BLOQUÉE — limite de crédit dépassée pour % : encours % + cette vente % > limite % FCFA',
          v_client.name, v_balance, v_total, v_client.credit_limit_xof;
      end if;
      perform require_role('manager', 'cfo');
      v_forced := true;
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
    -- Vente à perte : bloquée, sauf dérogation explicite d'un manager
    if p_create_invoice and r.cost_xof > 0 and v_price < r.cost_xof then
      if not p_force then
        raise exception 'VENTE BLOQUÉE — prix % FCFA inférieur au prix de revient % FCFA (lot %)',
          v_price, round(r.cost_xof), r.lot_number;
      end if;
      perform require_role('manager');
      v_forced := true;
    end if;
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

  -- Une dérogation est toujours signalée
  if v_forced then
    insert into tasks (kind, severity, title, body, dedupe_key)
    values ('anomalie', 'warning', 'Dérogation sur une vente : ' || v_client.name,
            'Facture ' || v_number || ' (' || v_prod.name || ', ' || p_qty || ' × ' || v_price ||
            ' FCFA) validée malgré une règle de blocage (crédit ou prix de revient).',
            'derogation:' || v_invoice);
  end if;

  return jsonb_build_object(
    'invoice_id', v_invoice, 'invoice_number', v_number, 'client', v_client.name,
    'product', v_prod.name, 'quantity', p_qty, 'unit_price_xof', v_price,
    'total_xof', v_total, 'picks', v_picks);
end $$;

-- ─── Bon de commande ─────────────────────────────────────────────────────────

create or replace function public.create_purchase_order(p_product text, p_qty numeric, p_supplier text default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prod products;
  v_n    integer;
  v_num  text;
begin
  perform require_role('manager', 'cfo');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantité invalide'; end if;
  v_prod := resolve_product(p_product);
  select count(*) + 1 into v_n from purchase_orders where created_at >= date_trunc('year', now());
  v_num := 'BC-' || extract(year from now())::int || '-' || lpad(v_n::text, 4, '0');
  insert into purchase_orders (number, supplier, lines, notes, created_by)
  values (v_num, p_supplier,
          jsonb_build_array(jsonb_build_object('sku', v_prod.sku, 'product', v_prod.name, 'qty', p_qty, 'unit', v_prod.unit_type)),
          p_notes, auth.uid());
  return jsonb_build_object('number', v_num, 'product', v_prod.name, 'qty', p_qty, 'unit', v_prod.unit_type);
end $$;

-- ─── Règles de surveillance ──────────────────────────────────────────────────
-- Idempotent : chaque constat a une clé (par jour ou par semaine) ; relancer
-- engine_scan() ne crée jamais de doublon. Renvoie le nombre de tâches créées.

create or replace function public.engine_scan() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_day  text := to_char(current_date, 'YYYY-MM-DD');
  v_week text := to_char(current_date, 'IYYY-IW');
  v_n    integer := 0;
  v_k    integer;
begin
  -- 1. Rupture : produit vendu ces 30 derniers jours et plus aucun stock
  insert into tasks (kind, severity, title, body, action, audience, dedupe_key)
  select 'rupture', 'critical', 'Rupture : ' || product_name,
         'Plus aucun stock disponible. Ventes récentes : ' || avg_daily_out || ' ' || unit_type || '/jour.',
         jsonb_build_object('tool', 'bon_commande',
           'args', jsonb_build_object('produit', sku, 'quantite', greatest(ceil(avg_daily_out * (lead_time_days + 30)), min_stock * 2, 1))),
         '{magasinier,manager,cfo,admin}', 'rupture:' || product_id || ':' || v_week
    from v_stock_products where quantity = 0 and avg_daily_out > 0
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- 2. Réappro : sous le stock minimum ou couverture ≤ délai fournisseur + 15 j
  insert into tasks (kind, severity, title, body, action, dedupe_key)
  select 'reappro', 'warning', 'Commander : ' || product_name,
         'Stock ' || quantity || ' ' || unit_type ||
           coalesce(', soit ' || days_of_cover || ' j de ventes', '') ||
           ' pour un délai fournisseur de ' || lead_time_days || ' j.',
         jsonb_build_object('tool', 'bon_commande',
           'args', jsonb_build_object('produit', sku,
             'quantite', greatest(ceil(avg_daily_out * (lead_time_days + 30) - quantity), min_stock * 2 - quantity, 1))),
         'reappro:' || product_id || ':' || v_week
    from v_stock_products where needs_reorder and quantity > 0
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- 3. FEFO : lots expirés ou à ≤ 15 jours (stock ODS)
  insert into tasks (kind, severity, title, body, audience, dedupe_key)
  select 'fefo', case when fefo_status = 'EXPIRE' then 'critical' else 'warning' end::alert_level,
         case when fefo_status = 'EXPIRE' then 'Lot expiré à retirer : ' else 'Lot à écouler : ' end || product_name,
         'Lot ' || lot_number || ' (' || depot_code || ') : ' || quantity || ' ' || unit_type ||
           case when fefo_status = 'EXPIRE' then ', expiré depuis ' || -days_to_expiry || ' j. Il ne peut plus être vendu.'
                else ', expire dans ' || days_to_expiry || ' j. Proposez-le en priorité, au besoin avec une remise.' end ||
           ' Valeur : ' || to_char(value_xof, 'FM999G999G999') || ' FCFA.',
         '{magasinier,manager,cfo,admin}',
         'fefo:' || lot_id || ':' || depot_id || ':' || fefo_status
    from v_stock_lots where fefo_status in ('EXPIRE', 'CRITIQUE') and owner_client_id is null
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- 4. Créances en retard (une fois par semaine et par client)
  insert into tasks (kind, severity, title, body, link, dedupe_key)
  select 'creance', case when max_days_overdue > 30 then 'critical' else 'warning' end::alert_level,
         'Relancer ' || client_name,
         to_char(overdue_xof, 'FM999G999G999') || ' FCFA en retard (jusqu''à ' || max_days_overdue || ' j). Encours total : ' ||
           to_char(balance_xof, 'FM999G999G999') || ' FCFA.',
         case when phone is not null then
           'https://wa.me/' || case when length(regexp_replace(phone, '\D', '', 'g')) = 9 then '221' else '' end ||
           regexp_replace(phone, '\D', '', 'g') || '?text=' ||
           replace(replace(replace(
             'Bonjour ' || client_name || ', petit rappel : votre solde chez ODS est de ' ||
             to_char(balance_xof, 'FM999G999G999') || ' FCFA, dont ' || to_char(overdue_xof, 'FM999G999G999') ||
             ' FCFA échus. Merci de nous indiquer la date de règlement.', ' ', '%20'), '''', '%27'), ',', '%2C')
         end,
         'creance:' || client_id || ':' || v_week
    from v_client_balances where overdue_xof > 0
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- 5. Client au-delà de sa limite de crédit
  insert into tasks (kind, severity, title, body, dedupe_key)
  select 'credit', 'warning', 'Limite de crédit dépassée : ' || client_name,
         'Encours ' || to_char(balance_xof, 'FM999G999G999') || ' FCFA pour une limite de ' ||
           to_char(credit_limit_xof, 'FM999G999G999') || ' FCFA. Les nouvelles ventes à crédit sont bloquées.',
         'credit:' || client_id || ':' || v_week
    from v_client_balances where over_limit
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- 6. Pertes importantes (> 100 000 FCFA) déclarées aujourd'hui
  insert into tasks (kind, severity, title, body, dedupe_key)
  select 'anomalie', 'warning', 'Perte déclarée : ' || p.name,
         abs(m.qty) || ' ' || p.unit_type || ' (lot ' || l.lot_number || '), soit ' ||
           to_char(abs(m.qty) * coalesce(l.cost_unit_xof, 0), 'FM999G999G999') || ' FCFA. Motif : ' || coalesce(m.reason, '—'),
         'perte:' || m.id
    from stock_movements m join lots l on l.id = m.lot_id join products p on p.id = l.product_id
   where m.type in ('loss', 'adjustment') and m.qty < 0 and m.created_at >= current_date
     and abs(m.qty) * coalesce(l.cost_unit_xof, 0) > 100000
  on conflict (dedupe_key) do nothing;
  get diagnostics v_k = row_count; v_n := v_n + v_k;

  -- 7. Tâches devenues sans objet : stock revenu, créance réglée
  update tasks t set status = 'resolue', decided_at = now()
   where t.status = 'ouverte' and (
     (t.kind in ('reappro', 'rupture') and exists (
        select 1 from v_stock_products s where t.dedupe_key like t.kind || ':' || s.product_id || ':%' and not s.needs_reorder and s.quantity > 0))
     or (t.kind = 'creance' and exists (
        select 1 from v_client_balances c where t.dedupe_key like 'creance:' || c.client_id || ':%' and c.overdue_xof = 0)));

  return v_n;
end $$;

-- ─── Décision sur une tâche ──────────────────────────────────────────────────
-- Depuis l'app : p_as_user null, les droits de l'utilisateur connecté s'appliquent.
-- Depuis Telegram : la fonction serveur passe l'utilisateur lié (service_role uniquement).

create or replace function public.decide_task(p_task uuid, p_decision text, p_as_user uuid default null, p_args jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t       tasks;
  v_uid   uuid := auth.uid();
  v_role  user_role;
  v_tool  text;
  a       jsonb;
  v_res   jsonb;
  l       jsonb;
  v_depot text;
begin
  if p_as_user is not null then
    if auth.uid() is not null or coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'Non autorisé' using errcode = '42501';
    end if;
    v_uid := p_as_user;
  end if;
  select role into v_role from profiles where id = v_uid;
  if v_role is null then raise exception 'Utilisateur non identifié' using errcode = '42501'; end if;

  select * into t from tasks where id = p_task for update;
  if not found then raise exception 'Tâche introuvable'; end if;
  if not (v_role = 'admin' or v_role = any(t.audience)) then raise exception 'Tâche non accessible' using errcode = '42501'; end if;
  if t.status <> 'ouverte' then
    return jsonb_build_object('status', t.status, 'message', 'Déjà traitée');
  end if;

  if p_decision <> 'valider' then
    update tasks set status = 'refusee', decided_by = v_uid, decided_at = now() where id = t.id;
    return jsonb_build_object('status', 'refusee');
  end if;

  v_tool := t.action->>'tool';
  a := coalesce(p_args, t.action->'args', '{}'::jsonb);

  -- Droits par action (vérifiés ici car l'appel Telegram passe en service_role)
  if v_tool in ('bon_commande', 'encaissement') and not (v_role in ('manager', 'cfo', 'admin')) then
    raise exception 'Action réservée au manager / finance' using errcode = '42501';
  end if;
  if v_tool = 'reception' and not (v_role in ('magasinier', 'manager', 'admin')) then
    raise exception 'Action réservée au magasinier / manager' using errcode = '42501';
  end if;

  begin
    if v_tool is null then
      v_res := jsonb_build_object('message', 'Pris en compte');
    elsif v_tool = 'bon_commande' then
      v_res := create_purchase_order(a->>'produit', (a->>'quantite')::numeric, a->>'fournisseur', 'Préparé par le moteur DEPOTEK');
    elsif v_tool = 'reception' then
      -- Dépôt : celui indiqué, sinon celui de la personne qui valide
      v_depot := coalesce(nullif(a->>'depot', ''),
                          (select d.code from profiles pr join depots d on d.id = pr.depot_id where pr.id = v_uid));
      v_res := '[]'::jsonb;
      for l in select * from jsonb_array_elements(a->'lignes') loop
        v_res := v_res || receive_lot(
          l->>'produit', (l->>'quantite')::numeric, l->>'lot', v_depot,
          nullif(l->>'expiration', '')::date, null, nullif(l->>'cout_unitaire', '')::numeric,
          coalesce(nullif(upper(a->>'devise'), ''), 'XOF')::currency_code, nullif(a->>'taux_change', '')::numeric,
          a->>'fournisseur', a->>'conteneur', a->>'reference');
      end loop;
    elsif v_tool = 'encaissement' then
      v_res := record_client_payment(a->>'client', (a->>'montant')::bigint,
                 coalesce(nullif(a->>'mode', ''), 'autre')::payment_method, a->>'reference');
    else
      raise exception 'Action inconnue : %', v_tool;
    end if;
  exception when others then
    -- L'action échoue : rien n'est enregistré sauf l'échec sur la tâche
    update tasks set status = 'echec', result = jsonb_build_object('error', sqlerrm), decided_by = v_uid, decided_at = now()
     where id = t.id;
    return jsonb_build_object('status', 'echec', 'error', sqlerrm);
  end;

  update tasks set status = 'validee', result = v_res, decided_by = v_uid, decided_at = now() where id = t.id;
  return jsonb_build_object('status', 'validee', 'result', v_res);
end $$;

-- ─── Déclenchement temps réel ────────────────────────────────────────────────
-- Chaque écriture métier réveille le moteur dans la seconde (appel HTTP asynchrone
-- via pg_net, annulé si la transaction échoue). Sans configuration Vault, ne fait rien.

create or replace function public.tg_wake_engine() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_url    text;
  v_secret text;
begin
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'depotek_url';
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'depotek_cron_secret';
    if v_url is not null and v_secret is not null then
      perform net.http_post(
        url := v_url || '/functions/v1/engine',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
        body := jsonb_build_object('reason', tg_table_name),
        timeout_milliseconds := 30000);
    end if;
  exception when others then
    null;  -- le moteur ne doit jamais bloquer une opération métier
  end;
  return null;
end $$;

create trigger wake_engine_movements after insert on public.stock_movements
  for each statement execute function public.tg_wake_engine();
create trigger wake_engine_payments after insert on public.payments
  for each statement execute function public.tg_wake_engine();
create trigger wake_engine_documents after insert on public.documents
  for each statement execute function public.tg_wake_engine();

-- ─── Sécurité ────────────────────────────────────────────────────────────────

alter table public.tasks              enable row level security;
alter table public.purchase_orders    enable row level security;
alter table public.documents          enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.telegram_links     enable row level security;

create policy tasks_read on public.tasks for select to authenticated
  using (public.has_role('admin') or public.app_role() = any(audience));
create policy po_read on public.purchase_orders for select to authenticated using (public.has_role('manager', 'cfo'));
create policy po_update on public.purchase_orders for update to authenticated
  using (public.has_role('manager', 'cfo')) with check (public.has_role('manager', 'cfo'));
create policy documents_read on public.documents for select to authenticated
  using (uploaded_by = auth.uid() or public.has_role('manager', 'cfo'));
create policy documents_insert on public.documents for insert to authenticated
  with check (uploaded_by = auth.uid() and source = 'app');
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tg_links_own on public.telegram_links for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.tasks, public.purchase_orders, public.documents, public.push_subscriptions, public.telegram_links from anon, authenticated;
grant select on public.tasks, public.purchase_orders, public.documents to authenticated;
grant update (status, notes) on public.purchase_orders to authenticated;
grant insert (storage_path, mime, source, uploaded_by) on public.documents to authenticated;
grant select, insert, delete on public.push_subscriptions, public.telegram_links to authenticated;
grant all on public.tasks, public.purchase_orders, public.documents, public.push_subscriptions, public.telegram_links to service_role;

revoke execute on function public.engine_scan(), public.tg_wake_engine() from public, anon, authenticated;
grant execute on function public.engine_scan() to service_role;
grant execute on function public.decide_task(uuid, text, uuid, jsonb), public.create_purchase_order(text, numeric, text, text) to authenticated, service_role;
grant execute on function public.dispatch_fefo(text, numeric, text, text, bigint, integer, boolean, boolean, text) to authenticated;
