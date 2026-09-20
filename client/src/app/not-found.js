/**
 * 404. Reachable in practice by mistyping a room link, which is why the copy
 * talks about room ids rather than saying "page not found" and stopping.
 *
 * A server component on purpose: there is nothing interactive here, so it costs
 * no JavaScript.
 */

import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-[var(--bg-primary)] p-6 text-[var(--text-primary)]">
      <div className="ftos-panel w-full max-w-md rounded-xl border p-7 shadow-2xl">
        <h1 className="mb-2 text-lg font-semibold">There is nothing at this address</h1>
        <p className="ftos-muted mb-5 text-sm leading-relaxed">
          Room links look like <span className="font-mono text-[11px]">/room/</span> followed by a
          long id, and they are easy to truncate when pasted into a chat app. Ask whoever invited
          you to send the whole thing.
        </p>
        <Link
          href="/"
          className="primary-action w-full"
        >
          Start a room instead
        </Link>
      </div>
    </div>
  );
}
