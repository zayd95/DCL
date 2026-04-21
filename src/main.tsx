import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { db } from './lib/firebase';
import { doc, getDocFromServer } from 'firebase/firestore';

async function testConnection() {
  try {
    // Testing connection using a path defined in rules (depots)
    await getDocFromServer(doc(db, 'depots', '_health'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration or internet connection.");
    }
  }
}
testConnection();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW registration failed: ', err));
    navigator.serviceWorker.register('/firebase-messaging-sw.js').catch(err => console.log('FCM SW registration failed: ', err));
  });
}
