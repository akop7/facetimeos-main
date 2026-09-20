'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleProvider } from '../../lib/firebase';
import { API_BASE } from '../../constants/ice-servers';

function DesktopApproval() {
  const query = useSearchParams();
  const requestId = query.get('request') || '';
  const [request, setRequest] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        if (!/^[a-zA-Z0-9_-]{43}$/.test(requestId)) throw new Error('Open this page using Sign in with Google in the Windows app.');
        const response = await fetch(`${API_BASE}/desktop-auth/${requestId}`, { signal: controller.signal, cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'This request is not available.');
        setRequest(data);
      } catch (err) { if (!controller.signal.aborted) setError(err.message); }
    }
    load(); return () => controller.abort();
  }, [requestId]);
  async function approve() {
    setBusy(true); setError('');
    try {
      if (!auth || !googleProvider) throw new Error('Firebase Google sign-in is not configured on the website.');
      const result = await signInWithPopup(auth, googleProvider);
      const token = await result.user.getIdToken(true);
      const response = await fetch(`${API_BASE}/desktop-auth/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId, code: request.code }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not approve sign-in.');
      setDone(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <main className="min-h-screen grid place-items-center bg-[var(--bg-primary)] px-6 py-12"><section className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-8">
    <p className="mb-4 text-xs tracking-widest text-[var(--text-muted)]">FACETIMEOS FOR WINDOWS</p>
    <h1 className="text-2xl font-semibold tracking-tight">{done ? 'You’re signed in.' : 'Connect your account'}</h1>
    {done ? <p className="mt-4 text-[var(--text-secondary)]">Return to the Windows app. You can close this browser tab.</p> : <>
      <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">Continue only if you just requested Google sign-in from the FaceTimeOS Windows app on this computer.</p>
      {request && <><p className="mt-7 text-xs text-[var(--text-muted)]">MATCH THIS CODE WITH THE WINDOWS APP</p><p className="my-3 rounded-lg bg-[var(--bg-input)] p-5 text-center font-mono text-3xl tracking-widest">{request.code}</p><label className="my-5 flex items-start gap-3 text-sm leading-6"><input className="mt-1" type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I opened the Windows app and the codes match.</label></>}
      <button onClick={approve} disabled={!request || !confirmed || busy} className="mt-2 w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white disabled:opacity-50">{busy ? 'Completing sign-in…' : 'Continue with Google'}</button>
      <p className="mt-5 text-xs leading-5 text-[var(--text-muted)]">Don’t approve a code sent by someone else. This request expires after five minutes.</p>
    </>}
    {error && <p className="mt-5 rounded-lg bg-[var(--notice-warn-bg)] p-4 text-sm text-[var(--notice-warn-text)]" role="alert">{error}</p>}
  </section></main>;
}
export default function DesktopAuthPage() { return <Suspense fallback={<p className="p-8">Loading sign-in request…</p>}><DesktopApproval /></Suspense>; }
