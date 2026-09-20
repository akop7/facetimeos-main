'use client';

/**
 * Wire format for Yjs sync and awareness, independent of how bytes travel.
 *
 * Why hand-rolled instead of `y-protocols/sync`: those helpers are written
 * against `lib0` encoder objects and assume a single duplex stream per peer.
 * Here the same messages have to travel over two very different pipes — the
 * reliable `sync` RTCDataChannel between peers, and a socket.io relay to the
 * server for durable storage — so a flat, self-describing frame is easier to
 * route and to test than a stream-oriented codec.
 *
 * Frame layout:  [type u8][payload …]
 *
 * The payloads are opaque Yjs/awareness binaries. That matters: the previous
 * implementation JSON-stringified updates (`JSON.stringify(Array.from(update))`)
 * which inflated every byte to ~4 characters and made large documents
 * unusable.
 */

import * as Y from 'yjs';
import { encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';

export const MSG = Object.freeze({
  /** "here is my state vector, send me what I am missing" */
  SYNC_REQUEST: 0,
  /** "here is the diff you asked for" (also carries my own vector for step 3) */
  SYNC_REPLY: 1,
  /** an incremental local update */
  UPDATE: 2,
  /** awareness (cursors, selections, presence) */
  AWARENESS: 3,
  /** "I am leaving" — lets peers clear my cursor immediately */
  AWARENESS_GONE: 4,
});

const EMPTY = new Uint8Array(0);

export function frame(type, payload = EMPTY) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
}

export function unframe(data) {
  const bytes = toBytes(data);
  if (!bytes || bytes.length < 1) return null;
  return { type: bytes[0], payload: bytes.subarray(1) };
}

/** Normalise whatever a data channel / socket.io handed us into bytes. */
export function toBytes(data) {
  if (data == null) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(data);
  return null;
}

/** Step 1 of the handshake: advertise what we already have. */
export function encodeSyncRequest(doc) {
  return frame(MSG.SYNC_REQUEST, Y.encodeStateVector(doc));
}

/**
 * Step 2: answer with exactly the delta the peer lacks.
 *
 * `encodeStateAsUpdate(doc, theirVector)` is the whole point — it sends the
 * difference, not the document, so a late joiner in a long session costs a few
 * KB instead of the entire history.
 */
export function encodeSyncReply(doc, theirStateVector) {
  const diff = Y.encodeStateAsUpdate(doc, theirStateVector?.length ? theirStateVector : undefined);
  return frame(MSG.SYNC_REPLY, diff);
}

export function encodeUpdate(update) {
  return frame(MSG.UPDATE, update);
}

export function encodeAwareness(awareness, clients) {
  const ids = clients ?? [awareness.doc.clientID];
  return frame(MSG.AWARENESS, encodeAwarenessUpdate(awareness, ids));
}

export function encodeAwarenessGone(awareness) {
  const id = new Uint8Array(4);
  new DataView(id.buffer).setUint32(0, awareness.doc.clientID, false);
  return frame(MSG.AWARENESS_GONE, id);
}

/**
 * Apply an inbound frame.
 *
 * @returns {{reply?: Uint8Array, applied: boolean}} `reply` must be sent back
 * to the sender when present (the sync handshake is request/response).
 */
export function handleFrame({ doc, awareness, data, origin }) {
  const parsed = unframe(data);
  if (!parsed) return { applied: false };
  const { type, payload } = parsed;

  switch (type) {
    case MSG.SYNC_REQUEST:
      return { reply: encodeSyncReply(doc, payload), applied: true };

    case MSG.SYNC_REPLY:
    case MSG.UPDATE: {
      if (payload.length === 0) return { applied: false };
      // `origin` lets the local update handler tell "this came from the network"
      // from "the user typed it", which is what stops an echo loop.
      Y.applyUpdate(doc, payload, origin);
      return { applied: true };
    }

    case MSG.AWARENESS: {
      if (!awareness || payload.length === 0) return { applied: false };
      applyAwarenessUpdate(awareness, payload, origin);
      return { applied: true };
    }

    case MSG.AWARENESS_GONE: {
      if (!awareness || payload.length < 4) return { applied: false };
      const clientId = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
      removeAwarenessStates(awareness, [clientId], origin);
      return { applied: true };
    }

    default:
      return { applied: false };
  }
}
