import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

// Nouveau DEPOTEK (Supabase) par défaut.
// L'ancienne app Firebase reste disponible avec VITE_LEGACY_FIREBASE=true (le temps de la transition).
// Remplacé à la compilation : l'ancienne app n'est incluse dans le build que si demandée.
const legacy = import.meta.env.VITE_LEGACY_FIREBASE === 'true';

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
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => console.log('SW registration failed: ', err));
    if (legacy) {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}firebase-messaging-sw.js`).catch((err) => console.log('FCM SW registration failed: ', err));
    }
  });
}
