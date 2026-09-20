'use client';

/**
 * The collaborative document for a room, plus the provider that keeps it in
 * sync across the mesh and with the server's durable copy.
 *
 * What was here before was a stub: `createSharedDocument` made a `Y.Doc` and an
 * `Awareness` that were wired to nothing at all. Nothing was ever sent, nothing
 * received, and `provider.on('synced')` did not exist — so every "shared"
 * editor was in fact private to one tab. This is the real thing.
 *
 * Three transports, one document:
 *   1. peer data channels — low latency, works with no server in the path
 *   2. the signaling server — durable storage, and the only way a peer that
 *      joins an empty room gets the history back
 *   3. IndexedDB — instant local restore, works offline
 *
 * All three carry the same opaque Yjs binaries, so none of them needs to
 * understand the document.
 */

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  MSG,
  encodeSyncRequest,
  encodeUpdate,
  encodeAwareness,
  encodeAwarenessGone,
  handleFrame,
  toBytes,
} from './yjs-transport';
import { createLocalPersistence } from './idb-persistence';

/** Origins let us tell local edits from network ones and avoid echo loops. */
export const ORIGIN = Object.freeze({
  peer: 'peer',
  server: 'server',
  local: 'idb',
});

const AWARENESS_TIMEOUT = 30_000;

export const SHARED_KEYS = Object.freeze({
  code: 'code',
  notes: 'notes',
  whiteboard: 'whiteboard',
  windows: 'windows',
  timeline: 'timeline',
  chat: 'chat',
  meta: 'meta',
});

export function createSharedTypes(doc) {
  return {
    /** Monaco buffer. */
    code: doc.getText(SHARED_KEYS.code),
    /** Rich-ish notes buffer. */
    notes: doc.getText(SHARED_KEYS.notes),
    /** Whiteboard strokes, append-only. */
    whiteboard: doc.getArray(SHARED_KEYS.whiteboard),
    /** Window geometry, so layout survives a reload and can be followed. */
    windows: doc.getMap(SHARED_KEYS.windows),
    /** Append-only session timeline — the raw material for the export bundle. */
    timeline: doc.getArray(SHARED_KEYS.timeline),
    /**
     * Chat. In the document rather than a fire-and-forget broadcast, so a late
     * joiner sees what was said before they arrived and the transcript is part
     * of the exported bundle — the thing every other meeting app throws away.
     */
    chat: doc.getArray(SHARED_KEYS.chat),
    /** Room-scoped scalars: language, timer deadline, presenter, etc. */
    meta: doc.getMap(SHARED_KEYS.meta),
  };
}

