import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// Nouveau DEPOTEK (Supabase) par défaut.
// L'ancienne app Firebase reste disponible avec VITE_LEGACY_FIREBASE=true (le temps de la transition).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const legacy = ((import.meta as any).env?.VITE_LEGACY_FIREBASE ?? '') === 'true';

const Root = legacy ? lazy(() => import('./App')) : lazy(() => import('./hub/HubApp'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.log('SW registration failed: ', err));
    if (legacy) {
      navigator.serviceWorker.register('/firebase-messaging-sw.js').catch((err) => console.log('FCM SW registration failed: ', err));
    }
  });
}
