'use client';

import React, { useMemo, useState } from 'react';

/**
 * Participants, roles, and the host's controls.
 *
 * Every button here used to send a message down the lossy data channel —
 * `MUTE_PEER`, `KICK_PEER`, `APPROVE_EDIT` — which receivers applied without
 * checking who sent it. Any participant could mute or kick anyone by sending the
 * same frame. Now each button calls one `onModerate(action, peerId, value)` that
 * the page forwards to the server, which checks that the caller really is the
 * host before doing anything. A non-host pressing these gets a refusal, not an
 * effect.
 *
 * The waiting room lives here too, because that is where a host is already
 * looking when someone knocks.
 */

const ROLE_LABEL = {
  host: { text: 'Host', className: 'border-amber-500/30 bg-amber-500/20 text-amber-700 dark:text-amber-300' },
  editor: { text: 'Editor', className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  // Was `border-white/15 bg-white/10`: a white wash on a white panel, so the
  // Viewer chip had no shape at all in light mode.
  viewer: {
    text: 'Viewer',
    className: 'border-[var(--surface-border)] bg-[var(--bg-muted)] text-[var(--on-surface-muted)]',
  },
};

const CONNECTION_LABEL = {
  connected: null,
  connecting: 'Connecting…',
  disconnected: 'Reconnecting…',
  failed: 'Connection failed',
};

const TOOL_LABEL = { whiteboard: 'Whiteboard', code: 'Code editor' };

function Row({ children }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-raised)] p-3 transition-colors hover:border-[var(--border-hover)]">
      {children}
    </div>
  );
}

