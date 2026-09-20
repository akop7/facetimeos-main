import fs from 'node:fs/promises';
import path from 'node:path';
import { DOC_STORE, ROOM_TTL_MS } from './config.js';
import { cloudArchive } from './firestore-archive.js';

/**
 * Durable storage for a room's collaborative artifacts (code, notes,
 * whiteboard, layout, timeline).
 *
 * Why this exists: Yjs docs previously lived only inside browser tabs, relayed
 * peer-to-peer. The moment the last participant closed the tab the work was
 * gone, and a late joiner had nothing to sync from if no original peer remained.
 * That made "persistent rooms" impossible.
 *
 * Why there is no `yjs` import here: a Yjs update is a commutative, idempotent
 * binary delta, so a *dumb append-only log* of updates is a valid
 * representation of the document — a client that applies every update in any
 * order converges to the same state. The server therefore never needs to
 * understand the CRDT. When the log gets long the server asks a connected
 * client for a compacted `Y.encodeStateAsUpdate` snapshot and collapses the log
 * to that single entry. Zero server-side CRDT dependency, full durability.
 */

const MAGIC = Buffer.from('FTOS');
const FORMAT_VERSION = 1;

/** roomId -> { updates: Buffer[], bytes: number, seq: number, dirty, lastTouched, loaded, flushTimer } */
const store = new Map();
/** roomId -> Promise, so concurrent joiners share a single disk read. */
const loading = new Map();
const writing = new Map();

function safeFileName(roomId) {
  // Room ids are server-generated UUIDs, but never build a path from
  // unvalidated input. Only word characters and dashes survive, so path
  // separators, drive letters and `..` traversal cannot appear at all.
  const safe = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'unnamed';
  return path.join(DOC_STORE.dir, `${safe}.ftos`);
}

function blank() {
  return {
    updates: [],
    bytes: 0,
    seq: 0,
    dirty: false,
    lastTouched: Date.now(),
    loaded: false,
    flushTimer: null,
  };
}

function encode(updates) {
  const header = Buffer.alloc(9);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 4);
  header.writeUInt32BE(updates.length, 5);

  const chunks = [header];
  for (const update of updates) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(update.length, 0);
    chunks.push(len, update);
  }
  return Buffer.concat(chunks);
}

function decode(buffer) {
  if (buffer.length < 9 || !buffer.subarray(0, 4).equals(MAGIC)) {
    throw new Error('not a FaceTimeOS doc file');
  }
  const version = buffer.readUInt8(4);
  if (version !== FORMAT_VERSION) {
    throw new Error(`unsupported doc format version ${version}`);
  }
  const count = buffer.readUInt32BE(5);
  const updates = [];
  let offset = 9;
  for (let i = 0; i < count; i += 1) {
    if (offset + 4 > buffer.length) throw new Error('truncated doc file (length header)');
    const len = buffer.readUInt32BE(offset);
    offset += 4;
    if (offset + len > buffer.length) throw new Error('truncated doc file (payload)');
    updates.push(Buffer.from(buffer.subarray(offset, offset + len)));
    offset += len;
  }
  return updates;
}

