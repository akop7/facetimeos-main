'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { auth, googleProvider, isAuthConfigured } from '../lib/firebase';

/**
 * Accounts are required to create or join a room — but the requirement lives in
 * the pages, not here, and it is conditional on `authAvailable`.
 *
 * Two things this provider deliberately does not do, both of which it used to:
 *
 * 1. It does not render `{!loading && children}`. With no Firebase project
 *    `loading` never cleared, so the whole app was a blank page. `loading` now
 *    starts as `isAuthConfigured`, i.e. the answer rather than something an
 *    effect has to come back and correct.
 * 2. It does not redirect anyone itself. A page decides what to show while
 *    `user` is null; the room page shows a sign-in screen so an invite link
 *    still resolves to something meaningful instead of bouncing to the home page.
 *
 * `authAvailable` is what makes the gate honest: with no auth provider wired up
 * there is no way to satisfy a login requirement, so the pages skip it and say
 * so rather than locking every door. Note too that this is a product rule, not a
 * security boundary — room capabilities are enforced by the signaling server's
 * signed session and invite tokens, which know nothing about Firebase identity.
 */

const AuthContext = createContext({
  user: null,
  loading: false,
  authAvailable: false,
  displayName: '',
});

const NAME_KEY = 'ftos.displayName';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // With no Firebase project there is nothing to wait for, so the initial value
  // is the answer rather than something an effect has to come back and correct.
  const [loading, setLoading] = useState(isAuthConfigured);

  useEffect(() => {
    if (!auth) return undefined;
    return onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser?.displayName) {
        try {
          window.localStorage.setItem(NAME_KEY, currentUser.displayName);
        } catch {
          /* Private mode; the name just is not remembered. */
        }
      }
      setLoading(false);
    });
  }, []);

  const requireAuth = () => {
    if (!auth) throw new Error('Accounts are not enabled on this deployment.');
    return auth;
  };

  const login = useCallback((email, password) =>
    signInWithEmailAndPassword(requireAuth(), email, password), []);

  const signup = useCallback(async (email, password, displayName) => {
    const result = await createUserWithEmailAndPassword(requireAuth(), email, password);
    await updateProfile(result.user, { displayName });
    return result;
  }, []);

  /**
   * Google sign-in, by two different routes.
   *
   * In a browser this is `signInWithPopup`. In the Windows desktop shell it cannot
   * be: Google refuses OAuth inside an embedded user agent, so the popup would
   * load `disallowed_useragent` and stop there. The shell therefore runs the
   * native-app flow (RFC 8252 — authorization code with PKCE, in the user's real
   * browser, redirect caught on loopback) and hands back a Google ID token, which
   * becomes an ordinary Firebase credential here.
   *
   * Same provider, same uid, same account as on the web. The branch is a feature
   * check rather than a user-agent sniff, so the web build is untouched by it.
   */
  const loginWithGoogle = useCallback(async () => {
    const windowsApp = typeof window !== 'undefined' ? window.faceTimeWindows : null;
    if (windowsApp?.signIn) {
      const { customToken } = await windowsApp.signIn();
      if (!customToken) throw new Error('Sign-in did not complete.');
      return signInWithCustomToken(requireAuth(), customToken);
    }
    const desktop = typeof window !== 'undefined' ? window.facetimeosDesktop : null;
    if (desktop?.signInWithGoogle) {
      const { idToken } = await desktop.signInWithGoogle();
      if (!idToken) throw new Error('Sign-in did not complete.');
      return signInWithCredential(requireAuth(), GoogleAuthProvider.credential(idToken));
    }
    if (!googleProvider) throw new Error('Google sign-in is not enabled on this deployment.');
    return signInWithPopup(requireAuth(), googleProvider);
  }, []);

  const logout = useCallback(() => (auth ? signOut(auth) : Promise.resolve()), []);

  const value = useMemo(
    () => ({
      user,
      loading,
      authAvailable: Boolean(auth),
      displayName: user?.displayName || '',
      login,
      signup,
      loginWithGoogle,
      logout,
    }),
    [user, loading, login, signup, loginWithGoogle, logout]
  );

  // Children always render. Blocking on `loading` meant a misconfigured project
  // showed nothing at all, and a room link is exactly the case where you want
  // the page to come up regardless.
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
