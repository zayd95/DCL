-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Core schema (Supabase / Postgres)
--
-- Principes :
--   • Le stock est un GRAND LIVRE : stock_movements est immuable (append-only).
--     stock_balances est maintenu par trigger, avec CHECK quantity >= 0
--     → impossible de sortir plus que ce qui existe, même en concurrence.
--   • Toutes les écritures métier passent par des fonctions SQL (RPC) atomiques.
--   • Montants en XOF (entiers). Les coûts d'achat en devise sont convertis
--     au taux figé à l'import.
-- ═════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─── Enums ───────────────────────────────────────────────────────────────────

create type public.user_role      as enum ('magasinier', 'manager', 'cfo', 'admin');
create type public.depot_type     as enum ('frozen', 'chilled', 'dry', 'mixed');
create type public.unit_type      as enum ('carton', 'palette', 'kg', 'tonne', 'litre', 'piece', 'sac');
create type public.currency_code  as enum ('XOF', 'EUR', 'USD');
create type public.movement_type  as enum ('entry', 'exit', 'transfer_out', 'transfer_in', 'adjustment', 'loss');
create type public.client_type    as enum ('grossiste', 'detaillant', 'restaurant', 'supermarche', 'locataire_froid', 'autre');
create type public.invoice_kind   as enum ('vente', 'stockage');
create type public.invoice_status as enum ('brouillon', 'emise', 'partielle', 'payee', 'annulee');
create type public.payment_method as enum ('especes', 'wave', 'orange_money', 'virement', 'cheque', 'autre');
create type public.alert_level    as enum ('info', 'warning', 'critical');

-- ─── Users ───────────────────────────────────────────────────────────────────

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  phone       text,
  role        public.user_role not null default 'magasinier',
  depot_id    uuid,
  telegram_chat_id text,
  created_at  timestamptz not null default now()
);

-- ─── Référentiels ────────────────────────────────────────────────────────────

create table public.depots (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  type             public.depot_type not null default 'mixed',
  address          text,
  lat              double precision,
  lng              double precision,
  capacity_pallets integer,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

alter table public.profiles
  add constraint profiles_depot_fk foreign key (depot_id) references public.depots(id) on delete set null;

-- Chambres froides / zones d'un dépôt (les capteurs s'y rattacheront en phase 2)
create table public.storage_units (
  id               uuid primary key default gen_random_uuid(),
  depot_id         uuid not null references public.depots(id) on delete cascade,
  code             text not null,
  name             text not null,
  kind             public.depot_type not null default 'frozen',
  temp_min_c       numeric(5,1),
  temp_max_c       numeric(5,1),
  capacity_pallets integer,
  active           boolean not null default true,
  unique (depot_id, code)
);

create table public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  country    text,
  contact    text,
  created_at timestamptz not null default now()
);

create table public.products (
  id                 uuid primary key default gen_random_uuid(),
  sku                text not null unique,
  name               text not null,
  category           text not null default 'viande',
  unit_type          public.unit_type not null default 'carton',
  unit_weight_kg     numeric(10,3),
  default_price_xof  bigint check (default_price_xof is null or default_price_xof >= 0),
  min_stock          numeric(14,3) not null default 0,
  lead_time_days     integer not null default 45,   -- délai de réappro (ex. Inde → Dakar)
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

create table public.clients (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  phone               text,
  type                public.client_type not null default 'grossiste',
  credit_limit_xof    bigint not null default 0 check (credit_limit_xof >= 0),
  payment_terms_days  integer not null default 0 check (payment_terms_days >= 0),
  notes               text,
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);
create unique index clients_name_uq on public.clients (lower(name));

-- ─── Lots (lot physique importé) ─────────────────────────────────────────────

create table public.lots (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.products(id),
  lot_number        text not null,
  supplier_id       uuid references public.suppliers(id),
  container_no      text,
  invoice_ref       text,
  production_date   date,
  expiry_date       date,
  original_qty      numeric(14,3) not null check (original_qty > 0),
  cost_unit         numeric(14,4),                 -- en devise d'achat
  cost_currency     public.currency_code not null default 'XOF',
  fx_rate_to_xof    numeric(14,6) not null default 1 check (fx_rate_to_xof > 0),
  cost_unit_xof     numeric(14,2) generated always as (cost_unit * fx_rate_to_xof) stored,
  owner_client_id   uuid references public.clients(id),  -- non null = marchandise d'un client (stockage tiers)
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  unique (product_id, lot_number)
);

-- ─── Grand livre du stock ────────────────────────────────────────────────────

create table public.stock_movements (
  id              bigint generated always as identity primary key,
  lot_id          uuid not null references public.lots(id),
  depot_id        uuid not null references public.depots(id),
  storage_unit_id uuid references public.storage_units(id),
  type            public.movement_type not null,
  qty             numeric(14,3) not null check (qty <> 0),  -- signé : + entrée, – sortie
  reason          text,
  client_id       uuid references public.clients(id),
  invoice_id      uuid,
  transfer_ref    uuid,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  constraint movement_sign check (
    (type in ('entry', 'transfer_in') and qty > 0) or
    (type in ('exit', 'transfer_out', 'loss') and qty < 0) or
    (type = 'adjustment')
  )
);
create index stock_movements_lot_idx    on public.stock_movements (lot_id);
create index stock_movements_depot_idx  on public.stock_movements (depot_id, created_at desc);
create index stock_movements_client_idx on public.stock_movements (client_id) where client_id is not null;

create table public.stock_balances (
  lot_id     uuid not null references public.lots(id),
  depot_id   uuid not null references public.depots(id),
  quantity   numeric(14,3) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (lot_id, depot_id)
);
create index stock_balances_active_idx on public.stock_balances (depot_id) where quantity > 0;

create or replace function public.tg_apply_movement() returns trigger
language plpgsql as $$
begin
  -- UPDATE d'abord : la CHECK (quantity >= 0) bloque toute sortie au-delà du stock
  update public.stock_balances
     set quantity = quantity + new.qty, updated_at = now()
   where lot_id = new.lot_id and depot_id = new.depot_id;
  if not found then
    if new.qty < 0 then
      raise exception 'Aucun stock de ce lot dans ce dépôt' using errcode = '23514';
    end if;
    insert into public.stock_balances (lot_id, depot_id, quantity, updated_at)
    values (new.lot_id, new.depot_id, new.qty, now());
  end if;
  return new;
end $$;

create trigger stock_movements_apply
  after insert on public.stock_movements
  for each row execute function public.tg_apply_movement();

create or replace function public.tg_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'Le grand livre est immuable : passez une écriture de correction (adjustment).';
end $$;

create trigger stock_movements_immutable
  before update or delete on public.stock_movements
  for each row execute function public.tg_immutable();

-- ─── Factures & paiements ────────────────────────────────────────────────────

create table public.invoices (
  id           uuid primary key default gen_random_uuid(),
  number       text not null unique,
  kind         public.invoice_kind not null default 'vente',
  client_id    uuid not null references public.clients(id),
  issue_date   date not null default current_date,
  due_date     date not null default current_date,
  status       public.invoice_status not null default 'emise',
  total_xof    bigint not null default 0 check (total_xof >= 0),
  paid_xof     bigint not null default 0 check (paid_xof >= 0),
  period_start date,       -- facturation stockage
  period_end   date,
  notes        text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);
create index invoices_client_idx on public.invoices (client_id, issue_date desc);
create index invoices_open_idx   on public.invoices (due_date) where status in ('emise', 'partielle');

create table public.invoice_counters (
  year  integer not null,
  kind  public.invoice_kind not null,
  last  integer not null default 0,
  primary key (year, kind)
);

alter table public.stock_movements
  add constraint stock_movements_invoice_fk foreign key (invoice_id) references public.invoices(id);

create table public.invoice_lines (
  id              bigint generated always as identity primary key,
  invoice_id      uuid not null references public.invoices(id) on delete cascade,
  product_id      uuid references public.products(id),
  lot_id          uuid references public.lots(id),
  description     text not null,
  qty             numeric(14,3) not null check (qty > 0),
  unit_price_xof  bigint not null check (unit_price_xof >= 0),
  line_total_xof  bigint generated always as (round(qty * unit_price_xof)::bigint) stored,
  cost_xof        bigint   -- coût de revient de la ligne (marge)
);
create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id);

