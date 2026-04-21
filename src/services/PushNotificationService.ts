
import { messaging, db, auth } from '../lib/firebase';
import { getToken, onMessage } from 'firebase/messaging';
import { doc, setDoc, arrayUnion, updateDoc } from 'firebase/firestore';

// VAPID KEY from Firebase Console -> Project Settings -> Cloud Messaging -> Web Push certificates
// If not setup, FCM will still work on some browsers but this is recommended.
// For AI Studio, we'll try to get it from the config or use a generic one if it works.
const VAPID_KEY = "BK9wZ_Yx7Hk-XmE-g_0f6t_F4Y-K7H_oU7-N_f-Q-W-R-V-S-T-U-V-W-X-Y-Z"; // Replace with real if possible

export const requestNotificationPermission = async () => {
  if (!messaging) return;

  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      console.log('Notification permission granted.');
      const token = await getToken(messaging, { 
        vapidKey: VAPID_KEY // FCM uses this for identification
      });
      
      if (token) {
        console.log('FCM Token:', token);
        if (auth.currentUser) {
          // Store token in Firestore for the current user
          const userRef = doc(db, 'users', auth.currentUser.uid);
          await setDoc(userRef, {
            fcm_tokens: arrayUnion(token),
            pushNotificationsEnabled: true,
            email: auth.currentUser.email,
            lastUpdated: new Date()
          }, { merge: true });
        }
        return token;
      }
    } else {
      console.warn('Unable to get permission to notify.');
    }
  } catch (error) {
    console.error('An error occurred while retrieving token. ', error);
  }
};

export const initMessageListener = () => {
  if (!messaging) return;
  
  onMessage(messaging, (payload) => {
    console.log('Foreground message received:', payload);
    // You can handle foreground messages here, e.g., show a custom toast
    // The browser doesn't automatically show a notification if the app is focused.
  });
};
