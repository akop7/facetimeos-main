'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useYMapValue } from '../../hooks/useYjs';

/**
 * The room clock — shared, and correct.
 *
 * The old version kept `secondsLeft` in React state and ticked it locally on
 * every client, broadcasting the number after each control press. Three
 * consequences, all of which showed up in a real call:
 *
 *  - Every participant drifted independently. `setInterval(…, 1000)` is not a
 *    clock; it is throttled to once a minute in a background tab, so anyone who
 *    switched tabs came back with a timer minutes behind everyone else's.
 *  - A reload lost the timer entirely, because nothing was persisted.
 *  - A late joiner saw the default five minutes until someone pressed a button.
 *
 * The fix is to store *when*, not *how much*: a single anchor timestamp plus the
 * amount already banked. Every client derives the display from its own
 * `Date.now()`, so a throttled tab is instantly right again on its next paint,
 * and the whole thing survives a reload because it lives in the room document.
 *
 * The residual error is clock skew between machines rather than accumulated
 * drift — bounded by whatever NTP gives you, and it no longer grows with the
 * length of the meeting.
 */

const DEFAULT_DURATION = 5 * 60_000;
const PRESETS = [5, 10, 15, 25, 45];

const IDLE = Object.freeze({
  mode: 'countdown',
  /** epoch ms when the clock was last started, or null while paused. */
  anchor: null,
  /** ms already banked: time remaining (countdown) or elapsed (stopwatch). */
  base: DEFAULT_DURATION,
  /** what a reset goes back to. */
  duration: DEFAULT_DURATION,
  by: null,
});

function sanitize(value) {
  if (!value || typeof value !== 'object') return IDLE;
  const mode = value.mode === 'stopwatch' ? 'stopwatch' : 'countdown';
  const duration = Number.isFinite(value.duration) ? Math.max(0, value.duration) : DEFAULT_DURATION;
  return {
    mode,
    anchor: Number.isFinite(value.anchor) ? value.anchor : null,
    base: Number.isFinite(value.base) ? value.base : mode === 'countdown' ? duration : 0,
    duration,
    by: typeof value.by === 'string' ? value.by : null,
  };
}

/** ms on the face right now. Negative in a countdown means it has overrun. */
function readClock(timer, now) {
  const running = timer.anchor !== null;
  const since = running ? Math.max(0, now - timer.anchor) : 0;
  return timer.mode === 'countdown' ? timer.base - since : timer.base + since;
}

