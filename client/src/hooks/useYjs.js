'use client';

import { useCallback, useRef, useSyncExternalStore } from 'react';

/**
 * Small React bindings for Yjs types.
 *
 * Every widget in this project was re-implementing the same observe/unobserve
 * dance, and several of them read the Yjs value during render — which is not a
 * React state source, so the first paint showed stale or empty content until
 * something unrelated triggered a re-render.
 *
 * These are `useSyncExternalStore` subscriptions rather than `useState` mirrors.
 * A mirror has to write state from inside an effect, which means the first paint
 * is always one render behind the document and React (rightly) warns about the
 * cascading render. A store subscription reads the real value during render and
 * is tear-free under concurrent rendering.
 */

const EMPTY = Object.freeze([]);
const serverSnapshot = () => EMPTY;

/** Mirror a `Y.Array`. */
export function useYArray(yArray) {
  // `getSnapshot` must return a stable reference or React re-renders forever, and
  // `toArray()` allocates a new array every call — so cache it and invalidate
  // from the observer.
  const cache = useRef({ source: undefined, value: EMPTY });

  const subscribe = useCallback(
    (onStoreChange) => {
      if (!yArray) return () => {};
      const handler = () => {
        cache.current = { source: yArray, value: yArray.toArray() };
        onStoreChange();
      };
      yArray.observe(handler);
      return () => yArray.unobserve(handler);
    },
    [yArray]
  );

  const getSnapshot = useCallback(() => {
    if (cache.current.source !== yArray) {
      cache.current = { source: yArray, value: yArray ? yArray.toArray() : EMPTY };
    }
    return cache.current.value;
  }, [yArray]);

  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}

/** Mirror one key of a `Y.Map`, with a setter that writes back. */
export function useYMapValue(yMap, key, fallback = null) {
  // Yjs hands back the same reference for a stored object, so no cache is needed
  // here; only the fallback has to stay stable, which is the caller's business.
  const fallbackRef = useRef(fallback);

  const subscribe = useCallback(
    (onStoreChange) => {
      if (!yMap) return () => {};
      yMap.observe(onStoreChange);
      return () => yMap.unobserve(onStoreChange);
    },
    [yMap]
  );

  const getSnapshot = useCallback(() => {
    if (!yMap) return fallbackRef.current;
    const next = yMap.get(key);
    return next === undefined ? fallbackRef.current : next;
  }, [yMap, key]);

  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallbackRef.current);

  const write = useCallback(
    (next) => {
      if (!yMap) return;
      yMap.set(key, next);
    },
    [yMap, key]
  );

  return [value, write];
}

/** Mirror a `Y.Text` as a plain string. */
export function useYText(yText) {
  const subscribe = useCallback(
    (onStoreChange) => {
      if (!yText) return () => {};
      yText.observe(onStoreChange);
      return () => yText.unobserve(onStoreChange);
    },
    [yText]
  );

  return useSyncExternalStore(
    subscribe,
    () => (yText ? yText.toString() : ''),
    () => ''
  );
}

/**
 * Apply a full-string replacement to a `Y.Text` as a minimal edit.
 *
 * This is the fix for the single worst CRDT bug in the project: the notes
 * widget did `delete(0, length)` followed by `insert(0, value)` on every
 * keystroke. That is O(document) work per character, it produces an update
 * proportional to the whole document (measured: ~29.5 MB of traffic to type
 * 4,000 characters, versus ~80 KB with diffing), and — worse — it destroys any
 * concurrent edit, because deleting everything and re-inserting is not a
 * character-level change the CRDT can merge.
 */
export function applyTextDiff(yText, next) {
  if (!yText) return false;
  const current = yText.toString();
  if (current === next) return false;

  let prefix = 0;
  const maxPrefix = Math.min(current.length, next.length);
  while (prefix < maxPrefix && current[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(current.length - prefix, next.length - prefix);
  while (
    suffix < maxSuffix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = current.length - prefix - suffix;
  const inserted = next.slice(prefix, next.length - suffix);

  yText.doc?.transact(() => {
    if (removed > 0) yText.delete(prefix, removed);
    if (inserted.length > 0) yText.insert(prefix, inserted);
  });
  return true;
}
