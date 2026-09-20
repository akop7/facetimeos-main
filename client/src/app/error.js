'use client';

/**
 * Route-level error boundary.
 *
 * Until this file existed, an exception thrown while rendering any page put the
 * user in front of Next's own error screen — a stack trace in development, a
 * bare "Application error: a client-side exception has occurred" in production
 * — with no way back other than editing the URL. That is a poor outcome
 * anywhere and an unacceptable one during a call, so `room/[roomId]/error.js`
 * handles that route separately with a rejoin path.
 *
 * `reset()` re-renders the segment without a full reload, which is worth trying
 * first: a transient failure (a widget that got bad data once) clears, and
 * anything genuinely broken simply throws again and lands back here.
 */

import { useEffect } from 'react';
import Link from 'next/link';

export default function Error({ error, reset }) {
  useEffect(() => {
    // Nothing collects client errors yet, so the console is the only record —
    // but at least the digest is printed next to the user's description of what
    // they were doing.
    console.error('[facetimeos] render error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-[var(--bg-primary)] p-6 text-[var(--text-primary)]">
      <div className="ftos-panel w-full max-w-md rounded-xl border p-7 shadow-2xl">
        <h1 className="mb-2 text-lg font-semibold">Something broke on this page</h1>
        <p className="ftos-muted mb-5 text-sm leading-relaxed">
          Not your fault, and nothing you had open is lost — anything shared in a room lives in
          the room, not in this tab.
        </p>

        {error?.digest && (
          <p className="ftos-muted mb-5 font-mono text-[11px]">Reference: {error.digest}</p>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={reset}
            className="primary-action w-full"
          >
            Try again
          </button>
          <Link
            href="/"
            className="secondary-action w-full border-[var(--surface-border)] bg-[var(--surface-raised)] text-[var(--on-surface)]"
          >
            Back to the home page
          </Link>
        </div>
      </div>
    </div>
  );
}
