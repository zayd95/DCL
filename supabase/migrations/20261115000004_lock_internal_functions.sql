-- Fonctions internes : appelées uniquement par les fonctions métier (SECURITY DEFINER), le cron ou le serveur.
-- (Supabase accorde EXECUTE à authenticated par défaut : sans ceci, n'importe quel utilisateur
--  pourrait par exemple appeler next_invoice_number() et créer des trous dans la numérotation.)
revoke execute on function
  public.require_role(public.user_role[]),
  public.resolve_product(text),
  public.resolve_depot(text),
  public.resolve_client(text),
  public.next_invoice_number(public.invoice_kind),
  public.storage_pallet_days(uuid, timestamptz, timestamptz),
  public.generate_alerts(),
  public.tg_new_user(),
  public.tg_apply_movement(),
  public.tg_immutable(),
  public.tg_payment_rollup()
from authenticated, anon, public;

-- Toute future fonction devra être ouverte explicitement aux utilisateurs
alter default privileges in schema public revoke execute on functions from authenticated;

comment on table public.invoice_counters is 'Interne : compteurs de numérotation des factures, accessible uniquement via next_invoice_number().';
