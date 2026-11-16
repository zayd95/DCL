-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Tâches planifiées (déjà appliqué sur le projet "depotek").
-- À exécuter UNE fois dans SQL Editor pour un nouveau projet, en remplaçant <PROJECT_REF>.
-- Le secret du déclencheur est généré aléatoirement et stocké chiffré dans Vault :
-- rien à saisir à la main. Dakar = UTC, les heures sont donc aussi l'heure de Dakar.
-- ═════════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'depotek_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'depotek_cron_secret');
  end if;
  if not exists (select 1 from vault.secrets where name = 'depotek_url') then
    perform vault.create_secret('https://<PROJECT_REF>.supabase.co', 'depotek_url');
  end if;
end $$;

-- Vérifié par l'Edge Function daily-briefing (service_role uniquement)
create or replace function public.verify_cron_secret(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'depotek_cron_secret' and decrypted_secret = p)
$$;
revoke execute on function public.verify_cron_secret(text) from public, anon, authenticated;
grant execute on function public.verify_cron_secret(text) to service_role;

-- 07:00 — briefing du matin (alertes + message Telegram)
select cron.schedule('depotek-briefing', '0 7 * * *', $cron$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'depotek_url') || '/functions/v1/daily-briefing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'depotek_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000)
$cron$);

-- 8 h – 20 h — alertes FEFO / réappro / impayés dans l'app
select cron.schedule('depotek-alerts', '0 8-20 * * *', $cron$ select public.generate_alerts() $cron$);

-- Le 1er du mois à 06:00 — facturation du stockage froid du mois précédent
select cron.schedule('depotek-storage-billing', '0 6 1 * *', $cron$ select public.bill_storage() $cron$);

-- Vérifier :   select * from cron.job;
-- Historique : select * from cron.job_run_details order by start_time desc limit 20;
