-- Le contrôle de sécurité Supabase signalait ces deux fonctions appelables sans connexion
-- (sans effet réel : elles exigent un profil, mais on ferme la porte).
revoke execute on function public.decide_task(uuid, text, uuid, jsonb), public.create_purchase_order(text, numeric, text, text) from anon, public;
alter default privileges in schema public revoke execute on functions from anon;
