'use client';

/**
 * The room.
 *
 * The old version of this file was 915 lines and held the project's worst bugs:
 * it invented its own `peerId` with `uuidv4()`, decided it was the host by
 * reading `localStorage['hostToken_…']`, and moderated other people by sending
 * `MUTE_PEER` / `KICK_PEER` down a data channel that receivers applied without
 * checking the sender — so any participant could mute or remove anyone. Chat and
 * window layout were React state broadcast over the same channel, so a late
 * joiner saw nothing and a reload erased everything.
 *
 * Everything durable now lives in the room's CRDT document and everything
 * privileged goes through the server. What is left here is composition: acquire a
 * server-issued session, wire the mesh, and render.
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import VideoGrid from '../../../components/video/VideoGrid';
import CallControls from '../../../components/video/CallControls';
import SpatialOverlay from '../../../components/spatial/SpatialOverlay';
import SpatialWindow from '../../../components/spatial/SpatialWindow';
import ParticipantList from '../../../components/collaboration/ParticipantList';
import ChatPanel from '../../../components/collaboration/ChatPanel';
import SessionTimeline from '../../../components/collaboration/SessionTimeline';
import ReactionsOverlay from '../../../components/collaboration/ReactionsOverlay';

import CodeEditor from '../../../components/widgets/CodeEditor';
import Whiteboard from '../../../components/widgets/Whiteboard';
import LiveNotes from '../../../components/widgets/LiveNotes';
import WebBrowser from '../../../components/widgets/WebBrowser';
import MeetingTimer from '../../../components/widgets/MeetingTimer';

import { WINDOW_TYPES, widgetMeta } from '../../../constants/channel-config';
import { useRoomSession } from '../../../hooks/useRoomSession';
import { useRoomConnection } from '../../../hooks/useRoomConnection';
import { useCRDT } from '../../../hooks/useCRDT';
import { useSharedWindows } from '../../../hooks/useSharedWindows';
import { useMediaStream, mediaSupport } from '../../../hooks/useMediaStream';
import { useActiveSpeakers } from '../../../hooks/useActiveSpeakers';
import { useRoomChat, useSessionTimeline, TIMELINE_KINDS } from '../../../hooks/useRoomLog';
import { buildBundle, downloadBlob } from '../../../lib/export-bundle';
import { useAuth } from '../../../context/AuthContext';
import AuthModal from '../../../components/ui/AuthModal';

const REACTION_LIFETIME_MS = 3200;
const TYPING_TTL_MS = 3000;

/**
 * Widgets only the host may open, and that anyone else has to be granted.
 *
 * These two are the shared artifacts with the widest blast radius — one canvas
 * and one file that everybody sees — so they are gated per person rather than by
 * the room-wide editor role.
 *
 * The keys are window types; the values are the server's tool names, which are
 * deliberately shorter and not the same strings. Grant/revoke and
 * `request-access` all speak the server's names.
 */
const WIDGET_TOOL = Object.freeze({
  [WINDOW_TYPES.WHITEBOARD]: 'whiteboard',
  [WINDOW_TYPES.CODE_EDITOR]: 'code',
});

/** Reverse lookup, for turning a `tool-access` grant back into a window type. */
const TOOL_WIDGET = Object.freeze({ whiteboard: WINDOW_TYPES.WHITEBOARD, code: WINDOW_TYPES.CODE_EDITOR });

const TOOL_LABEL = Object.freeze({ whiteboard: 'whiteboard', code: 'code editor' });

/**
 * `100dvh`, not `h-screen`.
 *
 * `h-screen` is `100vh`, which on mobile browsers means "the viewport with the
 * URL bar hidden" — taller than what is actually visible. Anything anchored to
 * the bottom, which here is the entire control bar, sits underneath the browser
 * chrome and cannot be tapped. `dvh` tracks the visible height as the bar
 * collapses. `w-full` rather than `w-screen` for the matching reason: `100vw`
 * includes the scrollbar gutter and produces a sideways scroll.
 */
const shell =
  'room-shell flex min-h-[100dvh] w-full items-center justify-center p-4 text-[var(--on-surface)] sm:p-6';

/* `ftos-panel`, not `dark:bg-[var(--bg-card,#12121a)]` — the fallback in that
   arbitrary value never applied, because `--bg-card` is defined (as a 3% white
   overlay), so the join/waiting/kicked cards were transparent in dark mode. */
const card = 'ftos-panel w-full max-w-md rounded-xl border p-6 shadow-2xl sm:p-7';

/**
 * Screens shown before, and instead of, the call itself. All three are here
 * rather than in `components/` because none of them is reusable — they exist only
 * to describe one of the states this route can be in.
 */
function Panel({ title, children }) {
  return (
    <div className={shell}>
      <div className={card}>
        <div className="mb-6 flex items-center gap-3 border-b border-[var(--surface-border)] pb-4">
          <span className="brand-mark shrink-0" aria-hidden="true" />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--on-surface-muted)]">FaceTimeOS</p>
            <h1 className="mt-0.5 text-lg font-semibold tracking-[-0.025em]">{title}</h1>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Spinner({ label }) {
  return (
    <div className={shell}>
      <div className="flex flex-col items-center gap-3">
        <span className="h-7 w-7 animate-spin rounded-full border-2 border-[var(--surface-border)] border-t-[var(--accent-primary)]" />
        <p className="text-[13px] text-[var(--on-surface-muted)]">{label}</p>
      </div>
    </div>
  );
}

/**
 * The auth wall in front of the pre-join screen.
 *
 * An invite link lands here rather than being bounced to `/`, which is what the
 * original room page did: `user === null` triggered a redirect, so the link you
 * were sent silently became the marketing page and the room you were invited to
 * was unreachable. The room's identity is shown here — you can see what you are
 * signing in for, and the address survives the sign-in because nothing navigates.
 */
