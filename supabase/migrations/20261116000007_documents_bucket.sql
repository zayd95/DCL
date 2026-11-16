-- Stockage privé des documents scannés (factures, bons, reçus).
-- Chaque utilisateur dépose dans son propre dossier {user_id}/… ; le moteur lit avec le service_role.
do $$ begin
  if to_regclass('storage.buckets') is null then return; end if;  -- Postgres nu (tests locaux)
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('documents', 'documents', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
  on conflict (id) do nothing;

  execute $p$create policy "documents_upload_own" on storage.objects for insert to authenticated
    with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
  execute $p$create policy "documents_read_own" on storage.objects for select to authenticated
    using (bucket_id = 'documents' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role('manager', 'cfo')))$p$;
end $$;
