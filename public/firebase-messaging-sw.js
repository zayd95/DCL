
// Scripts for firebase and firebase messaging
importScripts('https://www.gstatic.com/firebasejs/9.22.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.1/firebase-messaging-compat.js');

// Initialize the Firebase app in the service worker by passing in
// your app's Firebase config object.
// We'll fetch the config from the server as it needs to be dynamic or we can hardcode it if we must.
// In AI Studio, we can fetch it from the same origin.
const firebaseConfig = {
  apiKey: "AIzaSyBXcFVuB5V9rdJqZBHuqmq0m2uH9zgquE8",
  projectId: "nattoo-ae0fe",
  messagingSenderId: "1082884476954",
  appId: "1:1082884476954:web:9a3233f21b27ec0bbd41a3"
};

firebase.initializeApp(firebaseConfig);

// Retrieve an instance of Firebase Messaging so that it can handle background messages.
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/pwa-192x192.png' || '/favicon.ico'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
