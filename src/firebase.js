/**
 * ============================================================================
 * FIREBASE
 * ============================================================================
 * Initializes the Firebase app, Auth, and Firestore used to sync a signed-in
 * user's data (tasks, boards, settings) across devices. See AuthContext.jsx
 * for the sign-in flow and services/firestoreSync.js for the actual
 * read/write of app data.
 *
 * Config values below are the standard Firebase web app keys — these are NOT
 * secrets (they identify the project, not authorize access; real access
 * control lives in Firestore security rules), so it's normal for Firebase
 * apps to ship them directly in client code same as this project's other
 * public client IDs (see VITE_GOOGLE_CLIENT_ID).
 * ============================================================================
 */

import { initializeApp } from 'firebase/app';
import { getAuth, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: 'AIzaSyDQYZNYMuTb16jDE58viFAUcUv4N2izQi8',
  authDomain: 'storagetrackerapp-7bc55.firebaseapp.com',
  databaseURL: 'https://storagetrackerapp-7bc55-default-rtdb.firebaseio.com',
  projectId: 'storagetrackerapp-7bc55',
  storageBucket: 'storagetrackerapp-7bc55.firebasestorage.app',
  messagingSenderId: '377055073196',
  appId: '1:377055073196:web:b88abef9f219f791d7e009',
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
// Asserted explicitly (rather than relying on the SDK's implicit default) so
// a signed-in session survives a full browser close/reopen, not just a page
// refresh — the underlying default already matches this, but making it
// explicit documents the requirement in code.
setPersistence(auth, browserLocalPersistence);
export const db = getFirestore(app);
export const storage = getStorage(app);
