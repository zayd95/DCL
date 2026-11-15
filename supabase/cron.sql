-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Tâches planifiées (à exécuter UNE fois dans Supabase → SQL Editor,
-- après avoir déployé les Edge Functions).
-- Remplacer <PROJECT_REF> et <CRON_SECRET> (même valeur que le secret de la fonction).
-- Dakar = UTC : les heures ci-dessous sont donc aussi l'heure de Dakar.
-- ═════════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Secrets stockés dans le coffre Supabase (Vault), pas en clair dans les jobs
select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'depotek_url');
select vault.create_secret('<CRON_SECRET>', 'depotek_cron_secret');

-- 07:00 — briefing du matin (alertes + message Telegram)
select cron.schedule('depotek-briefing', '0 7 * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'depotek_url') || '/functions/v1/daily-briefing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'depotek_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000)
$$);

-- Toutes les heures (8 h – 20 h) — alertes FEFO / réappro / impayés dans l'app
select cron.schedule('depotek-alerts', '0 8-20 * * *', $$ select public.generate_alerts() $$);

-- Le 1er du mois à 06:00 — facturation du stockage froid du mois précédent
select cron.schedule('depotek-storage-billing', '0 6 1 * *', $$ select public.bill_storage() $$);

-- Vérifier :   select * from cron.job;
-- Historique : select * from cron.job_run_details order by start_time desc limit 20;
