'use client';

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';

/**
 * Window layout, stored in the CRDT instead of broadcast.
 *
 * The old implementation had the host re-broadcast the entire window array on
 * every state change — including every frame of a drag — over the lossy
 * channel, and non-hosts overwrote their local state with whatever arrived.
 * That is a flood proportional to (frames x peers x windows), it silently threw
 * away a non-host's own windows, and none of it survived a reload.
 *
 * Here each window is one entry in a `Y.Map`, so concurrent moves of different
 * windows merge cleanly, a reload restores the workspace, and "follow the
 * presenter" is just reading someone else's layout instead of a separate
 * protocol.
 */

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const EMPTY = Object.freeze([]);

function toArray(map) {
  if (!map) return EMPTY;
  const out = [];
  map.forEach((value, id) => {
    if (value && typeof value === 'object') out.push({ id, ...value });
  });
  // Stable order so React does not reshuffle windows on unrelated updates.
  return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export function useSharedWindows(sharedWindows, { canEdit = true, ownerId } = {}) {
  // A store subscription rather than a state mirror: the layout is external
  // state, and mirroring it through `useState` in an effect renders one frame of
  // an empty workspace on every mount.
  const cache = useRef({ source: undefined, value: EMPTY });

  const subscribe = useCallback(
    (onStoreChange) => {
      if (!sharedWindows) return () => {};
      const handler = () => {
        cache.current = { source: sharedWindows, value: toArray(sharedWindows) };
        onStoreChange();
      };
      sharedWindows.observeDeep(handler);
      return () => sharedWindows.unobserveDeep(handler);
    },
    [sharedWindows]
  );

  const getSnapshot = useCallback(() => {
    if (cache.current.source !== sharedWindows) {
      cache.current = { source: sharedWindows, value: toArray(sharedWindows) };
    }
    return cache.current.value;
  }, [sharedWindows]);

  const windows = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);

  const spawn = useCallback(
    (type, overrides = {}) => {
      if (!sharedWindows || !canEdit) return null;
      const id = uid();
      // Cascade slightly so a second window is not exactly on top of the first.
      const index = sharedWindows.size;
      sharedWindows.set(id, {
        type,
        createdAt: Date.now(),
        createdBy: ownerId || null,
        position: {
          x: Math.min(0.42, 0.05 + index * 0.04),
          y: Math.min(0.42, 0.05 + index * 0.04),
          w: 0.55,
          h: 0.62,
        },
        isMinimized: false,
        z: index + 1,
        ...overrides,
      });
      return id;
    },
    [sharedWindows, canEdit, ownerId]
  );

  const update = useCallback(
    (id, patch) => {
      if (!sharedWindows || !canEdit) return;
      const current = sharedWindows.get(id);
      if (!current) return;
      sharedWindows.set(id, {
        ...current,
        ...patch,
        position: patch.position ? { ...current.position, ...patch.position } : current.position,
      });
    },
    [sharedWindows, canEdit]
  );

  const close = useCallback(
    (id) => {
      if (!sharedWindows || !canEdit) return;
      sharedWindows.delete(id);
    },
    [sharedWindows, canEdit]
  );

  const closeAll = useCallback(() => {
    if (!sharedWindows || !canEdit) return;
    // One transaction, so peers see the whole clear as a single change.
    sharedWindows.doc?.transact(() => {
      for (const id of [...sharedWindows.keys()]) sharedWindows.delete(id);
    });
  }, [sharedWindows, canEdit]);

  const focus = useCallback(
    (id) => {
      if (!sharedWindows || !canEdit) return;
      const current = sharedWindows.get(id);
      if (!current) return;
      let top = 0;
      sharedWindows.forEach((value) => {
        top = Math.max(top, value?.z || 0);
      });
      if ((current.z || 0) === top) return;
      sharedWindows.set(id, { ...current, z: top + 1 });
    },
    [sharedWindows, canEdit]
  );

  const byType = useMemo(() => {
    const map = new Map();
    for (const win of windows) map.set(win.type, win);
    return map;
  }, [windows]);

  return { windows, byType, spawn, update, close, closeAll, focus };
}
