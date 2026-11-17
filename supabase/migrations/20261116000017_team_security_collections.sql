-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Équipe, sécurité et recouvrement
--   • Profil enrichi (email, photo Google, dernière connexion).
--   • Tout nouveau compte (email ou Google) est EN ATTENTE : aucun accès aux
--     données tant qu'un administrateur ne l'a pas validé.
--   • Rôle et activation modifiables seulement par un admin, via admin_set_user().
--   • Recouvrement : notes de relance et promesses de paiement ; le moteur signale
--     une promesse non tenue.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 1. Profils ──────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists email        text,
  add column if not exists avatar_url   text,
  add column if not exists active       boolean not null default false,
  add column if not exists approved_by  uuid references auth.users(id),
  add column if not exists approved_at  timestamptz,
  add column if not exists last_seen_at timestamptz;

update public.profiles p set active = true where approved_at is null and not active;   -- comptes existants : déjà validés
update public.profiles p set
  email = coalesce(p.email, u.email),
  avatar_url = coalesce(p.avatar_url, u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
  from auth.users u where u.id = p.id;

-- Un compte non validé n'a aucun rôle : toutes les règles d'accès le bloquent
create or replace function public.app_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;
grant execute on function public.is_member() to authenticated;

-- Lectures réservées aux membres validés
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public' and cmd = 'SELECT' and qual = 'true'
              and tablename in ('app_settings','clients','depots','lots','products','stock_balances','stock_movements',
                                'storage_contracts','storage_pallet_events','storage_units','suppliers')
  loop
    execute format('alter policy %I on public.%I using (public.is_member())', r.policyname, r.tablename);
  end loop;
end $$;

-- Nouveau compte : profil créé depuis Google ou l'email, en attente de validation
create or replace function public.tg_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_first boolean := not exists (select 1 from public.profiles);
begin
  insert into public.profiles (id, full_name, phone, role, email, avatar_url, active, approved_at)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), nullif(new.raw_user_meta_data->>'name', ''),
                   split_part(coalesce(new.email, ''), '@', 1)),
          new.phone,
          case when v_first then 'admin' else 'magasinier' end::public.user_role,
          new.email,
          coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
          v_first,
          case when v_first then now() end);
  return new;
end $$;

-- Email et photo suivent le compte (ex. photo Google mise à jour)
create or replace function public.tg_user_updated() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set
    email = new.email,
    avatar_url = coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture', avatar_url)
  where id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email, raw_user_meta_data on auth.users
  for each row execute function public.tg_user_updated();

-- Chacun ne modifie que son nom et son téléphone ; rôle/activation passent par l'admin
revoke update on public.profiles from authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
alter policy profiles_self_edit on public.profiles with check (id = auth.uid());
-- Un compte en attente peut lire son propre profil (pour afficher l'écran d'attente)
alter policy profiles_self_read on public.profiles
  using (id = auth.uid() or public.has_role('manager', 'cfo'));