function format(ms) {
  const total = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export default function MeetingTimer({ meta, displayName, readOnly = false, onActivity, onExpire }) {
  const [stored, writeTimer] = useYMapValue(meta, 'timer', IDLE);
  const [localTimer, setLocalTimer] = useState(IDLE);
  const timer = useMemo(() => sanitize(meta ? stored : localTimer), [meta, stored, localTimer]);
  const publish = meta ? writeTimer : setLocalTimer;

  const [now, setNow] = useState(() => Date.now());
  const running = timer.anchor !== null;
  const value = readClock(timer, now);
  const expired = timer.mode === 'countdown' && value <= 0;

  /* Ticking only drives the display; the numbers come from the timestamps, so
     a missed tick is a missed repaint rather than lost time. 250 ms keeps the
     seconds digit from visibly lagging without being a busy loop. */
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  // A paused clock ignores `now` entirely (`readClock` adds nothing when there
  // is no anchor), and a start sets the anchor to a moment at or after the last
  // sampled `now`, so a stale sample still reads as exactly the banked value.
  // That is why there is no effect here re-sampling the clock.

  const firedFor = useRef(null);
  useEffect(() => {
    if (!expired || !running) return;
    const key = `${timer.anchor}:${timer.base}`;
    if (firedFor.current === key) return;
    firedFor.current = key;
    onExpire?.({ by: timer.by });
  }, [expired, running, timer.anchor, timer.base, timer.by, onExpire]);

  const commit = useCallback(
    (patch) => {
      if (readOnly) return;
      publish({ ...timer, ...patch, by: displayName || null });
      onActivity?.();
    },
    [readOnly, publish, timer, displayName, onActivity]
  );

  const toggle = useCallback(() => {
    if (running) {
      // Bank what has elapsed so far and drop the anchor — that is the whole of
      // "pause", and it means a paused clock needs no ticking anywhere.
      commit({ anchor: null, base: readClock(timer, Date.now()) });
      return;
    }
    if (timer.mode === 'countdown' && readClock(timer, Date.now()) <= 0) {
      commit({ anchor: Date.now(), base: timer.duration });
      return;
    }
    commit({ anchor: Date.now() });
  }, [running, timer, commit]);

  const reset = useCallback(() => {
    commit({ anchor: null, base: timer.mode === 'countdown' ? timer.duration : 0 });
  }, [commit, timer.mode, timer.duration]);

  const switchMode = useCallback(
    (mode) => {
      if (mode === timer.mode) return;
      commit({
        mode,
        anchor: null,
        base: mode === 'countdown' ? timer.duration : 0,
      });
    },
    [commit, timer.mode, timer.duration]
  );

  const setPreset = useCallback(
    (minutes) => {
      const duration = minutes * 60_000;
      commit({ mode: 'countdown', anchor: null, base: duration, duration });
    },
    [commit]
  );

  const overrun = timer.mode === 'countdown' && value < 0;
  const fraction =
    timer.mode === 'countdown' && timer.duration > 0
      ? Math.min(1, Math.max(0, value / timer.duration))
      : 0;
  const tone = overrun ? 'text-red-500' : fraction > 0 && fraction < 0.1 ? 'text-amber-500' : 'text-[var(--on-surface)]';

  return (
    <div className="flex h-full w-full select-none flex-col items-center justify-between bg-[var(--surface-panel)] p-5 font-sans text-[var(--on-surface)]">
      <div className="flex items-center gap-1 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-raised)] p-1 text-xs">
        {['countdown', 'stopwatch'].map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => switchMode(mode)}
            disabled={readOnly}
            className={`rounded-md px-3 py-1.5 font-semibold capitalize transition-colors disabled:opacity-40 ${
              timer.mode === mode ? 'bg-[var(--accent-primary-strong)] text-white' : 'text-[var(--on-surface-muted)] hover:text-[var(--on-surface)]'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>

      <div className="my-auto w-full text-center">
        <div
          className={`font-mono text-6xl font-extrabold tracking-tight drop-shadow-md ${tone} ${
            overrun ? 'animate-pulse' : ''
          }`}
        >
          {overrun ? '−' : ''}
          {format(value)}
        </div>
        <p className="mt-2.5 text-[13px] font-medium text-[var(--on-surface-muted)]">
          {timer.mode === 'stopwatch'
            ? 'Elapsed meeting time'
            : overrun
              ? 'Over time'
              : running
                ? 'Remaining'
                : 'Paused'}
        </p>

        {timer.mode === 'countdown' && timer.duration > 0 && (
          <div className="mx-auto mt-4 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-[var(--surface-raised)]">
            <div
              className={`h-full rounded-full transition-[width] duration-200 ${
                overrun ? 'bg-red-500' : fraction < 0.1 ? 'bg-amber-400' : 'bg-blue-500'
              }`}
              style={{ width: `${overrun ? 100 : fraction * 100}%` }}
            />
          </div>
        )}
      </div>

      {timer.mode === 'countdown' && (
        <div className="mb-3 flex items-center gap-1.5">
          {PRESETS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              onClick={() => setPreset(minutes)}
              disabled={readOnly}
            className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-40 ${
                timer.duration === minutes * 60_000
                  ? 'border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-200'
                  : 'border-[var(--surface-border)] bg-[var(--surface-raised)] text-[var(--on-surface-muted)] hover:text-[var(--on-surface)]'
              }`}
            >
              {minutes}m
            </button>
          ))}
        </div>
      )}

      <div className="flex w-full max-w-xs items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          disabled={readOnly}
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
            running
              ? 'border border-amber-500/30 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
              : 'bg-blue-600 text-white shadow-md hover:bg-blue-500'
          }`}
        >
          <span>{running ? 'Pause' : expired ? 'Restart' : 'Start'}</span>
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={readOnly}
          className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-raised)] px-4 py-2.5 text-xs font-semibold text-[var(--on-surface)] transition-colors hover:bg-[var(--bg-muted)] disabled:opacity-40"
        >
          Reset
        </button>
      </div>

      <p className="mt-3 text-center text-xs text-[var(--on-surface-muted)]">
        {meta ? 'Synced from a shared deadline — survives a reload' : 'Local only — no room document'}
        {timer.by ? ` · last set by ${timer.by}` : ''}
        {readOnly && <span className="ml-1 font-semibold text-amber-400">· view only</span>}
      </p>
    </div>
  );
}
