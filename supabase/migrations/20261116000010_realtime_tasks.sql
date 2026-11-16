-- Fil « À traiter » mis à jour en direct dans l'app (RLS appliquée)
alter publication supabase_realtime add table public.tasks;
