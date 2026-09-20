'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Who is talking right now, measured rather than announced.
 *
 * Every participant already has every other participant's audio, so the level
 * can be read locally with one `AudioContext` and one analyser per stream. That
 * is strictly better than the usual design of broadcasting "I am speaking"
 * frames: no protocol, no bandwidth, no trust — a peer cannot claim the active
 * speaker slot it does not deserve — and it keeps working for a peer whose
 * client is older than this code.
 *
 * The thresholds are hysteretic on purpose. A single level test flickers on
 * every consonant, so a tile has to clear a higher bar to light up than to stay
 * lit, and it stays lit for `HOLD_MS` after the level drops.
 */

const SPEAK_ON = 0.045;
const SPEAK_OFF = 0.02;
const HOLD_MS = 600;
const SAMPLE_MS = 120;

export function useActiveSpeakers(streamsById) {
  const [speaking, setSpeaking] = useState(() => new Set());
  const ctxRef = useRef(null);
  const nodesRef = useRef(new Map());
  const untilRef = useRef(new Map());

  const release = useCallback((id) => {
    const entry = nodesRef.current.get(id);
    if (!entry) return;
    try {
      entry.source.disconnect();
      entry.analyser.disconnect();
    } catch {
      /* Already torn down with the context. */
    }
    nodesRef.current.delete(id);
    untilRef.current.delete(id);
  }, []);

  useEffect(() => {
    const AudioCtx =
      typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AudioCtx) return undefined;
    if (!ctxRef.current) ctxRef.current = new AudioCtx();
    const ctx = ctxRef.current;
    const nodes = nodesRef.current;

    // Attach an analyser to anything new, drop anything that has gone.
    for (const [id, stream] of streamsById) {
      const track = stream?.getAudioTracks?.()[0];
      const existing = nodes.get(id);
      if (!track) {
        if (existing) release(id);
        continue;
      }
      if (existing?.trackId === track.id) continue;
      if (existing) release(id);
      try {
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        nodes.set(id, { source, analyser, trackId: track.id, buffer: new Uint8Array(analyser.fftSize) });
      } catch {
        /* A stream with no live audio track cannot be analysed; skip it. */
      }
    }
    for (const id of [...nodes.keys()]) {
      if (!streamsById.has(id)) release(id);
    }

    const timer = setInterval(() => {
      // A suspended context yields silence; browsers suspend until a gesture.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const now = Date.now();
      const until = untilRef.current;

      for (const [id, entry] of nodes) {
        entry.analyser.getByteTimeDomainData(entry.buffer);
        let sum = 0;
        for (let i = 0; i < entry.buffer.length; i += 1) {
          const centred = (entry.buffer[i] - 128) / 128;
          sum += centred * centred;
        }
        const rms = Math.sqrt(sum / entry.buffer.length);
        const held = (until.get(id) || 0) > now;
        if (rms > SPEAK_ON || (held && rms > SPEAK_OFF)) until.set(id, now + HOLD_MS);
      }

      // setState from a timer callback, not from the effect body — this is the
      // sanctioned way to publish a measurement without a cascading render.
      setSpeaking((prev) => {
        const next = new Set();
        for (const [id, expiry] of until) if (expiry > now) next.add(id);
        if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
        return next;
      });
    }, SAMPLE_MS);

    return () => clearInterval(timer);
  }, [streamsById, release]);

  useEffect(
    () => () => {
      for (const id of [...nodesRef.current.keys()]) release(id);
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    },
    [release]
  );

  return speaking;
}
