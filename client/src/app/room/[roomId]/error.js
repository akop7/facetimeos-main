'use client';

/**
 * Error boundary for the call itself.
 *
 * This is the one that actually matters. A crash here happens with other people
 * on the line — a widget handed bad data, a stream that disappeared mid-render —
 * and the default behaviour was a blank screen that gave no hint that the room
 * was still running without you.
 *
 * Reloading rather than `reset()` is deliberate. The room's session token lives
 * in `sessionStorage` and `useRoomSession` rejoins from it automatically, so a
 * reload puts you back in the same room with the same peer id and role, while
 * `reset()` would re-render the same broken subtree over a peer connection whose
 * state we no longer trust.
 */

import { useEffect } from 'react';

export default function RoomError({ error }) {
  useEffect(() => {
    console.error('[facetimeos] room error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-[var(--bg-base)] p-6 text-[var(--on-surface)]">
      <div className="ftos-panel w-full max-w-md rounded-xl border p-7 shadow-2xl">
        <h1 className="mb-2 text-lg font-semibold">The call window crashed</h1>
        <p className="ftos-muted mb-5 text-sm leading-relaxed">
          The room is still open and everyone else is still in it. Rejoining restores your place —
          the code, whiteboard and notes are stored with the room, so none of the shared work
          depends on this tab.
        </p>

        {error?.digest && (
          <p className="ftos-muted mb-5 font-mono text-[11px]">Reference: {error.digest}</p>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="primary-action w-full"
          >
            Rejoin the room
          </button>
          <button
            type="button"
            /* A full navigation, not `<Link href="/">` or `router.push()`. Leaving
               a call has to tear down the camera, the microphone and every peer
               connection, and the code that does that on unmount lives in the
               subtree that just crashed. Unloading the document makes the browser
               do it, which is the whole point here. */
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            onClick={() => window.location.assign('/')}
            className="secondary-action w-full border-[var(--surface-border)] bg-[var(--surface-raised)] text-[var(--on-surface)]"
          >
            Leave the call
          </button>
        </div>
      </div>
    </div>
  );
}
