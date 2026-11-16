-- Clés VAPID des notifications iPhone : générées par l'Edge Function engine au premier
-- passage et rangées chiffrées dans Vault. Aucune clé n'est saisie ni vue à la main.
create or replace function public.vapid_keys() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'public',  (select decrypted_secret from vault.decrypted_secrets where name = 'depotek_vapid_public'),
    'private', (select decrypted_secret from vault.decrypted_secrets where name = 'depotek_vapid_private'))
$$;

create or replace function public.vapid_store(p_public text, p_private text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from vault.secrets where name = 'depotek_vapid_public') then return; end if;
  perform vault.create_secret(p_public, 'depotek_vapid_public');
  perform vault.create_secret(p_private, 'depotek_vapid_private');
end $$;

-- Clé publique seulement, pour l'abonnement côté navigateur
create or replace function public.vapid_public_key() returns text
language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'depotek_vapid_public'
$$;

revoke execute on function public.vapid_keys(), public.vapid_store(text, text), public.vapid_public_key() from public, anon, authenticated;
grant execute on function public.vapid_keys(), public.vapid_store(text, text) to service_role;
grant execute on function public.vapid_public_key() to authenticated, service_role;

-- Ronde du moteur toutes les 15 minutes (en plus des réveils temps réel)
do $$ begin
  if to_regclass('cron.job') is null then return; end if;
  perform cron.schedule('depotek-engine', '*/15 * * * *', $cron$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'depotek_url') || '/functions/v1/engine',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'depotek_cron_secret')),
      body    := '{"reason":"ronde"}'::jsonb,
      timeout_milliseconds := 60000)
  $cron$);
end $$;
