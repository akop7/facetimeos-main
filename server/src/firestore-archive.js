import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { firestore } from './firebase-admin.js';

// A Firestore document is limited to 1 MiB. Split the compressed room into
// bounded binary chunks and commit the manifest and chunks in one transaction.
export const CHUNK_BYTES = 700 * 1024;
const MAX_COMPRESSED_BYTES = 9 * 1024 * 1024;
const MAX_DECODED_BYTES = 48 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function packArchive(payload) {
  if (payload.length > MAX_DECODED_BYTES) throw new Error('Room archive exceeds the storage limit.');
  const compressed = gzipSync(payload);
  if (compressed.length > MAX_COMPRESSED_BYTES) throw new Error('Room archive exceeds the Firestore transaction limit.');
  const chunks = [];
  for (let at = 0; at < compressed.length; at += CHUNK_BYTES) chunks.push(compressed.subarray(at, at + CHUNK_BYTES));
  return { chunks, manifest: { version: 1, count: chunks.length, bytes: compressed.length, sha256: hash(compressed), savedAt: Date.now() } };
}
export function unpackArchive(manifest, chunks) {
  if (manifest.version !== 1 || !Number.isInteger(manifest.count) || manifest.count < 1 || manifest.count > 14 || chunks.length !== manifest.count) throw new Error('Invalid room archive manifest.');
  if (chunks.some(chunk => !Buffer.isBuffer(chunk) || chunk.length > CHUNK_BYTES)) throw new Error('Missing or invalid room archive chunk.');
  const compressed = Buffer.concat(chunks);
  if (compressed.length !== manifest.bytes || hash(compressed) !== manifest.sha256) throw new Error('Room archive integrity check failed.');
  return gunzipSync(compressed, { maxOutputLength: MAX_DECODED_BYTES });
}
function roomRef(db, roomId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(roomId)) throw new Error('Invalid room storage ID.');
  return db.collection('facetimeosRooms').doc(roomId);
}
export function createFirestoreArchive(getDb = firestore) {
  return {
    async read(roomId) {
      const db = await getDb(); const ref = roomRef(db, roomId);
      return db.runTransaction(async tx => {
        const doc = await tx.get(ref);
        if (!doc.exists) return null;
        const metadata = doc.data();
        if (!Number.isInteger(metadata.count) || metadata.count < 1 || metadata.count > 14) throw new Error('Invalid room archive chunk count.');
        const docs = await tx.getAll(...Array.from({ length: metadata.count }, (_, i) => ref.collection('chunks').doc(String(i))));
        return unpackArchive(metadata, docs.map(d => d.exists ? d.get('data') : null));
      }, { readOnly: true });
    },
    async write(roomId, payload) {
      const db = await getDb(); const ref = roomRef(db, roomId);
      const { manifest, chunks } = packArchive(payload);
      await db.runTransaction(async tx => {
        const prior = await tx.get(ref);
        const oldCount = Math.min(prior.data()?.count || 0, 14);
        tx.set(ref, manifest);
        chunks.forEach((data, i) => tx.set(ref.collection('chunks').doc(String(i)), { data }));
        for (let i = chunks.length; i < oldCount; i++) tx.delete(ref.collection('chunks').doc(String(i)));
      });
    },
    async remove(roomId) {
      const db = await getDb(); const ref = roomRef(db, roomId);
      await db.runTransaction(async tx => {
        const prior = await tx.get(ref);
        for (let i = 0; i < Math.min(prior.data()?.count || 0, 14); i++) tx.delete(ref.collection('chunks').doc(String(i)));
        tx.delete(ref);
      });
    },
  };
}
export const cloudArchive = createFirestoreArchive();