function SignInGate({ roomId, room, status }) {
  const [showAuth, setShowAuth] = useState(false);
  const router = useRouter();

  if (status === 'probing') return <Spinner label="Looking up this room…" />;

  return (
    <>
      <AuthModal
        isOpen={showAuth}
        onClose={() => setShowAuth(false)}
        reason="Sign in to join this room."
      />
      <Panel title={room?.title ? `Sign in to join “${room.title}”` : 'Sign in to join this room'}>
        <p className="mb-5 text-xs leading-relaxed text-stone-500 dark:text-white/50">
          {room?.exists
            ? 'This room needs an account. Sign in and you will land straight in the pre-join screen — this link stays where it is.'
            : 'This room has not started yet. Sign in and you can open it.'}
          {room?.hasSavedWork
            ? ' The notes, code and whiteboard from last time are waiting inside.'
            : ''}
        </p>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowAuth(true)}
            className="primary-action w-full"
          >
            Sign in / Sign up
          </button>
          <button
            type="button"
            onClick={() => router.push('/')}
            className="w-full rounded-lg px-4 py-2 text-xs text-[var(--on-surface-muted)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--on-surface)]"
          >
            Back to home
          </button>
        </div>

        <p className="mt-4 text-center text-[10px] text-[var(--on-surface-muted)]">
          Room {String(roomId).slice(0, 8)}…
        </p>
      </Panel>
    </>
  );
}

/**
 * The pre-join screen.
 *
 * Reached only once you have an account (or on a build with no auth configured).
 * A name is all it asks for beyond that, and even that is pre-filled — from the
 * signed-in profile first, then the last name used on this device.
 */
function JoinGate({ roomId, room, status, error, suggestedName, onJoin }) {
  const [name, setName] = useState(suggestedName || '');
  const [busy, setBusy] = useState(false);
  const { authAvailable } = useAuth();

  if (status === 'probing') return <Spinner label="Looking up this room…" />;

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    await onJoin(trimmed);
    setBusy(false);
  };

  return (
    <Panel title={room?.exists ? 'Join this room' : 'Start this room'}>
      <p className="mb-5 text-xs leading-relaxed text-stone-500 dark:text-white/50">
        {room?.hasSavedWork
          ? 'This room has saved work — the notes, code and whiteboard from last time will be here when you arrive.'
          : 'Whatever you build here is saved with the room and exportable as files.'}
      </p>

      <form onSubmit={submit} className="space-y-3">
        <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--on-surface-muted)]">
          Your name
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            placeholder="e.g. Alok"
            className="field-input mt-1.5 font-normal normal-case tracking-normal"
          />
        </label>

        {(error || status === 'error') && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-300">
            {error || 'Could not join this room.'}
          </p>
        )}

        <button
          type="submit"
          disabled={!name.trim() || busy || status === 'joining'}
          className="primary-action w-full disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy || status === 'joining' ? 'Joining…' : 'Join room'}
        </button>
      </form>

      <p className="mt-4 text-center text-[10px] text-[var(--on-surface-muted)]">
        Room {String(roomId).slice(0, 8)}…
      </p>

      {/* Said out loud rather than silently skipped: a gate that cannot run is
          worth knowing about, and the fix is one file away. */}
      {!authAvailable && (
        <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300/90">
          Rooms are meant to require an account. This build has no Firebase keys
          (<code>client/.env.local</code>), so the requirement is switched off and
          anyone with the link can join.
        </p>
      )}
    </Panel>
  );
}

/** Held at the door of a locked room, waiting for the host to admit you. */
function WaitingRoom({ onLeave }) {
  return (
    <Panel title="Waiting for the host">
      <p className="mb-5 text-xs leading-relaxed text-stone-500 dark:text-white/50">
        This room is locked. The host has been told you are here — you will join
        automatically the moment they let you in.
      </p>
      <div className="mb-5 h-1 overflow-hidden rounded-full bg-[var(--surface-raised)]">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--accent-primary)]" />
      </div>
      <button
        type="button"
        onClick={onLeave}
        className="secondary-action w-full border-[var(--surface-border)] bg-[var(--surface-raised)] text-[var(--on-surface)]"
      >
        Leave
      </button>
    </Panel>
  );
}

/**
 * The end of the call — and the one screen no other meeting app can show you.
 *
 * The document is in this browser, so the export still works after the room is
 * gone, after the host ended it, and even after you were removed from it. What
 * you contributed is yours; you do not have to ask anyone for a recording.
 */
function EndedScreen({ reason, by, onExport, onHome, onRejoin }) {
  const title =
    reason === 'kicked'
      ? 'You were removed from the room'
      : reason === 'room-ended'
        ? 'The host ended the meeting'
        : 'You left the room';

  return (
    <Panel title={title}>
      <p className="mb-5 text-xs leading-relaxed text-stone-500 dark:text-white/50">
        {by ? 'Ended by the host. ' : ''}
        Everything the room produced is still on this device — you can download it
        as files right now.
      </p>
      <div className="space-y-2">
        <button
          type="button"
          onClick={onExport}
          className="primary-action w-full"
        >
          Download this session
        </button>
        {reason !== 'kicked' && (
          <button
            type="button"
            onClick={onRejoin}
            className="secondary-action w-full border-[var(--surface-border)] bg-[var(--surface-raised)] text-[var(--on-surface)]"
          >
            Rejoin
          </button>
        )}
        <button
          type="button"
          onClick={onHome}
          className="w-full rounded-xl px-4 py-2 text-xs text-[var(--on-surface-muted)] transition-colors hover:text-[var(--on-surface)]"
        >
          Back to home
        </button>
      </div>
    </Panel>
  );
}