function Avatar({ name, speaking }) {
  return (
    <div
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-primary,#3b82f6)] text-sm font-bold text-white ${
        speaking ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-transparent' : ''
      }`}
    >
      {name?.trim()?.charAt(0)?.toUpperCase() || '?'}
    </div>
  );
}

export default function ParticipantList({
  isOpen,
  onClose,
  peers,
  localPeerId,
  localName = 'You',
  localRole = 'editor',
  localHandRaised = false,
  isHost = false,
  locked = false,
  waiting = [],
  /** Pending "let me use the whiteboard/code editor" asks, host-side. */
  accessRequests = [],
  speakingIds,
  onModerate,
  onAdmit,
  onRespondAccess,
  onRename,
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(localName);
  const [busy, setBusy] = useState(null);

  const list = useMemo(() => {
    const entries =
      peers instanceof Map
        ? [...peers.entries()].map(([peerId, peer]) => ({ peerId, ...peer }))
        : peers || [];
    // Hands first (they are waiting on you), then hosts, then alphabetical.
    return [...entries].sort((a, b) => {
      if (Boolean(b.handRaised) !== Boolean(a.handRaised)) return b.handRaised ? 1 : -1;
      if ((a.role === 'host') !== (b.role === 'host')) return a.role === 'host' ? -1 : 1;
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
  }, [peers]);

  const act = async (action, peerId, value) => {
    if (!onModerate) return;
    setBusy(`${action}:${peerId ?? 'room'}`);
    try {
      await onModerate(action, peerId, value);
    } finally {
      setBusy(null);
    }
  };

  const hostBtn =
    'rounded border px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-40';
  /* The "off" state for every host toggle. One token pair instead of the
     `bg-white dark:bg-white/5` pattern that was repeated six times and read as
     invisible on the dark drawer. */
  const neutralBtn =
    'border-[var(--surface-border)] bg-[var(--bg-muted)] text-[var(--on-surface)] hover:bg-[var(--border-subtle)]';

  return (
    <div
      className={`room-side-panel room-drawer flex flex-col overflow-hidden transition-transform duration-300 ease-in-out ${
        isOpen ? 'translate-x-0' : 'pointer-events-none translate-x-[calc(100%+1rem)]'
      }`}
      aria-hidden={!isOpen}
    >
      <div className="flex items-center justify-between border-b border-[var(--surface-border)] bg-[var(--surface-raised)] px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-[var(--on-surface)]">People</h2>
          <span className="text-xs text-[var(--on-surface-muted)]">{list.length + 1} here</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-xs text-[var(--on-surface-muted)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--on-surface)]"
          aria-label="Close participants"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      {isHost && (
        <div className="flex items-center justify-between border-b border-[var(--surface-border)] bg-amber-500/10 px-4 py-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Host controls
          </span>
          <button
            type="button"
            onClick={() => act('set-locked', undefined, !locked)}
            disabled={busy === 'set-locked:room'}
            className={`${hostBtn} ${
              locked ? 'border-amber-500/40 bg-amber-500/20 text-amber-800 dark:text-amber-200' : neutralBtn
            }`}
            title={
              locked
                ? 'The room is locked — new joiners wait for your approval'
                : 'Lock the room so new joiners need your approval'
            }
          >
            {locked ? 'Locked' : 'Open'}
          </button>
        </div>
      )}

      {isHost && waiting.length > 0 && (
        <div className="border-b border-[var(--surface-border)] bg-blue-500/10 p-3">
          <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-200">
            Waiting to join ({waiting.length})
          </p>
          <div className="space-y-2">
            {waiting.map((entry) => (
              <Row key={entry.peerId}>
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={entry.displayName} />
                  <span className="truncate text-xs font-medium text-[var(--on-surface)]">
                    {entry.displayName || 'Guest'}
                  </span>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    onClick={() => onAdmit?.(entry.peerId, true)}
                    className={`${hostBtn} border-emerald-500/40 bg-emerald-500/20 text-emerald-800 dark:text-emerald-200`}
                  >
                    Admit
                  </button>
                  <button
                    type="button"
                    onClick={() => onAdmit?.(entry.peerId, false)}
                    className={`${hostBtn} ${neutralBtn}`}
                  >
                    Deny
                  </button>
                </div>
              </Row>
            ))}
          </div>
        </div>
      )}

      {isHost && accessRequests.length > 0 && (
        <div className="border-b border-[var(--surface-border)] bg-violet-500/10 p-3">
          <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-200">
            Access requests ({accessRequests.length})
          </p>
          <div className="space-y-2">
            {accessRequests.map((entry) => (
              <Row key={`${entry.peerId}:${entry.tool}`}>
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={entry.displayName} />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-xs font-medium text-[var(--on-surface)]">
                      {entry.displayName || 'Guest'}
                    </span>
                    <span className="text-[10px] text-[var(--on-surface-muted)]">
                      wants the {TOOL_LABEL[entry.tool] || entry.tool}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    onClick={() => onRespondAccess?.(entry.peerId, entry.tool, true)}
                    className={`${hostBtn} border-emerald-500/40 bg-emerald-500/20 text-emerald-800 dark:text-emerald-200`}
                  >
                    Allow
                  </button>
                  <button
                    type="button"
                    onClick={() => onRespondAccess?.(entry.peerId, entry.tool, false)}
                    className={`${hostBtn} ${neutralBtn}`}
                  >
                    Deny
                  </button>
                </div>
              </Row>
            ))}
          </div>
        </div>
      )}

      <div className="custom-scrollbar flex-1 space-y-2 overflow-y-auto p-3">
        <Row>          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={localName} speaking={speakingIds?.has('local')} />
            <div className="flex min-w-0 flex-col">
              {renaming ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const next = draftName.trim();
                    if (next) onRename?.(next);
                    setRenaming(false);
                  }}
                >
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    onBlur={() => setRenaming(false)}
                    maxLength={40}
                    className="w-full rounded border border-[var(--surface-border)] bg-[var(--bg-input)] px-1.5 py-0.5 text-xs text-[var(--on-surface)] focus:outline-none"
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDraftName(localName);
                    setRenaming(true);
                  }}
                  className="truncate text-left text-xs font-medium text-[var(--on-surface)] hover:underline"
                  title="Rename yourself"
                >
                  {localName} (you)
                </button>
              )}
              {localHandRaised && (
                <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  Your hand is raised
                </span>
              )}
            </div>
          </div>
          {ROLE_LABEL[localRole] && (
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase ${ROLE_LABEL[localRole].className}`}>
              {ROLE_LABEL[localRole].text}
            </span>
          )}
        </Row>

        {list.length === 0 ? (
          <p className="p-6 text-center text-xs text-[var(--on-surface-muted)]">
            You are the only one here. Share the link to invite people — whatever you build in the
            meantime is saved with the room.
          </p>
        ) : (
          list.map((peer) => {
            const role = ROLE_LABEL[peer.role] || ROLE_LABEL.editor;
            const note = CONNECTION_LABEL[peer.connectionState];
            const muted = peer.media?.audio === false || peer.mutedByHost;
            return (
              <Row key={peer.peerId}>
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={peer.displayName} speaking={speakingIds?.has(peer.peerId)} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 truncate text-xs font-medium text-[var(--on-surface)]">
                      {peer.displayName || 'Participant'}
                      {muted && <span className="text-[10px] text-[var(--on-surface-muted)]">Muted</span>}
                      {peer.media?.screen && <span className="text-[10px] text-blue-600 dark:text-blue-300">Sharing</span>}
                    </span>
                    {peer.handRaised && (
                      <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                        Hand raised
                      </span>
                    )}
                    {note && (
                      <span className="text-[10px] text-[var(--on-surface-muted)]">{note}</span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase ${role.className}`}>
                    {role.text}
                  </span>
                  {isHost && (
                    <>
                      {peer.handRaised && (
                        <button
                          type="button"
                          onClick={() => act('lower-hand', peer.peerId)}
                          disabled={busy === `lower-hand:${peer.peerId}`}
                          className={`${hostBtn} ${neutralBtn}`}
                          title="Lower this hand"
                        >
                          Lower
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          act(peer.role === 'viewer' ? 'grant-edit' : 'revoke-edit', peer.peerId)
                        }
                        disabled={busy?.endsWith(peer.peerId)}
                        className={`${hostBtn} border-blue-500/40 bg-blue-500/20 text-blue-800 dark:text-blue-200`}
                        title={
                          peer.role === 'viewer'
                            ? 'Let this person edit the shared workspace'
                            : 'Make this person view-only'
                        }
                      >
                        {peer.role === 'viewer' ? 'Grant edit' : 'Make viewer'}
                      </button>
                      {/* The whiteboard and the code editor are yours to hand
                          out one at a time, independently of general edit
                          access. A host row needs no toggles — hosts always
                          have both. */}
                      {peer.role !== 'host' &&
                        Object.entries(TOOL_LABEL).map(([tool, label]) => {
                          const allowed = Boolean(peer.tools?.[tool]);
                          return (
                            <button
                              key={tool}
                              type="button"
                              onClick={() =>
                                act(allowed ? 'revoke-tool' : 'grant-tool', peer.peerId, tool)
                              }
                              disabled={busy?.endsWith(peer.peerId)}
                              className={`${hostBtn} ${
                                allowed
                                  ? 'border-violet-500/40 bg-violet-500/20 text-violet-800 dark:text-violet-200'
                                  : neutralBtn
                              }`}
                              title={`${allowed ? 'Revoke' : 'Allow'} ${label} access`}
                            >
                              {tool === 'whiteboard' ? 'Board' : 'Code'}
                            </button>
                          );
                        })}
                      <button
                        type="button"
                        onClick={() => act('mute-audio', peer.peerId)}
                        disabled={busy === `mute-audio:${peer.peerId}` || peer.mutedByHost}
                        className={`${hostBtn} border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300`}
                        // The server can force a mute but never a remote unmute:
                        // publishing someone's microphone without their consent
                        // is not a feature.
                        title="Ask this person's browser to mute (they choose when to unmute)"
                      >
                        Mute
                      </button>
                      <button
                        type="button"
                        onClick={() => act('kick', peer.peerId)}
                        disabled={busy === `kick:${peer.peerId}`}
                        className={`${hostBtn} border-red-600/40 bg-red-600/15 text-red-800 dark:text-red-300`}
                        title="Remove from the room"
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </Row>
            );
          })
        )}
      </div>
    </div>
  );
}
