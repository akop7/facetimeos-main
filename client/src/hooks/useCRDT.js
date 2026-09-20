'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { MeshDocProvider, destroySharedDocument } from '../lib/crdt';

/**
 * Own the room's collaborative document for the lifetime of the room.
 *
 * The previous version returned `crdtRef.current?.doc` straight out of the
 * render body. A ref written inside an effect is `null` on the first render and
 * mutating it never schedules another, so every consumer got `undefined` forever
 * unless something else happened to re-render — which is why the editors looked
 * empty even after the doc existed.
 *
 * The provider is published through a store subscription rather than `useState`.
 * It is an external system with a constructor, an interval and a teardown, so it
 * has to be built in an effect; pushing it into state from there is the
 * cascading-render pattern React now warns about, whereas a store notification
 * is the sanctioned way for an effect to tell render "this changed".
 */
export function useCRDT(roomId, { peerId, displayName, role } = {}) {
  const box = useRef({
    listeners: new Set(),
    snapshot: { provider: null, isConnected: false, localLoaded: false },
  });

  const subscribe = useCallback((onStoreChange) => {
    const store = box.current;
    store.listeners.add(onStoreChange);
    return () => store.listeners.delete(onStoreChange);
  }, []);

  const getSnapshot = useCallback(() => box.current.snapshot, []);

  const { provider, isConnected, localLoaded } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  );

  useEffect(() => {
    if (!roomId || !peerId) return undefined;

    const store = box.current;
    const publish = (patch) => {
      store.snapshot = { ...store.snapshot, ...patch };
      for (const listener of store.listeners) listener();
    };

    const instance = new MeshDocProvider({
      roomId,
      peerId,
      identity: { displayName, role },
    });

    const offSynced = instance.on('synced', () => publish({ isConnected: true }));
    const offLocal = instance.on('local-loaded', () => publish({ localLoaded: true }));

    publish({ provider: instance, isConnected: false, localLoaded: false });

    // Local cache first: the editors fill in immediately, before the network.
    instance.attachLocalPersistence();

    return () => {
      offSynced();
      offLocal();
      publish({ provider: null, isConnected: false, localLoaded: false });
      destroySharedDocument({ provider: instance });
    };
    // displayName/role changes are pushed through setLocalAwareness below rather
    // than rebuilding the document, which would drop every peer's sync state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, peerId]);

  useEffect(() => {
    if (!provider) return;
    provider.setLocalAwareness({ name: displayName || 'Guest', role: role || 'editor' });
  }, [provider, displayName, role]);

  const setAwareness = useCallback((patch) => {
    box.current.snapshot.provider?.setLocalAwareness(patch);
  }, []);

  return {
    provider,
    doc: provider?.doc ?? null,
    awareness: provider?.awareness ?? null,
    sharedCode: provider?.sharedTypes.code ?? null,
    sharedNotes: provider?.sharedTypes.notes ?? null,
    sharedWhiteboard: provider?.sharedTypes.whiteboard ?? null,
    sharedWindows: provider?.sharedTypes.windows ?? null,
    sharedTimeline: provider?.sharedTypes.timeline ?? null,
    sharedChat: provider?.sharedTypes.chat ?? null,
    sharedMeta: provider?.sharedTypes.meta ?? null,
    setAwareness,
    isConnected,
    localLoaded,
  };
}