/** Compact meeting identity and connection state, anchored away from the speaker. */
function StatusBar({
  roomId,
  title,
  participantCount,
  connected,
  transportNote,
  isHost,
  role,
  locked,
  savedNote,
  onShareLink,
}) {
  return (
    <div className="room-statusbar pointer-events-auto absolute left-3 top-3 z-40 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 p-1.5 pr-2 text-[11px] sm:left-4 sm:top-4 sm:gap-2.5 sm:pr-2.5">
      <span className="room-call-mark grid h-8 w-8 shrink-0 place-items-center rounded-lg" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="13" height="14" rx="2" />
          <path d="m16 10 5-3v10l-5-3" />
        </svg>
      </span>

      <span className="min-w-0">
        <span className="block max-w-[9.5rem] truncate text-[12px] font-semibold leading-tight text-white sm:max-w-[15rem]">
          {title || `Room ${String(roomId).slice(0, 8)}`}
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[10px] leading-none text-[var(--on-surface-muted)]">
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'animate-pulse bg-amber-400'}`}
          />
          <span title={transportNote || undefined}>{connected ? 'Live' : 'Connecting…'}</span>
          <span aria-hidden="true">·</span>
          <span>{participantCount} {participantCount === 1 ? 'participant' : 'participants'}</span>
        </span>
      </span>

      {isHost ? (
        <span className="hidden shrink-0 rounded-md border border-amber-300/20 bg-amber-400/10 px-1.5 py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-amber-200 sm:inline">
          Host
        </span>
      ) : role === 'viewer' ? (
        <span className="hidden shrink-0 rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-white/70 sm:inline">
          View only
        </span>
      ) : null}

      {locked && (
        <span className="hidden text-white/55 sm:inline" title="Room locked">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="Room locked"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
        </span>
      )}

      {savedNote && (
        <span className="hidden shrink-0 text-emerald-300 lg:inline">{savedNote}</span>
      )}

      <button
        type="button"
        onClick={onShareLink}
        className="ml-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.07] px-2 text-[10px] font-semibold text-white transition-colors hover:border-white/20 hover:bg-white/[0.11] sm:px-2.5"
        aria-label="Copy meeting invite link"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/>
        </svg>
        <span className="hidden sm:inline">Invite</span>
      </button>
    </div>
  );
}

function RoomWorkspace({ roomId, session, onSessionPatch, onLeaveSession }) {
  const router = useRouter();
  const peerId = session.peerId;
  const displayName = session.displayName || 'Guest';
  const role = session.role || 'editor';

  /* --------------------------------- ambient -------------------------------- */

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const notify = useCallback((message, level = 'info') => {
    // Called from event handlers and socket callbacks, never from an effect body:
    // scheduling its own dismissal is what a timer callback is for.
    setToast({ id: Date.now(), message, level });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const [lifecycle, setLifecycle] = useState('active');
  const [panel, setPanel] = useState(null);
  const [pinnedId, setPinnedId] = useState(null);
  const [followOptOut, setFollowOptOut] = useState(false);
  const [chatSeen, setChatSeen] = useState(0);
  const [reactions, setReactions] = useState([]);
  const [typing, setTyping] = useState(() => new Map());
  const [peerMedia, setPeerMedia] = useState(() => new Map());
  const [presenterView, setPresenterView] = useState(null);
  const [exportStats, setExportStats] = useState(null);
  const [handRaised, setHandRaised] = useState(false);
  const [savedNote, setSavedNote] = useState(null);
  const [endedBy, setEndedBy] = useState(null);
  /** Host-side queue of "may I use the whiteboard?" asks. */
  const [accessRequests, setAccessRequests] = useState([]);
  /** Tools I have asked for and not yet heard back about. */
  const [pendingTools, setPendingTools] = useState(() => new Set());

  /* ------------------------------- the document ----------------------------- */

  const {
    provider,
    awareness,
    sharedCode,
    sharedNotes,
    sharedWhiteboard,
    sharedWindows,
    sharedTimeline,
    sharedChat,
    sharedMeta,
    localLoaded,
  } = useCRDT(roomId, { peerId, displayName, role });

  /* ------------------------------- local media ------------------------------ */

  const support = useMemo(() => mediaSupport(), []);
  const {
    stream: localStream,
    isAudioEnabled,
    isVideoEnabled,
    isScreenSharing,
    error: mediaError,
    startMedia,
    stopMedia,
    retryCamera,
    toggleAudio,
    toggleVideo,
    forceMute,
    toggleScreenShare,
    setVideoTrackListener,
  } = useMediaStream();

  /* -------------------------- signaling and the mesh ------------------------ */

  // The connection's event handler needs values declared below it — the CRDT
  // logs, the window store. Routing through a ref keeps the graph acyclic
  // without making the whole connection tear down on every render.
  const eventRef = useRef(null);
  const onEvent = useCallback((event) => eventRef.current?.(event), []);

  const {
    connected,
    transportNote,
    peers,
    remoteStreams,
    roomState,
    isHost,
    toolAccess,
    iceInfo,
    relayFailures,
    publishStream,
    replaceVideoTrack,
    sendEphemeral,
    moderate,
    admit,
    requestAccess,
    raiseHand,
    rename,
    leave: disconnect,
  } = useRoomConnection({ roomId, session, provider, onEvent });

  // Whatever the token says, the host is never read-only in their own room.
  const canEdit = isHost || role !== 'viewer';
  const readOnly = !canEdit;

  /**
   * The whiteboard and the code editor belong to the host.
   *
   * Being an editor is no longer enough: the shared canvas and the shared file
   * are the two artifacts a stranger can wreck for everyone at once, so a
   * non-host has to ask and be granted access per tool. `toolAccess` is the
   * server's answer, so a reload does not silently re-open a door the host
   * closed.
   */
  const canUseTool = useCallback(
    (type) => {
      const tool = WIDGET_TOOL[type];
      return !tool || isHost || Boolean(toolAccess?.[tool]);
    },
    [isHost, toolAccess]
  );

  /* ------------------------------ shared stores ----------------------------- */

  const {
    windows,
    spawn,
    update: patchWindow,
    close: closeWindow,
    focus,
  } = useSharedWindows(sharedWindows, { canEdit, ownerId: peerId });

  const { messages, send: pushChat } = useRoomChat(sharedChat, { peerId, displayName, readOnly });

  const { events: timelineEvents, record, recordOnce } = useSessionTimeline(sharedTimeline, {
    peerId,
    displayName,
    readOnly,
  });

  /* -------------------------------- derived UI ------------------------------ */

  // VideoGrid keys the local tile 'local', so the analyser map has to as well.
  const audioStreams = useMemo(() => {
    const map = new Map(remoteStreams);
    if (localStream) map.set('local', localStream);
    return map;
  }, [remoteStreams, localStream]);

  const speakingIds = useActiveSpeakers(audioStreams);

  // What a peer says about its own mic and camera arrives as an ephemeral rather
  // than in the roster, so it is merged here instead of copied into the map the
  // connection owns.
  const peersForUi = useMemo(() => {
    const next = new Map();
    for (const [id, peer] of peers) {
      const announced = peerMedia.get(id);
      next.set(id, announced ? { ...peer, media: { ...(peer.media || {}), ...announced } } : peer);
    }
    return next;
  }, [peers, peerMedia]);

  const participantCount = peers.size + 1;
  const unreadChatCount = panel === 'chat' ? 0 : Math.max(0, messages.length - chatSeen);

  // The interval below is what expires entries, so render just reads the map:
  // calling `Date.now()` here would be impure and would not change the answer.
  const typingNames = useMemo(() => [...typing.values()].map((entry) => entry.name), [typing]);

  // Follow-the-presenter, without a second protocol: the host publishes where it
  // is looking, and only the host's frame is honoured — an ephemeral from anyone
  // else is data about them, not an instruction to us.
  const followingPresenter = Boolean(roomState.followHost) && !isHost && !followOptOut;
  const hostView = presenterView?.from === roomState.hostPeerId ? presenterView : null;
  const effectivePinnedId = followingPresenter && hostView ? hostView.pinnedId : pinnedId;

  /* --------------------------------- actions -------------------------------- */

  const shareLink = useCallback(async () => {
    const origin = process.env.NEXT_PUBLIC_WEB_URL || window.location.origin;
    const url = `${origin}/room/${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      notify('Invite link copied to your clipboard.');
    } catch {
      // No clipboard permission, or no HTTPS: show the link rather than fail mutely.
      window.prompt('Copy this invite link:', url);
    }
  }, [roomId, notify]);

  const exportSession = useCallback(() => {
    const bundle = buildBundle({
      roomId,
      title: roomState.title || null,
      sharedTypes: provider.sharedTypes,
      exportedBy: displayName,
    });
    setExportStats(bundle.stats);
    downloadBlob(bundle.blob, bundle.filename);
  }, [roomId, roomState.title, provider, displayName]);

  // Widgets report keystrokes here. The first one flips the indicator, the rest
  // set the same value and React bails out, so typing does not re-render the call.
  const savedTimer = useRef(null);
  const bumpActivity = useCallback(() => {
    setSavedNote('Saving…');
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedNote('Saved'), 900);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    []
  );

  const openWidget = useCallback(
    (type) => {
      if (!canEdit) {
        notify('You have view-only access — ask the host for edit access.', 'warn');
        return;
      }
      // The whiteboard and the code editor are the host's to hand out. A
      // non-host without a grant does not get a refusal and a dead end — the
      // click becomes the request, which the host answers from the participant
      // panel. The server checks the same thing, so a hand-crafted client gains
      // nothing by skipping this.
      if (!canUseTool(type)) {
        const tool = WIDGET_TOOL[type];
        const label = TOOL_LABEL[tool] || widgetMeta(type).title;
        if (pendingTools.has(tool)) {
          notify(`Still waiting for the host to approve the ${label}.`);
          return;
        }
        setPendingTools((prev) => new Set(prev).add(tool));
        const drop = () =>
          setPendingTools((prev) => {
            if (!prev.has(tool)) return prev;
            const next = new Set(prev);
            next.delete(tool);
            return next;
          });
        // `alreadyAllowed` closes the race where the host granted access between
        // the click and the round trip: no ask is queued, so nothing would ever
        // clear the pending flag.
        Promise.resolve(requestAccess(tool)).then((result) => {
          if (result?.alreadyAllowed) {
            drop();
            return;
          }
          if (!result?.ok) {
            drop();
            notify(`Could not ask for ${label} access — try again.`, 'warn');
          }
        });
        notify(`Asked the host for access to the ${label}.`);
        return;
      }
      // One of each: a second whiteboard would be a second document, and the
      // room only has one. Re-opening therefore means "bring it to the front".
      const existing = windows.find((win) => win.type === type);
      if (existing) {
        if (existing.isMinimized) patchWindow(existing.id, { isMinimized: false });
        focus(existing.id);
        return;
      }
      if (spawn(type)) {
        record(TIMELINE_KINDS.widget, `${widgetMeta(type).title} opened`, { widget: type });
      }
    },
    [canEdit, canUseTool, pendingTools, requestAccess, windows, patchWindow, focus, spawn, record, notify]
  );

  // Latest-refs, so the event handler can open or close a widget without taking
  // `openWidget`/`windows` as dependencies — the event handler is installed once
  // per render already, and adding the widget list would rebuild it on every
  // drag.
  const openWidgetRef = useRef(openWidget);
  const windowsRef = useRef(windows);
  useEffect(() => {
    openWidgetRef.current = openWidget;
    windowsRef.current = windows;
  }, [openWidget, windows]);

  const shareScreen = useCallback(async () => {
    const wasSharing = isScreenSharing;
    const track = await toggleScreenShare();
    if (!wasSharing && track) record(TIMELINE_KINDS.share, `${displayName} shared their screen`);
  }, [isScreenSharing, toggleScreenShare, record, displayName]);

  const pushReaction = useCallback((emoji, senderName) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setReactions((prev) => [
      ...prev.slice(-24),
      { id, emoji, senderName, leftPercent: 8 + Math.random() * 84 },
    ]);
    setTimeout(
      () => setReactions((prev) => prev.filter((item) => item.id !== id)),
      REACTION_LIFETIME_MS
    );
  }, []);

  const sendReaction = useCallback(
    (emoji) => {
      sendEphemeral('REACTION', { emoji, name: displayName });
      // The server relays to *other* sockets, so our own has to be shown locally.
      pushReaction(emoji, displayName);
    },
    [sendEphemeral, displayName, pushReaction]
  );

  // Throttled: the panel calls this on every keystroke, and the server rate-limits
  // per socket. One frame every 1.2s is enough to keep "…is typing" alive.
  const lastTypingRef = useRef(0);
  const signalTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingRef.current < 1200) return;
    lastTypingRef.current = now;
    sendEphemeral('TYPING', { name: displayName });
  }, [sendEphemeral, displayName]);

  const sendChat = useCallback(
    (text) => {
      if (readOnly) {
        notify('View-only access: you cannot post to the chat.', 'warn');
        return;
      }
      pushChat(text);
    },
    [readOnly, pushChat, notify]
  );

  const markDecision = useCallback(
    (text) => {
      if (readOnly) return;
      record(TIMELINE_KINDS.decision, text);
      notify('Decision recorded in the timeline.');
    },
    [readOnly, record, notify]
  );

  // Every privileged action is one call to the server, which checks that the
  // caller really is the host. A non-host pressing these gets a refusal.
  const runModeration = useCallback(
    async (action, targetPeerId, value) => {
      const result = await moderate(action, targetPeerId, value);
      if (!result?.ok) {
        notify(
          result?.error === 'not-host' ? 'Only the host can do that.' : 'That action was refused.',
          'warn'
        );
      }
      return result;
    },
    [moderate, notify]
  );

  /**
   * Answer a pending access request.
   *
   * The entry leaves the queue either way — a denial that stayed on screen would
   * be a request the host has to dismiss twice. The requester hears about it via
   * `tool-access`, which the server sends only after it has actually recorded the
   * grant.
   */
  const respondAccess = useCallback(
    async (targetPeerId, tool, allow) => {
      const result = await runModeration(allow ? 'grant-tool' : 'revoke-tool', targetPeerId, tool);
      if (result?.ok) {
        setAccessRequests((prev) =>
          prev.filter((ask) => !(ask.peerId === targetPeerId && ask.tool === tool))
        );
      }
      return result;
    },
    [runModeration]
  );

  const toggleHand = useCallback(() => {
    const next = !handRaised;
    setHandRaised(next);
    raiseHand(next);
  }, [handRaised, raiseHand]);

  const togglePanel = useCallback(
    (name) => {
      setPanel((prev) => (prev === name ? null : name));
      if (name === 'chat') setChatSeen(messages.length);
    },
    [messages.length]
  );

  const togglePin = useCallback(
    (nextId) => {
      setPinnedId(nextId);
      // Pinning something yourself is an explicit disagreement with the presenter.
      if (followingPresenter) setFollowOptOut(true);
    },
    [followingPresenter]
  );

  const toggleFollow = useCallback(() => {
    // The host turns the mode on for the room; everyone else can only opt out.
    if (isHost) {
      runModeration('set-follow-host', undefined, !roomState.followHost);
      return;
    }
    setFollowOptOut((prev) => !prev);
  }, [isHost, runModeration, roomState.followHost]);

  const leaveCall = useCallback(() => {
    stopMedia();
    disconnect();
    setLifecycle('left');
  }, [stopMedia, disconnect]);

  const endForAll = useCallback(() => {
    runModeration('end-room');
  }, [runModeration]);

  const goHome = useCallback(() => {
    onLeaveSession();
    router.push('/');
  }, [onLeaveSession, router]);

  /* -------------------------------- the wiring ------------------------------ */

  // Media is requested here rather than on the pre-join screen: this component
  // mounts as a direct result of pressing "Join", so the permission prompt is
  // expected instead of appearing on a page the user has not committed to.
  useEffect(() => {
    startMedia();
  }, [startMedia]);

  // Screen share and camera-return swap the outgoing track in place, which needs
  // no renegotiation — the hook tells us, we tell the mesh.
  useEffect(() => {
    setVideoTrackListener(replaceVideoTrack);
    return () => setVideoTrackListener(null);
  }, [setVideoTrackListener, replaceVideoTrack]);

  useEffect(() => {
    publishStream(localStream);
  }, [publishStream, localStream]);

  // Announce our own mic/camera state. Disabling a track does not reliably fire
  // `onmute` on the receiving side, so the truth is stated rather than inferred.
  useEffect(() => {
    if (!connected) return;
    sendEphemeral('MEDIA_STATE', {
      audio: isAudioEnabled,
      video: isVideoEnabled,
      screen: isScreenSharing,
    });
  }, [connected, isAudioEnabled, isVideoEnabled, isScreenSharing, sendEphemeral]);

  useEffect(() => {
    if (!isHost || !connected || !roomState.followHost) return;
    sendEphemeral('PRESENTER_VIEW', { pinnedId });
  }, [isHost, connected, roomState.followHost, pinnedId, sendEphemeral]);

  // One line per person per room, not one per observer: `recordOnce` keys on the
  // peer id, so five people watching Alice arrive still write a single entry.
  useEffect(() => {
    if (!localLoaded || readOnly) return;
    recordOnce(`joined:${peerId}`, TIMELINE_KINDS.joined, `${displayName} joined`);
  }, [localLoaded, readOnly, recordOnce, peerId, displayName]);

  // Typing indicators expire on their own; without this a peer who closed their
  // tab mid-sentence would be "typing" for the rest of the meeting.
  useEffect(() => {
    const id = setInterval(() => {
      setTyping((prev) => {
        if (prev.size === 0) return prev;
        const now = Date.now();
        const next = new Map([...prev].filter(([, entry]) => now - entry.at < TYPING_TTL_MS));
        return next.size === prev.size ? prev : next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const handleEphemeral = useCallback(
    ({ from, kind, data }) => {
      if (kind === 'MEDIA_STATE') {
        setPeerMedia((prev) =>
          new Map(prev).set(from, {
            audio: data?.audio !== false,
            video: data?.video !== false,
            screen: Boolean(data?.screen),
          })
        );
        return;
      }
      if (kind === 'REACTION' && data?.emoji) {
        pushReaction(String(data.emoji).slice(0, 8), data.name || 'Someone');
        return;
      }
      if (kind === 'TYPING') {
        setTyping((prev) => new Map(prev).set(from, { name: data?.name || 'Someone', at: Date.now() }));
        return;
      }
      if (kind === 'PRESENTER_VIEW') {
        setPresenterView({ from, pinnedId: data?.pinnedId ?? null });
      }
    },
    [pushReaction]
  );

  const handleEvent = useCallback(
    (event) => {
      switch (event.type) {
        case 'notice':
          notify(event.message, event.level || 'info');
          break;
        case 'joined':
        case 'waiting-approved':
          setLifecycle('active');
          break;
        case 'waiting':
          setLifecycle('waiting');
          break;
        case 'waiting-denied':
          setLifecycle('left');
          notify('The host did not admit you to this room.', 'warn');
          break;
        case 'join-failed':
          notify(`Could not join: ${event.error}`, 'warn');
          break;
        case 'peer-joined':
          notify(`${event.peer?.displayName || 'Someone'} joined.`);
          // Whoever just arrived has not seen our MEDIA_STATE, and nothing else
          // will tell them: the roster carries identity, not device state.
          sendEphemeral('MEDIA_STATE', {
            audio: isAudioEnabled,
            video: isVideoEnabled,
            screen: isScreenSharing,
          });
          break;
        case 'peer-left':
          if (event.displayName) {
            // Bucketed to ten seconds so N observers of one departure write one
            // line between them rather than N.
            recordOnce(
              `left:${event.peerId}:${Math.round(Date.now() / 10000)}`,
              TIMELINE_KINDS.left,
              `${event.displayName} left`
            );
          }
          setPeerMedia((prev) => {
            if (!prev.has(event.peerId)) return prev;
            const next = new Map(prev);
            next.delete(event.peerId);
            return next;
          });
          // A request from someone who has left is no longer answerable, so it
          // should not sit in the host's queue.
          setAccessRequests((prev) => {
            const next = prev.filter((ask) => ask.peerId !== event.peerId);
            return next.length === prev.length ? prev : next;
          });
          break;
        case 'role-changed': {
          // The server hands back a fresh token so the new role survives a reload.
          onSessionPatch({ role: event.role, sessionToken: event.sessionToken });
          notify(
            event.role === 'viewer'
              ? 'You now have view-only access.'
              : event.role === 'host'
                ? 'You are now the host of this room.'
                : 'You can now edit the shared workspace.'
          );
          break;
        }
        case 'moderated':
          // Force-mute is one-way by design: a host can silence someone, but
          // nothing can switch a participant's microphone back on remotely.
          if (event.kind === 'audio') {
            forceMute('audio');
            notify('The host muted you.', 'warn');
          } else if (event.kind === 'video') {
            forceMute('video');
            notify('The host turned your camera off.', 'warn');
          } else if (event.action === 'lower-hand') {
            setHandRaised(false);
          }
          break;
        case 'kicked':
          stopMedia();
          setEndedBy(event.by || null);
          setLifecycle('kicked');
          break;
        case 'room-ended':
          stopMedia();
          setEndedBy(event.by || null);
          setLifecycle('room-ended');
          break;
        case 'artifacts-cleared':
          notify('The host cleared the shared workspace.', 'warn');
          break;
        // Someone is asking for the whiteboard or the code editor. Only hosts
        // receive this — the server addresses it to them rather than
        // broadcasting — so the queue never fills on a guest's screen.
        case 'access-request': {
          const label = TOOL_LABEL[event.tool] || event.tool;
          setAccessRequests((prev) => {
            if (prev.some((ask) => ask.peerId === event.peerId && ask.tool === event.tool)) {
              return prev;
            }
            return [
              ...prev,
              {
                peerId: event.peerId,
                displayName: event.displayName || 'Someone',
                tool: event.tool,
                at: event.at || Date.now(),
              },
            ];
          });
          notify(`${event.displayName || 'Someone'} is asking for the ${label}.`);
          break;
        }
        // The host's answer, for the person who asked. A grant opens the tool
        // straight away: they already pressed the button once, and making them
        // press it again is the kind of small rudeness that reads as a bug.
        case 'tool-access': {
          const label = TOOL_LABEL[event.tool] || event.tool;
          setPendingTools((prev) => {
            if (!prev.has(event.tool)) return prev;
            const next = new Set(prev);
            next.delete(event.tool);
            return next;
          });
          if (event.allowed) {
            notify(`The host gave you access to the ${label}.`);
            const type = TOOL_WIDGET[event.tool];
            if (type) openWidgetRef.current?.(type);
          } else {
            notify(`Your ${label} access was removed.`, 'warn');
            // Leaving the window open would show a canvas that silently refuses
            // every stroke, so it closes with the grant.
            const type = TOOL_WIDGET[event.tool];
            for (const win of windowsRef.current) {
              if (win.type === type) closeWindow(win.id);
            }
          }
          break;
        }
        case 'artifacts-restored':
          if (event.updates > 0) {
            notify('Restored the work saved in this room.');
            recordOnce(`restored:${peerId}`, TIMELINE_KINDS.restored, 'Earlier work was restored');
          }
          break;
        case 'ephemeral':
          handleEphemeral(event);
          break;
        default:
          break;
      }
    },
    [
      notify,
      sendEphemeral,
      isAudioEnabled,
      isVideoEnabled,
      isScreenSharing,
      recordOnce,
      peerId,
      onSessionPatch,
      forceMute,
      stopMedia,
      closeWindow,
      handleEphemeral,
    ]
  );

  useEffect(() => {
    eventRef.current = handleEvent;
  }, [handleEvent]);

  /* --------------------------------- screens -------------------------------- */

  if (lifecycle === 'waiting') return <WaitingRoom onLeave={leaveCall} />;

  if (lifecycle !== 'active') {
    return (
      <EndedScreen
        reason={lifecycle}
        by={endedBy}
        onExport={exportSession}
        onHome={goHome}
        onRejoin={() => window.location.reload()}
      />
    );
  }

  const widgetFor = (win) => {
    switch (win.type) {
      case WINDOW_TYPES.CODE_EDITOR:
        return (
          <CodeEditor
            yText={sharedCode}
            awareness={awareness}
            meta={sharedMeta}
            peerId={peerId}
            displayName={displayName}
            readOnly={readOnly}
            onActivity={bumpActivity}
          />
        );
      case WINDOW_TYPES.WHITEBOARD:
        return (
          <Whiteboard
            sharedWhiteboard={sharedWhiteboard}
            awareness={awareness}
            peerId={peerId}
            displayName={displayName}
            readOnly={readOnly}
            onActivity={bumpActivity}
          />
        );
      case WINDOW_TYPES.NOTES:
        return <LiveNotes yText={sharedNotes} readOnly={readOnly} onActivity={bumpActivity} />;
      case WINDOW_TYPES.WEB_BROWSER:
        return (
          <WebBrowser
            meta={sharedMeta}
            displayName={displayName}
            readOnly={readOnly}
            onActivity={bumpActivity}
          />
        );
      case WINDOW_TYPES.MEETING_TIMER:
        return (
          <MeetingTimer
            meta={sharedMeta}
            displayName={displayName}
            readOnly={readOnly}
            onActivity={bumpActivity}
            onExpire={() => record(TIMELINE_KINDS.timer, 'The meeting timer finished')}
          />
        );
      default:
        return null;
    }
  };

  return (
    /* See the `shell` comment: dvh so the control bar is reachable on a phone,
       and `text-[var(--on-surface)]` because a hard-coded `text-white` here made
       every unstyled string in the room invisible in the light theme. */
    <div className="room-shell relative h-[100dvh] w-full overflow-hidden text-[var(--on-surface)]">
      <VideoGrid
        localStream={localStream}
        remoteStreams={remoteStreams}
        peers={peersForUi}
        localName={`${displayName} (you)`}
        localRole={isHost ? 'host' : role}
        localMuted={!isAudioEnabled}
        localCameraOff={!isVideoEnabled}
        localScreenSharing={isScreenSharing}
        localHandRaised={handRaised}
        speakingIds={speakingIds}
        pinnedId={effectivePinnedId}
        onTogglePin={togglePin}
      />

      {/* The workspace floats over the video rather than replacing it: the point
          of the product is that the people and the work occupy one space. */}
      <SpatialOverlay>
        {(size) =>
          windows.map((win) => (
            <SpatialWindow
              key={win.id}
              id={win.id}
              type={win.type}
              position={win.position}
              containerSize={size}
              isMinimized={win.isMinimized}
              z={win.z}
              readOnly={readOnly}
              ownerLabel={
                win.createdBy === peerId ? 'You' : peers.get(win.createdBy)?.displayName || undefined
              }
              onMove={(position) => patchWindow(win.id, { position })}
              onResize={(position) => patchWindow(win.id, { position })}
              onClose={() => closeWindow(win.id)}
              onMinimize={() => patchWindow(win.id, { isMinimized: true })}
              onFocus={focus}
            >
              {widgetFor(win)}
            </SpatialWindow>
          ))
        }
      </SpatialOverlay>

      {canEdit && windows.some((win) => win.isMinimized) && (
        <div
          className="room-minimized-shelf fixed bottom-24 left-3 z-40 flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center gap-1.5 p-1.5 sm:left-4"
          aria-label="Minimized tools"
        >
          {windows.filter((win) => win.isMinimized).map((win) => {
            const meta = widgetMeta(win.type);
            return (
              <button
                key={win.id}
                type="button"
                onClick={() => {
                  patchWindow(win.id, { isMinimized: false });
                  focus(win.id);
                }}
                className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-2.5 text-xs font-semibold text-[var(--on-surface)] transition-colors hover:border-white/20 hover:bg-white/[0.1]"
                title={`Restore ${meta.title}`}
              >
                <span aria-hidden="true">{meta.icon}</span>
                <span>{meta.title}</span>
              </button>
            );
          })}
        </div>
      )}

      <StatusBar
        roomId={roomId}
        title={roomState.title}
        participantCount={participantCount}
        connected={connected}
        transportNote={transportNote}
        isHost={isHost}
        role={role}
        locked={Boolean(roomState.locked)}
        savedNote={savedNote}
        onShareLink={shareLink}
      />

      {/* Device and network problems are stated inline rather than pushed into a
          toast from an effect — they persist, so they belong in the render. */}
      <div className="pointer-events-none absolute left-1/2 top-16 z-30 flex w-[min(92vw,44rem)] -translate-x-1/2 flex-col items-center gap-1.5 text-center">
        {!support.camera && (
          <p className="ftos-notice-warn rounded-lg px-3 py-2 text-[11px]">
            {support.reason === 'insecure-context'
              ? 'Camera and microphone need HTTPS (or localhost). You can still use the shared workspace and chat.'
              : 'This browser cannot open a camera. You can still use the shared workspace and chat.'}
          </p>
        )}
        {mediaError?.message && (
          <p className="ftos-notice-warn flex items-center gap-2 rounded-lg px-3 py-2 text-[11px]">
            {mediaError.message}
            {/* A busy camera is the one media failure that usually clears on its
                own — the other browser gets closed — so it gets a retry rather
                than only an explanation. */}
            {support.camera && !isVideoEnabled && (
              <button
                type="button"
                onClick={retryCamera}
                className="pointer-events-auto shrink-0 rounded border border-current/40 bg-current/10 px-1.5 py-0.5 font-semibold transition-opacity hover:opacity-80"
              >
                Retry camera
              </button>
            )}
          </p>
        )}
        {/**
         * Only shown once a peer connection has actually failed.
         *
         * This used to render the moment `fetchIceConfig` came back without TURN
         * credentials, which on a LAN or on localhost is every single call — so
         * every user was warned about a firewall problem they did not have, on a
         * connection that was about to work perfectly. A relay only matters when
         * the direct path fails, so that is when it is worth saying.
         */}
        {iceInfo.degraded && relayFailures > 0 && (
          <p className="ftos-notice-warn rounded-lg px-3 py-2 text-[11px]">
            Could not reach {relayFailures === 1 ? 'a participant' : `${relayFailures} participants`}{' '}
            directly, and no TURN relay is configured — set TURN_URLS plus TURN_SECRET (or
            TURN_USERNAME/TURN_PASSWORD) on the server to get through strict firewalls.
          </p>
        )}
        {followingPresenter && (
          <p className="ftos-notice-info rounded-lg px-3 py-2 text-[11px]">
            Following the host&apos;s view.
          </p>
        )}
      </div>

      <ParticipantList
        isOpen={panel === 'participants'}
        onClose={() => setPanel(null)}
        peers={peersForUi}
        localPeerId={peerId}
        localName={displayName}
        localRole={isHost ? 'host' : role}
        localHandRaised={handRaised}
        isHost={isHost}
        locked={Boolean(roomState.locked)}
        waiting={roomState.waiting}
        accessRequests={accessRequests}
        speakingIds={speakingIds}
        onModerate={runModeration}
        onAdmit={admit}
        onRespondAccess={respondAccess}
        onRename={(name) => {
          rename(name);
          onSessionPatch({ displayName: name });
        }}
      />

      <ChatPanel
        isOpen={panel === 'chat'}
        onClose={() => setPanel(null)}
        messages={messages}
        localPeerId={peerId}
        readOnly={readOnly}
        typingNames={typingNames}
        onSend={sendChat}
        onTyping={signalTyping}
      />

      <SessionTimeline
        isOpen={panel === 'timeline'}
        onClose={() => setPanel(null)}
        events={timelineEvents}
        readOnly={readOnly}
        exportStats={exportStats}
        onMarkDecision={markDecision}
        onExport={exportSession}
      />

      <ReactionsOverlay reactions={reactions} />

      <CallControls
        isMuted={!isAudioEnabled}
        isCameraOff={!isVideoEnabled}
        isScreenSharing={isScreenSharing}
        canShareScreen={support.screen}
        canEdit={canEdit}
        isHost={isHost}
        isHandRaised={handRaised}
        followingPresenter={followingPresenter}
        unreadChatCount={unreadChatCount}
        participantCount={participantCount}
        onToggleMic={toggleAudio}
        onToggleCamera={toggleVideo}
        onToggleScreenShare={shareScreen}
        onOpenWidget={openWidget}
        canUseWidget={canUseTool}
        onToggleParticipants={() => togglePanel('participants')}
        onToggleChat={() => togglePanel('chat')}
        onToggleTimeline={() => togglePanel('timeline')}
        onToggleFollow={toggleFollow}
        onToggleRaiseHand={toggleHand}
        onSendReaction={sendReaction}
        onShareLink={shareLink}
        onExport={exportSession}
        onEndCall={leaveCall}
        onEndForAll={isHost ? endForAll : undefined}
      />

      {toast && (
        <div
          key={toast.id}
          className={`ftos-rise pointer-events-none absolute bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-xl border px-4 py-2 text-xs font-medium shadow-xl backdrop-blur-md ${
            toast.level === 'warn' ? 'ftos-notice-warn' : 'ftos-panel'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

/**
 * The route itself: acquire a session, then mount the call.
 *
 * The split matters. `RoomWorkspace` is keyed on the server-issued `peerId`, so
 * it cannot mount until the server has said who we are — which is what makes it
 * impossible for this page to invent an identity or a host claim the way the old
 * one did. It also means the camera is requested as a direct result of pressing
 * "Join", not on page load.
 */
function RoomRoute() {
  const params = useParams();
  const searchParams = useSearchParams();
  const roomId = String(params?.roomId || '');
  // `?t=…` is an invite token, and it carries the role the host granted.
  const inviteToken = searchParams.get('t');

  const {
    displayName: accountName,
    user,
    loading: authLoading,
    authAvailable,
  } = useAuth();
  const { status, room, session, error, suggestedName, join, updateSession, leave } =
    useRoomSession(roomId, { inviteToken });

  if (!roomId) return <Panel title="No room specified">Check the link you followed.</Panel>;

  /**
   * The account check comes before the session check on purpose.
   *
   * `useRoomSession` auto-rejoins when it finds a stored session token, so
   * testing `!session` first would let a signed-out browser walk back into a
   * room it had previously joined and never see this gate.
   *
   * As on the home page, the requirement is skipped when `authAvailable` is
   * false: with no Firebase project there is no way to sign in, and refusing
   * entry to a door with no key would make every invite link dead. It is also
   * worth being clear that this is a product rule — the signaling server
   * authorizes on its own signed session and invite tokens, not on Firebase
   * identity.
   */
  if (authAvailable && authLoading) return <Spinner label="Checking your account…" />;
  if (authAvailable && !user) {
    return <SignInGate roomId={roomId} room={room} status={status} />;
  }

  if (!session) {
    return (
      <JoinGate
        roomId={roomId}
        room={room}
        status={status}
        error={error}
        suggestedName={accountName || suggestedName}
        onJoin={join}
      />
    );
  }

  return (
    <RoomWorkspace
      key={session.peerId}
      roomId={roomId}
      session={session}
      onSessionPatch={updateSession}
      onLeaveSession={leave}
    />
  );
}

export default function RoomPage() {
  // `useSearchParams` suspends, and an un-suspended call fails `next build`.
  return (
    <Suspense fallback={<Spinner label="Opening the room…" />}>
      <RoomRoute />
    </Suspense>
  );
}