async function readFromDisk(roomId) {
  if (!DOC_STORE.enabled) return [];
  if (DOC_STORE.provider === 'firestore') {
    // Never treat a failed cloud read as an empty room: that could overwrite
    // saved work with a fresh document after a transient network failure.
    const raw = await cloudArchive.read(roomId);
    return raw ? decode(raw) : [];
  }
  try {
    const raw = await fs.readFile(safeFileName(roomId));
    return decode(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[doc-store] could not read room ${roomId}: ${err.message}`);
    }
    return [];
  }
}

/**
 * Load a room's artifacts into memory. Idempotent and safe to call
 * concurrently — simultaneous joiners share one read.
 */
export async function ensureLoaded(roomId) {
  let entry = store.get(roomId);
  if (entry?.loaded) return entry;

  if (loading.has(roomId)) return loading.get(roomId);

  const promise = (async () => {
    const updates = await readFromDisk(roomId);
    entry = store.get(roomId) || blank();
    // Anything appended while the read was in flight must survive it.
    entry.updates = [...updates, ...entry.updates];
    entry.bytes = entry.updates.reduce((n, u) => n + u.length, 0);
    entry.loaded = true;
    entry.lastTouched = Date.now();
    store.set(roomId, entry);
    return entry;
  })().finally(() => loading.delete(roomId));

  loading.set(roomId, promise);
  return promise;
}

function entryFor(roomId) {
  let entry = store.get(roomId);
  if (!entry) {
    entry = blank();
    store.set(roomId, entry);
  }
  return entry;
}

/** Every persisted update for a room, oldest first. */
export function getUpdates(roomId) {
  const entry = store.get(roomId);
  if (!entry) return [];
  entry.lastTouched = Date.now();
  return entry.updates;
}

export function getStats(roomId) {
  const entry = store.get(roomId);
  if (!entry) return { updates: 0, bytes: 0, seq: 0, hasContent: false };
  return {
    updates: entry.updates.length,
    bytes: entry.bytes,
    seq: entry.seq,
    hasContent: entry.updates.length > 0,
  };
}

/**
 * Append one Yjs update.
 * @returns {{accepted: boolean, needsCompaction: boolean, reason?: string}}
 */
export function appendUpdate(roomId, update) {
  if (!(update instanceof Buffer) || update.length === 0) {
    return { accepted: false, needsCompaction: false, reason: 'empty' };
  }
  const entry = entryFor(roomId);

  if (entry.bytes + update.length > DOC_STORE.maxBytes) {
    // Keep serving the room, just stop growing the durable copy. Live peers
    // still receive the update over their data channels.
    return { accepted: false, needsCompaction: true, reason: 'quota' };
  }

  entry.updates.push(update);
  entry.bytes += update.length;
  entry.seq += 1;
  entry.dirty = true;
  entry.lastTouched = Date.now();
  scheduleFlush(roomId, entry);

  return {
    accepted: true,
    needsCompaction: entry.updates.length > DOC_STORE.compactAfterUpdates,
    reason: undefined,
  };
}

/**
 * Collapse the update log into a single client-produced snapshot. This is the
 * garbage collection step that keeps the log from growing without bound.
 */
export function replaceWithSnapshot(roomId, snapshot) {
  if (!(snapshot instanceof Buffer) || snapshot.length === 0) return false;
  if (snapshot.length > DOC_STORE.maxBytes) return false;

  const entry = entryFor(roomId);
  entry.updates = [snapshot];
  entry.bytes = snapshot.length;
  entry.seq += 1;
  entry.dirty = true;
  entry.lastTouched = Date.now();
  scheduleFlush(roomId, entry);
  return true;
}

function scheduleFlush(roomId, entry) {
  if (!DOC_STORE.enabled || entry.flushTimer) return;
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    flush(roomId).catch((err) => {
      console.warn(`[doc-store] flush failed for ${roomId}: ${err.message}`);
      if (store.get(roomId) === entry) scheduleFlush(roomId, entry);
    });
  }, DOC_STORE.flushDebounceMs);
  // A pending flush must not hold the process open on shutdown.
  entry.flushTimer.unref?.();
}

/** Write a room to disk now. Atomic: write to a temp file, then rename. */
export async function flush(roomId) {
  if (writing.has(roomId)) {
    await writing.get(roomId);
    return flush(roomId);
  }
  const entry = store.get(roomId);
  if (!DOC_STORE.enabled || !entry || !entry.dirty) return;
  const seq = entry.seq;
  const payload = encode(entry.updates);
  const pending = (async () => {
    if (DOC_STORE.provider === 'firestore') await cloudArchive.write(roomId, payload);
    else {
      const target = safeFileName(roomId);
      const temp = `${target}.${process.pid}.tmp`;
      await fs.mkdir(DOC_STORE.dir, { recursive: true });
      await fs.writeFile(temp, payload);
      await fs.rename(temp, target);
    }
    entry.dirty = entry.seq !== seq;
    if (entry.dirty) scheduleFlush(roomId, entry);
  })();
  writing.set(roomId, pending);
  try { await pending; } finally { writing.delete(roomId); }
}

export async function flushAll() {
  await Promise.allSettled([...store.keys()].map((roomId) => flush(roomId)));
}

export async function deleteRoom(roomId) {
  if (loading.has(roomId)) await loading.get(roomId);
  if (writing.has(roomId)) await writing.get(roomId);
  const entry = store.get(roomId);
  if (entry?.flushTimer) clearTimeout(entry.flushTimer);
  store.delete(roomId);
  if (!DOC_STORE.enabled) return;
  if (DOC_STORE.provider === 'firestore') return cloudArchive.remove(roomId);
  try {
    await fs.unlink(safeFileName(roomId));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[doc-store] could not delete room ${roomId}: ${err.message}`);
    }
  }
}

/** Drop rooms nobody has touched for ROOM_TTL_MS. Called on an interval. */
export async function evictExpired(now = Date.now()) {
  const expired = [...store.entries()]
    .filter(([, entry]) => now - entry.lastTouched > ROOM_TTL_MS)
    .map(([roomId]) => roomId);
  for (const roomId of expired) {
    if (DOC_STORE.provider === 'firestore') {
      // Evict only the memory cache; durable Firestore rooms are kept until
      // their host explicitly deletes the artifacts.
      await flush(roomId);
      const entry = store.get(roomId);
      if (entry?.flushTimer) clearTimeout(entry.flushTimer);
      store.delete(roomId);
    } else await deleteRoom(roomId);
  }
  return expired.length;
}

/** Test seam. */
export function _resetForTests() {
  for (const entry of store.values()) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
  }
  store.clear();
  loading.clear();
}

export const _codec = { encode, decode };
