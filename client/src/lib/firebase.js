/**
 * Firebase, made optional.
 *
 * Two problems with the old version. The config was hardcoded in the bundle, so
 * every deployment pointed at one person's project and there was no way to move
 * staging or prod without editing source. And `getAuth()` ran unconditionally at
 * module load, which meant a checkout with no Firebase project crashed on
 * import — while `AuthContext` gated the entire app on a signed-in user and the
 * room page redirected home whenever `user` was null.
 *
 * That combination made the product's core promise impossible: you cannot "send
 * someone a link and collaborate" if the link demands an account first. So auth
 * is now genuinely optional. Configure Firebase and you get accounts and
 * remembered names; leave it unset and `auth` is `null`, every consumer treats
 * that as "signed out, and that is fine", and rooms work as guest sessions
 * authorised by the server-issued session token instead.
 *
 * The web API key is not a secret — access is controlled by Security Rules and
 * the authorized-domains list — but it is still configuration, so it lives in
 * env like everything else.
 */

import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

/** The minimum needed for `getAuth` to do anything useful. */
export const isAuthConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let app = null;
let auth = null;
let googleProvider = null;

if (isAuthConfigured) {
  try {
    app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
    auth = getAuth(app);
    googleProvider = new GoogleAuthProvider();
  } catch (error) {
    // A malformed config should downgrade to guest-only, not take the app down.
    console.warn('[firebase] auth disabled:', error?.message || error);
    app = null;
    auth = null;
    googleProvider = null;
  }
}

export { app, auth, googleProvider };
