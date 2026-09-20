'use client';

import { useCallback, useMemo } from 'react';
import { useYArray } from './useYjs';

/**
 * Chat and the session timeline: two append-only logs in the room document.
 *
 * Both used to be React state in the room page and broadcast over a data
 * channel, which meant a late joiner saw an empty room with no history, a reload
 * erased everything, and nothing could be exported afterwards. Putting them in
 * the CRDT costs nothing extra — the transport, the persistence and the
 * conflict handling are already there for the editors — and it is what makes the
 * export bundle possible.
 *
 * The timeline is the differentiating half. Every other meeting app can tell you
 * a meeting happened; this records what happened *in* it — who joined, which
 * tools were opened, what was marked as a decision — as data, timestamped, and
 * attributable.
 */

const MAX_CHAT = 1000;
const MAX_TIMELINE = 2000;

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Kinds the timeline UI knows how to label and the export groups by. */
export const TIMELINE_KINDS = Object.freeze({
  joined: 'joined',
  left: 'left',
  widget: 'widget',
  decision: 'decision',
  share: 'share',
  timer: 'timer',
  restored: 'restored',
  role: 'role',
});

export function useRoomChat(sharedChat, { peerId, displayName, readOnly = false } = {}) {
  const raw = useYArray(sharedChat);

  const messages = useMemo(
    () =>
      raw.filter(
        (entry) => entry && typeof entry === 'object' && typeof entry.text === 'string'
      ),
    [raw]
  );

  const send = useCallback(
    (text) => {
      const trimmed = String(text ?? '').trim();
      if (!sharedChat || !trimmed || readOnly) return null;
      const message = {
        id: uid(),
        at: Date.now(),
        from: peerId || null,
        name: displayName || 'Guest',
        // A 2 000-character cap keeps one paste from dominating the document; the
        // input enforces the same number, this is the backstop.
        text: trimmed.slice(0, 2000),
      };
      sharedChat.push([message]);
      // Trim from the front rather than letting the log grow without bound — the
      // whole document is re-sent to every joiner.
      if (sharedChat.length > MAX_CHAT) sharedChat.delete(0, sharedChat.length - MAX_CHAT);
      return message;
    },
    [sharedChat, peerId, displayName, readOnly]
  );

  return { messages, send };
}

export function useSessionTimeline(sharedTimeline, { peerId, displayName, readOnly = false } = {}) {
  const raw = useYArray(sharedTimeline);

  const events = useMemo(
    () => raw.filter((entry) => entry && typeof entry === 'object' && typeof entry.kind === 'string'),
    [raw]
  );

  const record = useCallback(
    (kind, text, extra = {}) => {
      if (!sharedTimeline || readOnly) return null;
      const event = {
        id: uid(),
        at: Date.now(),
        kind,
        text: String(text ?? '').slice(0, 500),
        by: peerId || null,
        byName: displayName || 'Guest',
        ...extra,
      };
      sharedTimeline.push([event]);
      if (sharedTimeline.length > MAX_TIMELINE) {
        sharedTimeline.delete(0, sharedTimeline.length - MAX_TIMELINE);
      }
      return event;
    },
    [sharedTimeline, peerId, displayName, readOnly]
  );

  /**
   * Record something that should appear exactly once no matter how many people
   * observe it. "Alice joined" is seen by everyone in the room, and without this
   * every one of them would append their own copy.
   */
  const recordOnce = useCallback(
    (key, kind, text, extra = {}) => {
      if (!sharedTimeline || readOnly) return null;
      const existing = sharedTimeline.toArray().some((event) => event?.key === key);
      if (existing) return null;
      return record(kind, text, { ...extra, key });
    },
    [sharedTimeline, readOnly, record]
  );

  const decisions = useMemo(
    () => events.filter((event) => event.kind === TIMELINE_KINDS.decision),
    [events]
  );

  return { events, decisions, record, recordOnce };
}
