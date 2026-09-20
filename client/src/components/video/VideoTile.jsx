'use client';

import React, { useEffect, useRef, useState } from 'react';

/**
 * One participant tile.
 *
 * The previous version decided whether the camera was off by reading
 * `stream.getVideoTracks()[0].enabled` — during render. A `MediaStreamTrack` is
 * not a React state source: toggling `enabled` mutates the track and schedules
 * nothing, so the avatar placeholder only appeared if some unrelated state
 * happened to change. Mute and camera state are now props, fed from the local
 * media hook for your own tile and from the peer's announced `MEDIA_STATE` for
 * everyone else's.
 *
 * `object-contain` for a screen share and `object-cover` for a camera: cropping
 * a shared screen cuts off exactly the edges people are pointing at.
 */

const QUALITY = {
  good: { dot: 'bg-emerald-500', label: 'Good connection' },
  fair: { dot: 'bg-amber-400', label: 'Fair connection — some packet loss' },
  poor: { dot: 'bg-red-500', label: 'Poor connection' },
};

/* Meeting overlays stay dark over every video, independent of the site theme. */
const ROLE_BADGE = {
  host: {
    text: 'Host',
    className: 'border-amber-300/20 bg-amber-400/10 text-amber-200',
  },
  viewer: {
    text: 'Viewer',
    className: 'border-white/10 bg-white/[0.06] text-white/65',
  },
};

/**
 * The `<video>` element, its playback and its two silent failure modes.
 *
 * Mounted with `key={stream.id}` by the tile, so every one of these states
 * starts fresh for a new stream instead of needing a reset effect.
 *
 * Both failures produce the same thing on screen — a black rectangle where a
 * face should be — and neither one is visible to the code that hands us the
 * stream, which is why "I joined and their camera just does not show" was so
 * hard to pin down:
 *
 *  - `play()` rejects. A remote tile is not muted (you want to hear people), and
 *    an unmuted autoplay is the exact thing Chrome's autoplay policy blocks. The
 *    element then sits on frame zero forever, with no error anywhere.
 *  - The track is live but carries no frames. A camera already held by another
 *    application — a second browser on the same machine, most often — hands out
 *    a track that is neither ended nor muted and simply never delivers a picture.
 *
 * `videoWidth` is the honest test for the second one: it stays 0 until a real
 * frame has been decoded.
 */
function TileVideo({ stream, isLocal, isScreenShare, isHidden, initial }) {
  const videoRef = useRef(null);
  const [state, setState] = useState('waiting');

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;
    // Assigning the same object again restarts playback in Safari, so guard.
    if (node.srcObject !== (stream || null)) node.srcObject = stream || null;
    if (!stream) return;
    // Asynchronous by contract, so this resolves after the effect has returned —
    // it is not a set-state-during-effect.
    node.play?.().catch(() => setState('blocked'));
  }, [stream]);

  const settle = () => {
    const node = videoRef.current;
    if (!node) return;
    setState(node.videoWidth > 0 ? 'playing' : 'waiting');
  };

  const hasVideoTrack = Boolean(stream?.getVideoTracks?.().length);
  const stalled = !isHidden && hasVideoTrack && state !== 'playing';

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        // Never play your own audio back — that is a feedback loop, not a bug in
        // the user's headphones.
        muted={isLocal}
        onPlaying={settle}
        onLoadedMetadata={settle}
        // Fires when the frame size first becomes known, which is the moment a
        // stalled track starts delivering.
        onResize={settle}
        className={`h-full w-full ${isScreenShare ? 'object-contain' : 'object-cover'} ${
          isLocal && !isScreenShare ? 'scale-x-[-1]' : ''
        } ${isHidden || stalled ? 'invisible' : ''}`}
      />

      {stalled && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--surface-panel)] px-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--accent-soft)] text-3xl font-semibold text-[var(--accent-primary)] ring-1 ring-[var(--surface-border)]">
            {initial}
          </div>
          {state === 'blocked' ? (
            <button
              type="button"
              onClick={() => videoRef.current?.play().then(settle, () => {})}
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-raised)] px-3 py-1.5 text-[11px] font-semibold text-[var(--on-surface)]"
            >
              Tap to start video
            </button>
          ) : (
            <span className="ftos-muted max-w-[16rem] text-[11px] font-medium leading-relaxed">
              {isLocal
                ? 'Waiting for your camera to send a picture.'
                : 'Their camera is on but no picture is arriving yet — often another app on their machine is already using it.'}
            </span>
          )}
        </div>
      )}
    </>
  );
}