export function getAwarenessColor(peerId) {
  const colors = [
    '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80',
    '#2dd4bf', '#38bdf8', '#818cf8', '#a78bfa', '#e879f9',
  ];
  let hash = 0;
  const key = String(peerId ?? '');
  for (let i = 0; i < key.length; i += 1) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export class MeshDocProvider {
  /**
   * @param {object} options
   * @param {string} options.roomId
   * @param {string} options.peerId    server-assigned identity
   * @param {object} [options.identity] displayName / role / color for awareness
   */
  constructor({ roomId, peerId, identity = {} }) {
    if (!roomId) throw new Error('MeshDocProvider requires roomId');

    this.roomId = roomId;
    this.peerId = peerId;
    this.doc = new Y.Doc({ guid: `ftos-${roomId}` });
    this.awareness = new Awareness(this.doc);
    this.sharedTypes = createSharedTypes(this.doc);

    this.destroyed = false;
    this.synced = false;
    this.persistence = null;
    /** peerId -> true once its sync handshake has completed. */
    this.syncedPeers = new Set();
    this._listeners = new Map();

    // Transport hooks. Installed through `setTransport` rather than assigned
    // from the outside: the caller is a React hook, and writing to a property of
    // a hook argument is exactly the mutation the compiler is entitled to
    // reorder underneath you.
    /** @type {null | ((peerId: string, bytes: Uint8Array) => boolean)} */
    this.sendToPeer = null;
    /** @type {null | ((bytes: Uint8Array) => number)} */
    this.broadcastToPeers = null;
    /** @type {null | ((update: Uint8Array) => void)} */
    this.sendToServer = null;

    this.awareness.setLocalState({
      peerId,
      name: identity.displayName || 'Guest',
      role: identity.role || 'editor',
      color: identity.color || getAwarenessColor(peerId),
      cursor: null,
      selection: null,
      widget: null,
      at: Date.now(),
    });

    this._onDocUpdate = (update, origin) => {
      // Anything that came off the wire is already known to whoever sent it,
      // and re-broadcasting it is how naive meshes livelock.
      if (origin === ORIGIN.peer || origin === ORIGIN.local) return;
      const framed = encodeUpdate(update);
      this.broadcastToPeers?.(framed);
      if (origin !== ORIGIN.server) this.sendToServer?.(update);
    };

    this._onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === ORIGIN.peer) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      this.broadcastToPeers?.(encodeAwareness(this.awareness, changed));
    };

    this.doc.on('update', this._onDocUpdate);
    this.awareness.on('update', this._onAwarenessUpdate);

    // Stale cursors are worse than no cursors: they imply someone is present.
    this._reaper = setInterval(() => this._reapAwareness(), AWARENESS_TIMEOUT / 2);
  }

  /* ---------- tiny event emitter (the old code called provider.on) ---------- */

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this._listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (err) {
        console.warn(`[crdt] ${event} listener threw:`, err?.message);
      }
    }
  }

  /* ------------------------------ transport wiring ------------------------- */

  /**
   * Install (or replace) the three ways this document can reach the outside
   * world. Returns a function that removes exactly what it installed, so a
   * reconnect cannot leave a dead mesh wired up behind the new one.
   */
  setTransport({ sendToPeer = null, broadcastToPeers = null, sendToServer = null } = {}) {
    this.sendToPeer = sendToPeer;
    this.broadcastToPeers = broadcastToPeers;
    this.sendToServer = sendToServer;
    return () => {
      if (this.sendToPeer === sendToPeer) this.sendToPeer = null;
      if (this.broadcastToPeers === broadcastToPeers) this.broadcastToPeers = null;
      if (this.sendToServer === sendToServer) this.sendToServer = null;
    };
  }

  /* ---------------------------- local durability --------------------------- */

  async attachLocalPersistence() {
    if (this.persistence || this.destroyed) return this.persistence;
    this.persistence = await createLocalPersistence(this.roomId, this.doc, {
      origin: ORIGIN.local,
    });
    if (this.persistence.loaded) this.emit('local-loaded', true);
    return this.persistence;
  }

  /* ------------------------------ peer transport --------------------------- */

  /**
   * Start the handshake with a peer whose reliable channel just opened. Both
   * sides do this; the exchange is idempotent so a double handshake is
   * harmless, just a few wasted bytes.
   */
  syncWithPeer(remotePeerId) {
    if (this.destroyed) return;
    this.sendToPeer?.(remotePeerId, encodeSyncRequest(this.doc));
    // Send our cursor unprompted — otherwise a peer sees nobody until we move.
    this.sendToPeer?.(remotePeerId, encodeAwareness(this.awareness));
  }

  /** Feed one inbound frame from a peer channel. */
  receiveFromPeer(remotePeerId, data) {
    if (this.destroyed) return false;
    const bytes = toBytes(data);
    if (!bytes) return false;

    const { reply, applied } = handleFrame({
      doc: this.doc,
      awareness: this.awareness,
      data: bytes,
      origin: ORIGIN.peer,
    });

    if (reply) this.sendToPeer?.(remotePeerId, reply);

    if (bytes[0] === MSG.SYNC_REPLY && !this.syncedPeers.has(remotePeerId)) {
      this.syncedPeers.add(remotePeerId);
      this._markSynced();
    }
    return applied;
  }

  dropPeer(remotePeerId) {
    this.syncedPeers.delete(remotePeerId);
  }

  /* ----------------------------- server transport --------------------------- */

  /**
   * Apply the durable log the server sends on join. This is what makes rooms
   * persistent: the first peer into an empty room recovers everything, with no
   * original participant still online.
   */
  applyServerSnapshot(updates) {
    if (this.destroyed || !Array.isArray(updates) || updates.length === 0) {
      this._markSynced();
      return 0;
    }

    const decoded = updates.map(toBytes).filter((u) => u && u.length > 0);
    if (decoded.length === 0) {
      this._markSynced();
      return 0;
    }

    // One transaction, one merged update: N applyUpdate calls would fire N
    // observer passes and repaint every editor N times.
    this.doc.transact(() => {
      Y.applyUpdate(this.doc, Y.mergeUpdates(decoded), ORIGIN.server);
    }, ORIGIN.server);

    this._markSynced();
    return decoded.length;
  }

  /** A single update relayed by the server (from a peer we have no channel to). */
  receiveFromServer(update) {
    if (this.destroyed) return false;
    const bytes = toBytes(update);
    if (!bytes || bytes.length === 0) return false;
    Y.applyUpdate(this.doc, bytes, ORIGIN.server);
    return true;
  }

  /**
   * Produce a compacted snapshot for the server to collapse its log onto. The
   * server cannot do this itself — it has no CRDT — so it asks a client.
   */
  snapshot() {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /* -------------------------------- awareness ------------------------------- */

  setLocalAwareness(patch) {
    if (this.destroyed) return;
    const current = this.awareness.getLocalState() || {};
    this.awareness.setLocalState({ ...current, ...patch, at: Date.now() });
  }

  /** Everyone but us, newest state first, stale entries already dropped. */
  remoteStates() {
    const states = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.doc.clientID || !state) return;
      states.push({ clientId, ...state });
    });
    return states;
  }

  _reapAwareness() {
    if (this.destroyed) return;
    const cutoff = Date.now() - AWARENESS_TIMEOUT;
    const stale = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.doc.clientID) return;
      if (!state || (state.at ?? 0) < cutoff) stale.push(clientId);
    });
    if (stale.length > 0) {
      import('y-protocols/awareness').then(({ removeAwarenessStates }) => {
        removeAwarenessStates(this.awareness, stale, ORIGIN.peer);
      });
    }
    // Refresh our own timestamp so peers do not reap us while we sit still.
    this.setLocalAwareness({});
  }

  _markSynced() {
    if (this.synced) return;
    this.synced = true;
    this.emit('synced', true);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this._reaper);

    // Tell peers to clear our cursor now rather than waiting for the reaper.
    try {
      this.broadcastToPeers?.(encodeAwarenessGone(this.awareness));
    } catch {
      /* Channels may already be closed. */
    }

    this.doc.off('update', this._onDocUpdate);
    this.awareness.off('update', this._onAwarenessUpdate);
    this._listeners.clear();
    this.syncedPeers.clear();

    this.persistence?.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/**
 * Backwards-compatible factory. Older call sites expect
 * `{ doc, provider, awareness, sharedTypes }`.
 */
export function createSharedDocument(roomId, options = {}) {
  const provider = new MeshDocProvider({ roomId, ...options });
  return {
    doc: provider.doc,
    provider,
    awareness: provider.awareness,
    sharedTypes: provider.sharedTypes,
  };
}

export function getAwareness(provider) {
  return provider?.awareness ?? null;
}

export function destroySharedDocument(bundle) {
  // Destroying the provider tears the doc and awareness down in the right
  // order; destroying the doc first would leave awareness observing a dead doc.
  if (bundle?.provider?.destroy) bundle.provider.destroy();
  else if (bundle?.doc) bundle.doc.destroy();
}