create or replace function public.admin_set_user(
  p_user uuid, p_role public.user_role default null, p_active boolean default null, p_depot uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v profiles;
begin
  perform require_role('admin');
  select * into v from profiles where id = p_user for update;
  if not found then raise exception 'Utilisateur introuvable'; end if;
  if p_user = auth.uid() and (p_active is false or (p_role is not null and p_role <> 'admin')) then
    raise exception 'Vous ne pouvez pas vous retirer vos propres droits d''administrateur';
  end if;
  if v.role = 'admin' and (p_active is false or (p_role is not null and p_role <> 'admin'))
     and (select count(*) from profiles where role = 'admin' and active and id <> p_user) = 0 then
    raise exception 'Il doit rester au moins un administrateur actif';
  end if;
  update profiles set
    role = coalesce(p_role, role),
    active = coalesce(p_active, active),
    depot_id = coalesce(p_depot, depot_id),
    approved_by = case when p_active and not v.active then auth.uid() else approved_by end,
    approved_at = case when p_active and not v.active then now() else approved_at end
  where id = p_user returning * into v;
  -- Compte désactivé : plus aucune notification (Telegram, iPhone)
  if p_active is false then
    update profiles set telegram_chat_id = null where id = p_user;
    delete from push_subscriptions where user_id = p_user;
    delete from telegram_links where user_id = p_user;
  end if;
  return jsonb_build_object('id', v.id, 'role', v.role, 'active', v.active);
end $$;
revoke execute on function public.admin_set_user(uuid, public.user_role, boolean, uuid) from public, anon;
grant execute on function public.admin_set_user(uuid, public.user_role, boolean, uuid) to authenticated;

-- Validation depuis Telegram : seul un compte actif peut décider
do $$
declare v_src text;
begin
  select pg_get_functiondef('public.decide_task(uuid, text, uuid, jsonb)'::regprocedure) into v_src;
  if position('where id = v_uid and active' in v_src) = 0 then
    v_src := replace(v_src, 'select role into v_role from profiles where id = v_uid;', 'select role into v_role from profiles where id = v_uid and active;');
    execute v_src;
  end if;
end $$;

-- Équipe : visible par tout membre ; email et connexions réservés à l'admin
create or replace function public.team() returns table (
  id uuid, full_name text, role public.user_role, active boolean, avatar_url text, depot text,
  email text, last_sign_in_at timestamptz, last_seen_at timestamptz, created_at timestamptz, provider text
) language plpgsql stable security definer set search_path = public as $$
declare v_admin boolean := public.has_role('admin');
begin
  if not public.is_member() then raise exception 'Compte en attente de validation'; end if;
  return query
    select p.id, p.full_name, p.role, p.active, p.avatar_url, d.name,
           case when v_admin or p.id = auth.uid() then p.email end,
           case when v_admin or p.id = auth.uid() then u.last_sign_in_at end,
           case when v_admin or p.id = auth.uid() then p.last_seen_at end,
           p.created_at,
           case when v_admin or p.id = auth.uid() then u.raw_app_meta_data->>'provider' end
      from profiles p join auth.users u on u.id = p.id left join depots d on d.id = p.depot_id
     where p.active or v_admin
     order by p.active desc, (p.role = 'admin') desc, (p.role = 'manager') desc, p.full_name;
end $$;
revoke execute on function public.team() from public, anon;
grant execute on function public.team() to authenticated;

create or replace function public.touch_last_seen() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;
revoke execute on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

-- Le moteur prévient l'admin qu'un compte attend sa validation
create or replace function public.tg_notify_pending_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not new.active then
    insert into tasks (kind, severity, title, body, audience, dedupe_key)
    values ('equipe', 'warning', 'Nouveau compte à valider : ' || coalesce(nullif(new.full_name, ''), new.email, 'utilisateur'),
            coalesce(new.email, '') || ' demande l''accès à DEPOTEK. Validez-le et choisissez son rôle dans Réglages › Équipe, ou refusez-le.',
            '{admin}', 'compte:' || new.id)
    on conflict (dedupe_key) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists on_profile_pending on public.profiles;
create trigger on_profile_pending after insert on public.profiles
  for each row execute function public.tg_notify_pending_user();

-- ─── 2. Recouvrement : relances et promesses de paiement ─────────────────────
create table if not exists public.collection_notes (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients(id) on delete cascade,
  kind             text not null default 'note' check (kind in ('note', 'appel', 'whatsapp', 'visite', 'promesse')),
  note             text,
  promised_date    date,
  promised_xof     bigint check (promised_xof is null or promised_xof > 0),
  status           text not null default 'ouverte' check (status in ('ouverte', 'tenue', 'non_tenue')),
  created_by       uuid references auth.users(id) default auth.uid(),
  created_at       timestamptz not null default now()
);
create index if not exists collection_notes_client_idx on public.collection_notes (client_id, created_at desc);
alter table public.collection_notes enable row level security;
create policy collection_rw on public.collection_notes for all to authenticated
  using (public.has_role('manager', 'cfo')) with check (public.has_role('manager', 'cfo'));
grant select, insert, update on public.collection_notes to authenticated;

-- Une promesse tenue se clôt seule dès que le client a payé ; sinon tâche le lendemain de l'échéance
create or replace function public.engine_scan_promises() returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer := 0;
begin
  update collection_notes n set status = 'tenue'
   where n.kind = 'promesse' and n.status = 'ouverte'
     and coalesce((select sum(pa.amount_xof) from payments pa join invoices i on i.id = pa.invoice_id
                    where i.client_id = n.client_id and pa.created_at >= n.created_at), 0) >= coalesce(n.promised_xof, 1);

  insert into tasks (kind, severity, title, body, audience, dedupe_key)
  select 'creance', 'warning', 'Promesse non tenue : ' || c.name,
         'Promesse de ' || coalesce(to_char(n.promised_xof, 'FM999G999G999G990') || ' FCFA', 'paiement') ||
         ' pour le ' || to_char(n.promised_date, 'DD/MM/YYYY') || ', non reçue. Solde actuel : ' ||
         to_char(coalesce(b.balance_xof, 0), 'FM999G999G999G990') || ' FCFA.',
         '{manager,cfo,admin}', 'promesse:' || n.id
    from collection_notes n join clients c on c.id = n.client_id
    left join v_client_balances b on b.client_id = c.id
   where n.kind = 'promesse' and n.status = 'ouverte' and n.promised_date < current_date
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  update collection_notes set status = 'non_tenue'
   where kind = 'promesse' and status = 'ouverte' and promised_date < current_date - 7;
  return v_n;
end $$;
revoke execute on function public.engine_scan_promises() from public, anon, authenticated;
grant execute on function public.engine_scan_promises() to service_role;

do $$
declare v_src text;
begin
  select pg_get_functiondef('public.engine_scan()'::regprocedure) into v_src;
  if position('engine_scan_promises' in v_src) = 0 then
    v_src := replace(v_src, E'  return v_n;\nend', E'  v_n := v_n + engine_scan_promises();\n  return v_n;\nend');
    execute v_src;
  end if;
end $$;

-- La démo efface aussi ses notes de recouvrement (clients démo : on delete cascade)