export default function VideoTile({
  stream,
  displayName,
  isLocal = false,
  isMuted = false,
  isCameraOff = false,
  isScreenShare = false,
  mutedByHost = false,
  handRaised = false,
  isSpeaking = false,
  role = 'editor',
  quality = 'good',
  connectionState,
  isPinned = false,
  onTogglePin,
}) {
  const q = QUALITY[quality] || QUALITY.good;
  const badge = ROLE_BADGE[role];
  const reconnecting = connectionState === 'disconnected' || connectionState === 'connecting';
  const initial = displayName ? displayName.trim().charAt(0).toUpperCase() : '?';

  return (
    <div
      className={`group relative flex h-full w-full items-center justify-center overflow-hidden rounded-[10px] border bg-[#11161d] shadow-sm transition-colors duration-150 ${
        isSpeaking && !isMuted
          ? 'border-emerald-400/70 shadow-[0_0_0_2px_rgba(52,211,153,0.35)]'
          : 'border-white/10'
      }`}
    >
      <TileVideo
        /* Remounts on a new stream, so the playback state cannot be inherited
           from the previous one. */
        key={stream?.id || 'no-stream'}
        stream={stream}
        isLocal={isLocal}
        isScreenShare={isScreenShare}
        isHidden={isCameraOff}
        initial={initial}
      />

      {isCameraOff && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#11161d]">
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-[#1d2d47] text-4xl font-semibold text-[#9cbbff] ring-1 ring-white/10">
            {initial}
          </div>
          {/* Was `text-white/40`: white at 40% over a white light-theme panel is
              nothing at all, which is why the caption under the avatar could not
              be read. `ftos-muted` follows the theme. */}
          <span className="ftos-muted text-[11px] font-medium">
            {isLocal ? 'Your camera is off' : 'Camera off'}
          </span>
        </div>
      )}

      {handRaised && (
        <div className="ftos-notice-warn absolute left-3 top-3 flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold backdrop-blur-md">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M8 11V5a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v4c0 5-3 8-8 8h-1c-3 0-5-2-7-5l-2-3a1.7 1.7 0 0 1 2.7-2l3.3 3"/></svg>
          <span>Hand raised</span>
        </div>
      )}

      {isScreenShare && (
        <div className="ftos-notice-info absolute right-3 top-3 rounded-lg px-2.5 py-1 text-[11px] font-semibold backdrop-blur-md">
          Sharing screen
        </div>
      )}

      {reconnecting && (
        <div className="ftos-notice-warn absolute inset-x-0 top-0 py-1 text-center text-[11px] font-medium backdrop-blur-md">
          Reconnecting…
        </div>
      )}

      <div className="absolute inset-x-3 bottom-3 flex items-end justify-between gap-2">
        <div className="room-video-label flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${q.dot}`} title={q.label} />
          <span className="truncate text-[12px] font-semibold text-white">
            {isLocal ? 'You' : displayName || 'Participant'}
          </span>
          {badge && (
            <span className={`rounded-md border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.08em] ${badge.className}`}>
              {badge.text}
            </span>
          )}
          {isMuted && (
            <span
              className="text-red-500 dark:text-red-400"
              title={mutedByHost ? 'Muted by the host' : 'Microphone off'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m3 3 18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 10V5a3 3 0 0 0-5.7-1.3M17.4 17.4A7 7 0 0 1 5 12v-2M19 10v2c0 .7-.1 1.4-.3 2M12 19v3"/></svg>
            </span>
          )}
        </div>

        {onTogglePin && (
          <button
            type="button"
            onClick={onTogglePin}
            className={`room-video-action grid h-9 w-9 place-items-center rounded-lg transition-[opacity,background-color,border-color] ${
              isPinned
                ? 'opacity-100'
                : 'text-white/75 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100'
            }`}
            title={isPinned ? 'Unpin tile' : 'Pin tile'}
            aria-label={isPinned ? 'Unpin tile' : 'Pin tile'}
            aria-pressed={isPinned}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 3 6 6"/><path d="m12 6 4-4 6 6-4 4"/><path d="m8 10-5 5 6 6 5-5"/><path d="m2 22 6-6"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
