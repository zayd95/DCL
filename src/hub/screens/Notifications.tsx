import React, { useEffect, useState } from 'react';
import { Bell, Send } from 'lucide-react';
import { supabase, rpc, type Profile } from '../supabase';
import { Button, ErrorNote, Badge } from '../ui';

const toKey = (base64url: string) => {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

/** Réglages des alertes du moteur : notifications iPhone et Telegram. */
export function NotificationSettings({ profile, onChange }: { profile: Profile; onChange: () => void }) {
  const [pushOn, setPushOn] = useState(false);
  const [bot, setBot] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  useEffect(() => {
    supabase.from('app_settings').select('value').eq('key', 'telegram_bot').maybeSingle().then(({ data }) => setBot(data?.value ?? null));
    if (pushSupported) {
      navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((s) => setPushOn(!!s)).catch(() => {});
    }
  }, [pushSupported]);

  const enablePush = async () => {
    setBusy(true); setError(null);
    try {
      const key = await rpc<string | null>('vapid_public_key', {});
      if (!key) throw new Error('Le moteur prépare les clés de notification. Réessayez dans une minute.');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications refusées dans les réglages du téléphone.');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(key) });
      const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await supabase.from('push_subscriptions').delete().eq('endpoint', j.endpoint);
      const { error } = await supabase.from('push_subscriptions')
        .insert({ user_id: profile.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
      if (error) throw error;
      setPushOn(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disablePush = async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
    setPushOn(false);
  };

  const linkTelegram = async () => {
    setError(null);
    const c = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6).toUpperCase();
    await supabase.from('telegram_links').delete().eq('user_id', profile.id);
    const { error } = await supabase.from('telegram_links').insert({ code: c, user_id: profile.id });
    if (error) { setError(error.message); return; }
    setCode(c);
  };

  return (
    <div className="space-y-5">
      <p className="text-body text-text-secondary">
        Le moteur DEPOTEK surveille en continu (stock, lots, paiements, documents) et vous prévient sans ouvrir l’app.
      </p>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-body font-bold flex items-center gap-2"><Bell size={18} /> Notifications iPhone</p>
          {pushOn && <Badge tone="ok">Activées</Badge>}
        </div>
        {!pushSupported || (isIOS() && !isInstalled()) ? (
          <p className="text-caption text-text-secondary bg-surface-subtle rounded-xl p-3">
            Sur iPhone : ouvrez DEPOTEK dans Safari, bouton Partager → « Sur l’écran d’accueil », puis ouvrez l’app depuis
            l’écran d’accueil et revenez ici.
          </p>
        ) : pushOn ? (
          <Button variant="ghost" className="w-full" onClick={disablePush}>Désactiver sur cet appareil</Button>
        ) : (
          <Button className="w-full" disabled={busy} onClick={enablePush}>{busy ? '…' : 'Activer sur cet appareil'}</Button>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-body font-bold flex items-center gap-2"><Send size={18} /> Telegram</p>
          {profile.telegram_chat_id && <Badge tone="ok">Lié</Badge>}
        </div>
        <p className="text-caption text-text-secondary">
          Alertes avec boutons Valider / Refuser, et envoi de factures ou reçus en photo directement au bot.
        </p>
        {!bot ? (
          <p className="text-caption text-text-muted bg-surface-subtle rounded-xl p-3">Le bot Telegram n’est pas encore configuré.</p>
        ) : code ? (
          <a href={`https://t.me/${bot}?start=${code}`} target="_blank" rel="noreferrer" onClick={() => setTimeout(onChange, 15000)}
            className="block text-center w-full rounded-xl px-4 py-3 text-body font-bold bg-status-info text-white">
            Ouvrir @{bot} et appuyer sur « Démarrer »
          </a>
        ) : (
          <Button className="w-full" onClick={linkTelegram}>{profile.telegram_chat_id ? 'Relier un autre compte Telegram' : 'Lier mon Telegram'}</Button>
        )}
      </section>
      <ErrorNote error={error} />
    </div>
  );
}
