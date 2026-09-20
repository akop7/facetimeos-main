'use client';

import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

/**
 * Sign-in gates room creation and joining, but only when there is an auth
 * project to sign in to. So this modal has to cope with Firebase not being
 * configured at all — in that case `login`/`signup`/`loginWithGoogle` throw, and
 * showing the form would just be a dead end. It explains how to enable accounts
 * instead.
 *
 * `onSuccess` receives the freshly signed-in user and fires before `onClose`, so
 * a caller that opened this modal to gate an action can resume that action
 * without waiting for `onAuthStateChanged` to land. `onClose` alone cannot carry
 * that: it is also how the user dismisses the modal.
 */
export default function AuthModal({ isOpen, onClose, onSuccess, reason }) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const { login, signup, loginWithGoogle, authAvailable } = useAuth();

  if (!isOpen) return null;

  const readableError = (err) =>
    String(err?.message || err || 'Something went wrong.')
      .replace('Firebase: ', '')
      .replace(/\(auth\/.*\)/, '')
      .trim();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let result;
      if (isLogin) {
        result = await login(email, password);
      } else {
        if (!displayName.trim()) {
          throw new Error('Display Name is required');
        }
        result = await signup(email, password, displayName);
      }
      onSuccess?.(result?.user ?? null);
      onClose();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await loginWithGoogle();
      onSuccess?.(result?.user ?? null);
      onClose();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-dialog-title"
    >
      <div
        className="dialog-surface relative w-full max-w-[28rem] p-6 animate-scale-in sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]"
          aria-label="Close sign-in dialog"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>

        <div className="mb-6 pr-8">
          <p className="eyebrow mb-4">Account</p>
          <h2 id="auth-dialog-title" className="text-2xl font-semibold tracking-[-0.035em] text-[var(--text-primary)]">
            {!authAvailable ? 'Sign-in is not configured' : isLogin ? 'Sign in to continue' : 'Create your account'}
          </h2>
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          {!authAvailable
            ? 'This build can still open rooms, but account sign-in is currently unavailable.'
            : reason
              ? reason
              : isLogin
                ? 'Use the account connected to your rooms.'
                : 'Your name is shown to other people in the room.'}
          </p>
        </div>

        {!authAvailable ? (
          <>
            <p className="mb-4 text-sm leading-6 text-[var(--text-secondary)]">
              An account is meant to be required before you create or join a room —
              but a requirement nobody can satisfy is just a locked door, so rooms
              keep working here: the server issues your identity when you join. To
              turn the requirement on, copy <code>client/.env.example</code> to{' '}
              <code>client/.env.local</code>, paste your Firebase web config, and restart{' '}
              <code>next dev</code>:
            </p>
            <pre
              className="mb-6 overflow-x-auto rounded-md p-3 font-mono text-[11px] leading-relaxed"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--bg-input-border)',
                color: 'var(--text-secondary)',
              }}
            >
{`NEXT_PUBLIC_FIREBASE_API_KEY=…
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=…
NEXT_PUBLIC_FIREBASE_PROJECT_ID=…
NEXT_PUBLIC_FIREBASE_APP_ID=…`}
            </pre>
            <button
              type="button"
              onClick={onClose}
              className="primary-action w-full"
            >
              Continue without an account
            </button>
          </>
        ) : (
          <>
        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="secondary-action mb-4 w-full disabled:opacity-50"
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--bg-input-border)',
            color: 'var(--text-primary)',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-px" style={{ background: 'var(--border-subtle)' }} />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>or</span>
          <div className="flex-1 h-px" style={{ background: 'var(--border-subtle)' }} />
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {!isLogin && (
            <div>
              <label htmlFor="auth-name" className="field-label">Your name</label>
              <input
                id="auth-name"
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="field-input"
                placeholder="How others will see you"
              />
            </div>
          )}

          <div>
            <label htmlFor="auth-email" className="field-label">Email</label>
            <input
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field-input"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="field-label">Password</label>
            <input
              id="auth-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field-input"
              placeholder="••••••••"
              minLength={6}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="primary-action mt-1 w-full disabled:opacity-50"
          >
            {loading ? 'Working…' : isLogin ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-[var(--text-muted)]">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <button
            type="button"
            onClick={() => { setIsLogin(!isLogin); setError(''); }}
            className="font-semibold text-[var(--accent-primary)] hover:underline"
          >
            {isLogin ? 'Sign up' : 'Sign in'}
          </button>
        </p>
          </>
        )}
      </div>
    </div>
  );
}
