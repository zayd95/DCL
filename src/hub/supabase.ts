import { createClient } from '@supabase/supabase-js';

// Clés publiques par conception (la sécurité repose sur la RLS et les rôles côté base).
// Surchargeables via .env.local : VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env: Record<string, string | undefined> = (import.meta as any).env ?? {};

export const SUPABASE_URL = env.VITE_SUPABASE_URL || 'https://upvxglsoscvqtkdfekpi.supabase.co';
const SUPABASE_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_BG7V4BDEqWZ-p0cXunFZ1w_MKlAqIKU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export type Role = 'magasinier' | 'manager' | 'cfo' | 'admin';

export interface Profile {
  id: string;
  full_name: string;
  role: Role;
  phone: string | null;
  telegram_chat_id: string | null;
  email?: string | null;
  avatar_url?: string | null;
  active?: boolean;
  depot_id?: string | null;
  last_seen_at?: string | null;
}

export const ROLE_LABEL: Record<Role, string> = { magasinier: 'Magasinier', manager: 'Manager', cfo: 'Finance', admin: 'Admin' };

export const canSeeFinance = (r?: Role) => r === 'manager' || r === 'cfo' || r === 'admin';
export const canManage = (r?: Role) => r === 'manager' || r === 'admin';

/** Appelle une fonction métier et renvoie un message d'erreur lisible. */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const { data, error } = await supabase.rpc(fn, clean);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Envoie une photo/PDF (facture, bon de livraison, reçu) : le moteur la lit et propose la saisie dans « À traiter ». */
export async function uploadDocument(userId: string, file: File): Promise<void> {
  const ext = file.type === 'application/pdf' ? 'pdf' : (file.type.split('/')[1] || 'jpg');
  const path = `${userId}/app-${Date.now()}.${ext}`;
  const up = await supabase.storage.from('documents').upload(path, file, { contentType: file.type });
  if (up.error) throw new Error(up.error.message);
  const ins = await supabase.from('documents').insert({ storage_path: path, mime: file.type, source: 'app', uploaded_by: userId });
  if (ins.error) throw new Error(ins.error.message);
}
