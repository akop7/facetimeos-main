'use client';

/**
 * Local durability for a room's Yjs document, on raw IndexedDB.
 *
 * Why not `y-indexeddb`: it is another dependency for ~80 lines of work, and it
 * stores every update forever. This version keeps an append-only log and
 * collapses it into a single snapshot once it gets long, which is the same
 * trick the server uses — bounded storage, no CRDT knowledge required beyond
 * "updates are commutative".
 *
 * What it buys: reopening a room offline, or before signaling connects, shows
 * the last known content instantly instead of an empty editor.
 */

const DB_VERSION = 1;
const STORE = 'updates';
const COMPACT_AFTER = 200;

function open(roomId) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(`ftos-doc-${roomId}`, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    try {
      result = run(store);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function readAll(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Bind a doc to local storage. Loads what is on disk into the doc, then
 * persists every subsequent update.
 *
 * Never throws: private-browsing modes and storage-quota refusals must degrade
 * to "no local cache", not break the room.
 */
export async function createLocalPersistence(roomId, doc, { origin = 'idb' } = {}) {
  let db = null;
  let count = 0;
  let destroyed = false;

  const noop = {
    loaded: false,
    async flush() {},
    async clear() {},
    destroy() {},
  };

  try {
    db = await open(roomId);
  } catch (err) {
    console.warn('[idb] local persistence disabled:', err?.message);
    return noop;
  }

  try {
    const stored = await tx(db, 'readonly', (store) => readAll(store));
    count = stored.length;
    // Merging first means one applyUpdate and one observer pass instead of N.
    if (stored.length > 0) {
      const Y = await import('yjs');
      const merged = Y.mergeUpdates(stored.map((u) => new Uint8Array(u)));
      Y.applyUpdate(doc, merged, origin);
    }
  } catch (err) {
    console.warn('[idb] could not restore room:', err?.message);
  }

  const onUpdate = (update, updateOrigin) => {
    if (destroyed || updateOrigin === origin) return;
    tx(db, 'readwrite', (store) => store.add(update))
      .then(() => {
        count += 1;
        if (count > COMPACT_AFTER) compact();
      })
      .catch(() => {
        /* Quota exceeded or the db was closed — the room keeps working. */
      });
  };

  async function compact() {
    if (destroyed) return;
    try {
      const Y = await import('yjs');
      const snapshot = Y.encodeStateAsUpdate(doc);
      await tx(db, 'readwrite', (store) => {
        store.clear();
        store.add(snapshot);
      });
      count = 1;
    } catch {
      /* Compaction is opportunistic; the log just stays long. */
    }
  }

  doc.on('update', onUpdate);

  return {
    loaded: true,
    flush: compact,
    async clear() {
      try {
        await tx(db, 'readwrite', (store) => store.clear());
        count = 0;
      } catch {
        /* nothing to do */
      }
    },
    destroy() {
      destroyed = true;
      doc.off('update', onUpdate);
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
