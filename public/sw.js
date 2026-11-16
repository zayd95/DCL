// Service worker DEPOTEK
// - Pages : réseau d'abord (toujours la dernière version), cache seulement hors ligne.
// - Fichiers /assets/* (nom avec empreinte, immuables) : cache d'abord.
// - Jamais d'interception des appels API (Supabase, Gemini…) : données toujours fraîches.
const CACHE_NAME = 'depotek-v2';
const BASE = new URL('./', self.location).pathname; // '/' ou '/DCL/' selon l'hébergement

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll([BASE, BASE + 'manifest.json'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(BASE, copy));
          return res;
        })
        .catch(() => caches.match(BASE)),
    );
    return;
  }

  if (url.pathname.startsWith(BASE + 'assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      })),
    );
  }
});

// ─── Notifications du moteur DEPOTEK ─────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'DEPOTEK', body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'DEPOTEK', {
    body: data.body || '',
    tag: data.tag,
    data: { url: data.url || BASE },
    icon: BASE + 'icon-192.png',
    badge: BASE + 'icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || BASE;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.location.origin + BASE));
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
