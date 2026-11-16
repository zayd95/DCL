-- Reproduit le strict minimum de Supabase (rôles, schéma auth) pour tester
-- les migrations sur un Postgres nu. NE PAS exécuter sur Supabase.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text, phone text,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select current_setting('request.jwt.claims', true)::jsonb->>'role'
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create publication supabase_realtime;
-- Vault minimal (secrets en clair : uniquement pour les tests)
create schema vault;
create table vault.secrets (name text primary key, secret text);
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(p_secret text, p_name text) returns uuid language sql as $$
  insert into vault.secrets values (p_name, p_secret); select gen_random_uuid() $$;
