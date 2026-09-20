'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  roomApi,
  saveSession,
  loadSession,
  clearSession,
  rememberedName,
  loadHostToken,
  ApiError,
} from '../lib/room-api';

/**
 * Acquire a server-issued session for a room.
 *
 * This is the piece that replaces "the browser decides who it is". Previously
 * the room page generated its own `peerId` with `uuidv4()` and read
 * `localStorage['hostToken_<room>']` to decide whether it was the host — both
 * fully attacker-controlled. Now the only identity is a signed session token,
 * and the only way to get one is to ask the server.
 *
 * Order of attempts:
 *   1. a stored session token for this room (survives reload, keeps your seat)
 *   2. the host token, if this browser created the room
 *   3. an invite token from the URL (`?t=…`), which carries a role
 *   4. a plain guest join — no account, no token, editor by default
 */
export function useRoomSession(roomId, { inviteToken } = {}) {
  // 'probing' is the honest initial state: the effect below always runs for a
  // real room id, and starting at 'idle' only to overwrite it synchronously from
  // the effect is a wasted render.
  const [status, setStatus] = useState(roomId ? 'probing' : 'idle');
  const [room, setRoom] = useState(null);
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [suggestedName, setSuggestedName] = useState('');
  const joinRef = useRef(null);

  const join = useCallback(
    async (displayName) => {
      if (!roomId) return null;
      setStatus('joining');
      setError(null);

      const stored = loadSession(roomId);
      const hostToken = loadHostToken(roomId);

      const attempts = [];
      if (stored?.sessionToken) attempts.push({ resumeToken: stored.sessionToken });
      if (hostToken) attempts.push({ inviteToken: hostToken });
      if (inviteToken) attempts.push({ inviteToken });
      attempts.push({});

      let lastError = null;
      for (const attempt of attempts) {
        try {
          const result = await roomApi.createSession(roomId, {
            displayName: displayName || stored?.displayName || 'Guest',
            ...attempt,
          });
          saveSession(roomId, result);
          setSession(result);
          setStatus('joined');
          return result;
        } catch (err) {
          lastError = err;
          // A stale or wrong-room token should fall through to the next strategy
          // rather than blocking the join outright.
          if (attempt.resumeToken) clearSession(roomId);
          if (err instanceof ApiError && err.code === 'offline') break;
        }
      }

      setError(lastError?.message || 'Could not join this room.');
      setStatus('error');
      return null;
    },
    [roomId, inviteToken]
  );

  // Declared before the probe effect so the ref is populated by the time the
  // probe resolves. Effects run in declaration order.
  useEffect(() => {
    joinRef.current = join;
  }, [join]);

  /* Probe first so we can show "this room has saved work" or "the room is
     locked" before asking anyone to turn their camera on. */
  useEffect(() => {
    if (!roomId) return undefined;
    const controller = new AbortController();

    const settle = (info) => {
      if (controller.signal.aborted) return;
      setRoom(info);
      const remembered = rememberedName();
      setSuggestedName(remembered);

      const stored = loadSession(roomId);
      const hostToken = loadHostToken(roomId);
      if (stored?.sessionToken || hostToken) {
        // A returning participant, or the person who created the room, should
        // not be asked to type their name again because they refreshed.
        joinRef.current?.(stored?.displayName || remembered || 'Host');
        return;
      }
      setStatus('ready');
    };

    roomApi
      .probeRoom(roomId, controller.signal)
      .then(settle)
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        // A 404 is not fatal: rooms are created lazily on first join, so an
        // unknown id is a brand-new room, not a dead link.
        if (err instanceof ApiError && err.status === 404) {
          settle({ roomId, exists: false, locked: false, hasSavedWork: false });
          return;
        }
        setError(err.message);
        setStatus('error');
      });

    return () => controller.abort();
  }, [roomId]);

  /** A role change hands back a fresh token; keep it or reloads lose the role. */
  const updateSession = useCallback(
    (patch) => {
      setSession((current) => {
        if (!current) return current;
        const next = { ...current, ...patch };
        saveSession(roomId, next);
        return next;
      });
    },
    [roomId]
  );

  const leave = useCallback(() => {
    clearSession(roomId);
    setSession(null);
    setStatus('ready');
  }, [roomId]);

  return { status, room, session, error, suggestedName, join, updateSession, leave };
}