create table public.payments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.invoices(id),
  amount_xof  bigint not null check (amount_xof > 0),
  method      public.payment_method not null default 'especes',
  reference   text,
  paid_at     timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index payments_invoice_idx on public.payments (invoice_id);

-- Recalcule paid_xof et le statut à chaque paiement
create or replace function public.tg_payment_rollup() returns trigger
language plpgsql as $$
declare
  v_paid  bigint;
  v_total bigint;
begin
  select coalesce(sum(amount_xof), 0) into v_paid from public.payments where invoice_id = new.invoice_id;
  select total_xof into v_total from public.invoices where id = new.invoice_id for update;
  if v_paid > v_total then
    raise exception 'Paiement supérieur au solde de la facture (payé %, total %)', v_paid, v_total;
  end if;
  update public.invoices
     set paid_xof = v_paid,
         status = case when v_paid >= v_total then 'payee'::public.invoice_status
                       when v_paid > 0         then 'partielle'::public.invoice_status
                       else status end
   where id = new.invoice_id;
  return new;
end $$;

create trigger payments_rollup
  after insert on public.payments
  for each row execute function public.tg_payment_rollup();

-- ─── Stockage pour tiers (location de froid) ─────────────────────────────────

create table public.storage_contracts (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients(id),
  depot_id               uuid not null references public.depots(id),
  storage_unit_id        uuid references public.storage_units(id),
  rate_pallet_day_xof    bigint not null check (rate_pallet_day_xof >= 0),
  min_monthly_xof        bigint not null default 0,
  start_date             date not null default current_date,
  end_date               date,
  active                 boolean not null default true,
  created_at             timestamptz not null default now()
);

-- Entrées / sorties de palettes d'un locataire (base de calcul palettes × jours)
create table public.storage_pallet_events (
  id           bigint generated always as identity primary key,
  contract_id  uuid not null references public.storage_contracts(id),
  pallets      integer not null check (pallets <> 0),   -- + entrée, – sortie
  happened_at  timestamptz not null default now(),
  note         text,
  created_by   uuid references auth.users(id)
);
create index storage_pallet_events_idx on public.storage_pallet_events (contract_id, happened_at);

create table public.storage_billing_runs (
  contract_id  uuid not null references public.storage_contracts(id),
  period_start date not null,
  invoice_id   uuid not null references public.invoices(id),
  primary key (contract_id, period_start)
);

-- ─── Alertes & actions de l'assistant ────────────────────────────────────────

create table public.alerts (
  id          bigint generated always as identity primary key,
  level       public.alert_level not null default 'warning',
  kind        text not null,                 -- fefo | stock_bas | creance | temperature | ...
  title       text not null,
  body        text not null,
  ref         jsonb not null default '{}'::jsonb,
  dedupe_key  text unique,                   -- évite de répéter la même alerte le même jour
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index alerts_unread_idx on public.alerts (created_at desc) where read_at is null;

create table public.assistant_actions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id),
  tool        text not null,
  args        jsonb not null,
  summary     text not null,
  status      text not null default 'en_attente' check (status in ('en_attente', 'executee', 'annulee', 'echec')),
  result      jsonb,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
