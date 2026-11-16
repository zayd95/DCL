-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Sécurité : RLS, droits, création automatique des profils
--
--   magasinier : voit le stock, fait réceptions / sorties / transferts.
--                Ne voit PAS les factures, paiements ni coûts agrégés.
--   manager    : tout le stock + ventes + clients + inventaires.
--   cfo        : finances (factures, paiements, créances, marges).
--   admin      : tout, y compris la gestion des utilisateurs.
-- Les tables du grand livre ne sont jamais modifiables directement :
-- uniquement via les fonctions métier (SECURITY DEFINER).
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.has_role(variadic p_roles public.user_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() = 'admin' or public.app_role() = any(p_roles), false)
$$;

-- Profil créé à l'inscription. Le tout premier utilisateur devient admin.
create or replace function public.tg_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, phone, role)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email, ''), '@', 1)),
          new.phone,
          case when exists (select 1 from public.profiles) then 'magasinier' else 'admin' end::public.user_role);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_new_user();

-- ─── RLS ─────────────────────────────────────────────────────────────────────

alter table public.profiles              enable row level security;
alter table public.depots                enable row level security;
alter table public.storage_units         enable row level security;
alter table public.suppliers             enable row level security;
alter table public.products              enable row level security;
alter table public.clients               enable row level security;
alter table public.lots                  enable row level security;
alter table public.stock_movements       enable row level security;
alter table public.stock_balances        enable row level security;
alter table public.invoice_counters      enable row level security;
alter table public.invoices              enable row level security;
alter table public.invoice_lines         enable row level security;
alter table public.payments              enable row level security;
alter table public.storage_contracts     enable row level security;
alter table public.storage_pallet_events enable row level security;
alter table public.storage_billing_runs  enable row level security;
alter table public.alerts                enable row level security;
alter table public.assistant_actions     enable row level security;

-- Profils
create policy profiles_self_read  on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role('manager', 'cfo'));
create policy profiles_self_edit  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = public.app_role());  -- on ne change pas son propre rôle
create policy profiles_admin_all  on public.profiles for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Référentiels : lecture pour tous les utilisateurs, écriture manager/admin
create policy depots_read         on public.depots        for select to authenticated using (true);
create policy depots_write        on public.depots        for all    to authenticated using (public.has_role('manager')) with check (public.has_role('manager'));
create policy units_read          on public.storage_units for select to authenticated using (true);
create policy units_write         on public.storage_units for all    to authenticated using (public.has_role('manager')) with check (public.has_role('manager'));
create policy suppliers_read      on public.suppliers     for select to authenticated using (true);
create policy suppliers_write     on public.suppliers     for all    to authenticated using (public.has_role('manager', 'cfo')) with check (public.has_role('manager', 'cfo'));
create policy products_read       on public.products      for select to authenticated using (true);
create policy products_write      on public.products      for all    to authenticated using (public.has_role('manager')) with check (public.has_role('manager'));
create policy clients_read        on public.clients       for select to authenticated using (true);
create policy clients_write       on public.clients       for all    to authenticated using (public.has_role('manager', 'cfo')) with check (public.has_role('manager', 'cfo'));

-- Stock : lecture pour tous, aucune écriture directe
create policy lots_read           on public.lots            for select to authenticated using (true);
create policy movements_read      on public.stock_movements for select to authenticated using (true);
create policy balances_read       on public.stock_balances  for select to authenticated using (true);

-- Finances : manager / cfo / admin
create policy invoices_read       on public.invoices      for select to authenticated using (public.has_role('manager', 'cfo'));
create policy invoice_lines_read  on public.invoice_lines for select to authenticated using (public.has_role('manager', 'cfo'));
create policy payments_read       on public.payments      for select to authenticated using (public.has_role('manager', 'cfo'));
create policy contracts_read      on public.storage_contracts for select to authenticated using (true);
create policy contracts_write     on public.storage_contracts for all to authenticated using (public.has_role('manager', 'cfo')) with check (public.has_role('manager', 'cfo'));
create policy pallets_read        on public.storage_pallet_events for select to authenticated using (true);
create policy billing_runs_read   on public.storage_billing_runs  for select to authenticated using (public.has_role('manager', 'cfo'));

-- Alertes : les créances ne sont visibles que des rôles finance
create policy alerts_read on public.alerts for select to authenticated
  using (kind <> 'creance' or public.has_role('manager', 'cfo'));
create policy alerts_mark_read on public.alerts for update to authenticated
  using (kind <> 'creance' or public.has_role('manager', 'cfo'));

-- Actions de l'assistant : chacun les siennes
create policy actions_own on public.assistant_actions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── Droits ──────────────────────────────────────────────────────────────────

revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from anon, public;
revoke all on all sequences in schema public from anon;

-- Par défaut Supabase donne tous les droits à authenticated : on restreint
revoke all on all tables in schema public from authenticated;
grant usage on schema public to authenticated, service_role;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.depots, public.storage_units, public.suppliers, public.products,
                                public.clients, public.storage_contracts to authenticated;
grant update on public.profiles to authenticated;
grant update (read_at) on public.alerts to authenticated;
grant insert, update on public.assistant_actions to authenticated;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant execute on function
  public.app_role(), public.has_role(public.user_role[]),
  public.create_client(text, text, public.client_type, bigint, integer, text),
  public.receive_lot(text, numeric, text, text, date, date, numeric, public.currency_code, numeric, text, text, text, text, text),
  public.dispatch_fefo(text, numeric, text, text, bigint, integer, boolean, boolean, text),
  public.transfer_stock(text, numeric, text, text),
  public.adjust_stock(text, text, numeric, text, text, boolean),
  public.record_payment(text, bigint, public.payment_method, text),
  public.record_client_payment(text, bigint, public.payment_method, text),
  public.storage_pallets(text, integer, text),
  public.bill_storage(date),
  public.sales_summary(date, date),
  public.daily_briefing(date)
to authenticated;

grant execute on all functions in schema public to service_role;

-- Les nouvelles fonctions créées plus tard ne doivent pas être exécutables par anon par défaut
alter default privileges in schema public revoke execute on functions from anon, public;
