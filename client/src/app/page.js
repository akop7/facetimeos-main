'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import AuthModal from '../components/ui/AuthModal';
import ThemeSwitcher from '../components/ui/ThemeSwitcher';
import { useAuth } from '../context/AuthContext';
import { ApiError, rememberName, rememberedName, roomApi, saveHostToken } from '../lib/room-api';

/**
 * Creating a room used to run `localStorage.setItem('hostToken_' + id,
 * generateUUID())` — a credential the browser invented and the room then trusted,
 * so anyone could be host of any room by writing one key. Rooms are now minted by
 * `POST /rtc/rooms` and the host token is signed by the server, which re-verifies
 * it on every privileged action.
 *
 * Every entry point below is behind sign-in, so `openModal` is the one place that
 * decides between the room modal and the auth modal. `needsAccount` explains the
 * one case where it lets you through anyway.
 */
export default function Home() {
  const router = useRouter();
  const { user, logout, authAvailable } = useAuth();

  const [showModal, setShowModal] = useState(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  // Which modal to open once sign-in succeeds, so "Create Room → sign in" does
  // not dump you back on the landing page having to click Create Room again.
  const [pendingIntent, setPendingIntent] = useState(null);
  const [roomId, setRoomId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Creating and joining both require an account.
   *
   * The gate is deliberately skipped when Firebase is not configured: with no
   * auth provider there is no way to sign in, so enforcing it would lock every
   * door in the building and throw away the key. The room shows a banner in that
   * state instead of pretending to be protected.
   *
   * Worth being precise about what this is: a product rule, not a security
   * boundary. Room capabilities are enforced by the signaling server's signed
   * tokens; this check only decides who gets offered the door.
   */
  const needsAccount = authAvailable && !user;

  /**
   * The name is seeded here, in a click handler, rather than by an effect that
   * copies `user.displayName` into state — that effect was a
   * `set-state-in-effect` error, and reading `localStorage` during render would
   * mismatch hydration.
   */
  const openModal = useCallback(
    (which) => {
      if (needsAccount) {
        setPendingIntent(which);
        setShowAuthModal(true);
        return;
      }
      setError(null);
      setShowModal(which);
      setDisplayName((prev) => prev || user?.displayName || rememberedName());
    },
    [needsAccount, user]
  );

  /**
   * Takes the account from the sign-in call rather than from context: `user`
   * arrives one `onAuthStateChanged` tick later, and by then this render has
   * already decided whether to open the room modal.
   */
  const handleAuthenticated = useCallback(
    (account) => {
      setShowAuthModal(false);
      setError(null);
      setDisplayName((prev) => prev || account?.displayName || rememberedName());
      setShowModal(pendingIntent);
      setPendingIntent(null);
    },
    [pendingIntent]
  );

  const closeAuthModal = useCallback(() => {
    setShowAuthModal(false);
    setPendingIntent(null);
  }, []);

  const closeModal = useCallback(() => {
    setShowModal(null);
    setRoomId('');
    setError(null);
  }, []);

  const handleCreateRoom = useCallback(
    async (e) => {
      e.preventDefault();
      const name = displayName.trim();
      if (!name || busy) return;
      setBusy(true);
      setError(null);
      try {
        // Same possessive rule the server applies when somebody reaches a room
        // by link instead of creating it here ("Chris' room", not "Chris's"), so
        // the two routes cannot produce two different names for one room.
        const title = `${name}${/s$/i.test(name) ? "'" : "'s"} room`;
        const room = await roomApi.createRoom(title);
        // The room page reads the host token back out of this key and presents it
        // to the server, which decides whether it really grants host.
        saveHostToken(room.roomId, room.hostToken);
        rememberName(name);
        router.push(`/room/${room.roomId}`);
      } catch (err) {
        setError(
          err instanceof ApiError ? err.message : 'Could not reach the meeting server.'
        );
        setBusy(false);
      }
    },
    [busy, displayName, router]
  );

  const handleJoinRoom = useCallback(
    (e) => {
      e.preventDefault();
      const name = displayName.trim();
      // People paste the whole invite link far more often than a bare id, so
      // accept both — and keep the `?t=` invite token if it is there.
      const raw = roomId.trim();
      const match = raw.match(/\/room\/([^/?#]+)(\?[^#]*)?/);
      const target = match ? `${match[1]}${match[2] || ''}` : raw;
      if (!name || !target) return;
      rememberName(name);
      router.push(`/room/${target}`);
    },
    [displayName, roomId, router]
  );

  return (
    <div className="site-shell flex min-h-[100dvh] flex-col">
      <AuthModal
        isOpen={showAuthModal}
        onClose={closeAuthModal}
        onSuccess={handleAuthenticated}
        reason={
          pendingIntent === 'create'
            ? 'Sign in to create a room.'
            : pendingIntent === 'join'
              ? 'Sign in to join a room.'
              : undefined
        }
      />

      <header className="site-header fixed inset-x-0 top-0 z-50">
        <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="brand-mark" aria-hidden="true" />
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
                FaceTimeOS
              </span>
              <span className="hidden text-[11px] font-medium text-[var(--text-muted)] sm:inline">
                shared room
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <ThemeSwitcher />
            <button
              onClick={() => openModal('join')}
              className="text-action hidden px-3 py-2 sm:block"
            >
              Join a room
            </button>
            <button
              onClick={() => openModal('create')}
              className="primary-action min-h-9 px-3.5 py-2"
            >
              New room
            </button>
            {user ? (
              <div className="ml-1 flex items-center gap-2">
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent-primary)] ring-1 ring-[var(--border-subtle)]"
                  title={user.displayName || user.email}
                >
                  {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
                </div>
                <button
                  onClick={logout}
                  className="text-action hidden px-2.5 py-2 md:block"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                className="text-action px-2.5 py-2"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 pt-16">
        <section className="mx-auto w-full max-w-[1180px] px-4 pb-16 pt-16 sm:px-6 sm:pt-24 lg:pb-24 lg:pt-28">
          <div className="grid items-center gap-12 lg:grid-cols-[0.82fr_1.18fr] lg:gap-16">
            <div>
              <p className="eyebrow mb-6">Built for working sessions</p>
              <h1 className="max-w-2xl text-[clamp(2.65rem,6.5vw,5.6rem)] font-semibold leading-[0.98] tracking-[-0.065em] text-[var(--text-primary)]">
                The call where the work stays open.
              </h1>
              <p className="mt-7 max-w-xl text-base leading-7 text-[var(--text-secondary)] sm:text-lg">
                Video, code, notes, a whiteboard, and the decisions you made—arranged in one room
                instead of scattered across six tabs.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <button
                  onClick={() => openModal('create')}
                  className="primary-action px-5"
                >
                  Start a room
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
                <button
                  onClick={() => openModal('join')}
                  className="secondary-action px-5"
                >
                  Join with a link
                </button>
              </div>
              <p className="mt-6 max-w-md text-[13px] leading-5 text-[var(--text-muted)]">
                {needsAccount
                  ? 'Sign in once, then send the room link. Nothing to install.'
                  : 'Open it in your browser. Nothing to install.'}
              </p>
            </div>

            <div className="workspace-preview min-h-[430px] w-full">
              <div className="flex h-12 items-center justify-between border-b border-[#283240] px-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="truncate text-xs font-semibold">Design review</span>
                  <span className="hidden text-[11px] text-[#8491a2] sm:inline">3 people · live</span>
                </div>
                <div className="flex -space-x-1.5">
                  {['AK', 'JS', 'MR'].map((name, index) => (
                    <span
                      key={name}
                      className="grid h-7 w-7 place-items-center rounded-full border-2 border-[#0c1118] text-[9px] font-semibold"
                      style={{ background: ['#315fda', '#916b45', '#476f67'][index] }}
                    >
                      {name}
                    </span>
                  ))}
                </div>
              </div>
              <div className="relative grid min-h-[378px] grid-cols-[1fr_8rem] gap-2 p-2 sm:grid-cols-[1fr_10rem]">
                <div className="relative overflow-hidden rounded-[10px] border border-[#293442] bg-[#151c25]">
                  <div className="absolute inset-0 grid place-items-center">
                    <div className="grid h-20 w-20 place-items-center rounded-full bg-[#26364d] text-xl font-semibold text-[#b7cae7]">
                      AK
                    </div>
                  </div>
                  <div className="absolute bottom-3 left-3 rounded-md border border-white/10 bg-black/50 px-2 py-1 text-[10px] text-white/80">
                    Alok · presenting
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  {[['JS', '#57446b'], ['MR', '#3b5a55']].map(([name, color]) => (
                    <div key={name} className="relative flex-1 rounded-[10px] border border-[#293442]" style={{ background: color }}>
                      <span className="absolute bottom-2 left-2 text-[10px] font-medium text-white/80">{name}</span>
                    </div>
                  ))}
                </div>

                <div className="preview-window absolute bottom-5 left-5 right-16 h-[178px] overflow-hidden sm:right-24">
                  <div className="flex h-9 items-center justify-between border-b border-[#303b4a] bg-[#1b2430] px-3">
                    <div className="flex items-center gap-2">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8dafff" strokeWidth="2" aria-hidden="true">
                        <path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />
                      </svg>
                      <span className="text-[10px] font-semibold">checkout.js</span>
                    </div>
                    <span className="text-[9px] text-[#8491a2]">Edited just now</span>
                  </div>
                  <div className="grid h-[139px] grid-cols-[2rem_1fr] bg-[#10161e] font-mono text-[10px] leading-5">
                    <div className="border-r border-[#25303d] py-3 pr-2 text-right text-[#526071]">8<br />9<br />10<br />11<br />12</div>
                    <div className="p-3 text-[#9ca8b8]">
                      <div><span className="text-[#c5a3ff]">const</span> <span className="text-[#8db5ff]">room</span> = await createRoom();</div>
                      <div><span className="text-[#c5a3ff]">await</span> room.connect();</div>
                      <div>&nbsp;</div>
                      <div><span className="text-[#6fc7a8]">{'// Shared with everyone'}</span></div>
                      <div className="inline-block border-r border-[#7fa7ff] bg-[#315fda]/25 pr-0.5">room.open(notes)</div>
                    </div>
                  </div>
                </div>

                <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-[#394554] bg-[#151c26]/95 p-1.5 shadow-xl">
                  {[
                    ['Mic', 'M'],
                    ['Camera', 'C'],
                    ['Tools', '+'],
                    ['Chat', '…'],
                  ].map(([label, glyph]) => (
                    <div key={label} className="flex h-8 min-w-8 items-center justify-center rounded-md bg-white/[0.06] px-2 text-[9px] text-[#c6ced9]" title={label}>
                      {glyph}
                    </div>
                  ))}
                  <div className="flex h-8 items-center rounded-md bg-[#c74646] px-2.5 text-[9px] font-semibold">Leave</div>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-14 grid gap-5 border-t border-[var(--border-subtle)] pt-6 text-[13px] text-[var(--text-muted)] sm:grid-cols-3 lg:mt-20">
            <p><strong className="font-semibold text-[var(--text-secondary)]">Peer-to-peer media.</strong> Your video is not recorded or mixed on a server.</p>
            <p><strong className="font-semibold text-[var(--text-secondary)]">Work that survives.</strong> Notes, code, layout, and chat are there when you return.</p>
            <p><strong className="font-semibold text-[var(--text-secondary)]">Files you can keep.</strong> Export the session as code, Markdown, SVG, and JSON.</p>
          </div>
        </section>

        <section className="border-y border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <div className="mx-auto grid w-full max-w-[1180px] gap-12 px-4 py-16 sm:px-6 md:grid-cols-[0.7fr_1.3fr] lg:py-24">
            <div>
              <p className="eyebrow mb-5">Inside the room</p>
              <h2 className="max-w-sm text-3xl font-semibold leading-tight tracking-[-0.04em] text-[var(--text-primary)] sm:text-4xl">
                Less presenting. More doing.
              </h2>
              <p className="mt-5 max-w-sm text-[15px] leading-6 text-[var(--text-secondary)]">
                Open a tool beside the call, move it where it makes sense, and let everyone work in it.
              </p>
            </div>

            <div className="hairline-list border-y border-[var(--border-subtle)]">
              {[
                ['01', 'Code together', 'A shared Monaco editor with conflict-free editing and a sandboxed JavaScript runner.'],
                ['02', 'Draw the hard part', 'Sketch an architecture, connect ideas with arrows, and export the board as SVG.'],
                ['03', 'Keep the useful bits', 'Notes, chat, room layout, and marked decisions persist after everyone leaves.'],
                ['04', 'Bring context closer', 'Open a reference page or set a visible timer without leaving the conversation.'],
              ].map(([number, title, copy]) => (
                <article key={number} className="grid gap-3 py-6 sm:grid-cols-[3rem_11rem_1fr] sm:items-baseline sm:gap-5">
                  <span className="font-mono text-xs text-[var(--accent-secondary)]">{number}</span>
                  <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h3>
                  <p className="text-sm leading-6 text-[var(--text-secondary)]">{copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[1180px] px-4 py-16 sm:px-6 lg:py-24">
          <div className="grid gap-12 md:grid-cols-[0.7fr_1.3fr]">
            <div>
              <p className="eyebrow mb-5">The honest details</p>
              <h2 className="max-w-sm text-3xl font-semibold leading-tight tracking-[-0.04em] sm:text-4xl">
                Know what you are opening.
              </h2>
            </div>
            <dl className="border-y border-[var(--border-subtle)]">
              {[
                ['Room size', 'Best with roughly six people. Peer-to-peer video asks more of each connection as the room grows.'],
                ['Privacy', 'Media stays encrypted between browsers. The signaling service coordinates the room but does not decode the call.'],
                ['Persistence', 'Shared documents and room state are stored with the room so a reload does not erase the work.'],
                ['Permissions', 'Host, editor, and viewer access are verified with signed room tokens—not browser-made role flags.'],
                ['Export', 'One ZIP with source, notes, chat, timeline data, and the whiteboard as an SVG.'],
              ].map(([term, description]) => (
                <div key={term} className="fact-row border-b border-[var(--border-subtle)] last:border-b-0">
                  <dt className="text-sm font-semibold text-[var(--text-primary)]">{term}</dt>
                  <dd className="m-0 text-sm leading-6 text-[var(--text-secondary)]">{description}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="border-t border-[var(--border-subtle)]">
          <div className="mx-auto flex w-full max-w-[1180px] flex-col items-start justify-between gap-8 px-4 py-14 sm:px-6 md:flex-row md:items-center lg:py-20">
            <div>
              <h2 className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Bring one other person.</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">Open the editor while you talk. You will know in five minutes if it fits.</p>
            </div>
            <button onClick={() => openModal('create')} className="primary-action shrink-0 px-5">
              Start a room
            </button>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-4 py-7 text-xs text-[var(--text-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="brand-mark !h-6 !w-6 !rounded-md" aria-hidden="true" />
            <span className="font-medium text-[var(--text-secondary)]">FaceTimeOS</span>
          </div>
          <p className="m-0">A B.Tech CSE project built with WebRTC and Yjs.</p>
        </div>
      </footer>

      {showModal && (
        <div
          className="dialog-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fade-in"
          onClick={closeModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="room-dialog-title"
        >
          <div
            className="dialog-surface relative w-full max-w-[28rem] p-6 animate-scale-in sm:p-7"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              onClick={closeModal}
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]"
              aria-label="Close dialog"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>

            <p className="eyebrow mb-4">{showModal === 'create' ? 'New session' : 'Have an invite?'}</p>
            <h2 id="room-dialog-title" className="pr-8 text-2xl font-semibold tracking-[-0.035em] text-[var(--text-primary)]">
              {showModal === 'create' ? 'Create a room' : 'Join a room'}
            </h2>
            <p className="mb-6 mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              {showModal === 'create'
                ? 'You will host the room. Once it opens, copy the invite link for everyone else.'
                : 'Paste the full invite link or the room ID from the end of it.'}
            </p>

            <form onSubmit={showModal === 'create' ? handleCreateRoom : handleJoinRoom} className="flex flex-col gap-4">
              <div>
                <label htmlFor="room-display-name" className="field-label">Your name</label>
                <input
                  id="room-display-name"
                  type="text"
                  required
                  autoFocus
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  className="field-input"
                  placeholder="How others will see you"
                />
              </div>

              {showModal === 'join' && (
                <div>
                  <label htmlFor="room-link" className="field-label">Room link or ID</label>
                  <input
                    id="room-link"
                    type="text"
                    required
                    value={roomId}
                    onChange={(event) => setRoomId(event.target.value)}
                    className="field-input"
                    placeholder="Paste the invite here"
                  />
                </div>
              )}

              {error && <p className="ftos-notice-warn rounded-md px-3 py-2 text-[13px]" role="alert">{error}</p>}

              <button type="submit" disabled={busy} className="primary-action mt-1 w-full disabled:cursor-not-allowed disabled:opacity-60">
                {showModal === 'create' ? (busy ? 'Creating…' : 'Create room') : 'Join room'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
