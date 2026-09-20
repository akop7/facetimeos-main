import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CHUNK_BYTES, createFirestoreArchive, packArchive, unpackArchive } from '../src/firestore-archive.js';

test('multi-megabyte artifacts fit Firestore document limits and round trip', () => {
  const original = randomBytes(3 * 1024 * 1024);
  const { chunks, manifest } = packArchive(original);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= CHUNK_BYTES && chunk.length < 1024 * 1024));
  assert.deepEqual(unpackArchive(manifest, chunks), original);
});
test('corrupt or missing archive chunks are rejected', () => {
  const { chunks, manifest } = packArchive(Buffer.from('my saved notes'));
  assert.throws(() => unpackArchive(manifest, []), /manifest/);
  assert.throws(() => unpackArchive(manifest, [null]), /chunk/);
  assert.throws(() => unpackArchive({ ...manifest, sha256: 'bad' }, chunks), /integrity/);
  assert.throws(() => unpackArchive({ ...manifest, count: 1000000 }, chunks), /manifest/);
});
function fakeDb() {
  const data = new Map();
  const ref = key => ({ key, collection: name => ({ doc: id => ref(`${key}/${name}/${id}`) }) });
  const snapshot = r => ({ exists: data.has(r.key), data: () => data.get(r.key), get: name => data.get(r.key)?.[name] });
  return {
    data,
    collection: name => ({ doc: id => ref(`${name}/${id}`) }),
    async runTransaction(fn) {
      const writes = [];
      const result = await fn({ get: async r => snapshot(r), getAll: async (...refs) => refs.map(snapshot), set: (r, v) => writes.push(() => data.set(r.key, v)), delete: r => writes.push(() => data.delete(r.key)) });
      writes.forEach(write => write()); return result;
    },
  };
}
test('archive read/write/delete and smaller replacement manage all chunks', async () => {
  const db = fakeDb(); const archive = createFirestoreArchive(() => db);
  assert.equal(await archive.read('room-1'), null);
  const big = randomBytes(CHUNK_BYTES * 2);
  await archive.write('room-1', big); assert.deepEqual(await archive.read('room-1'), big);
  assert.ok(db.data.size > 2);
  await archive.write('room-1', Buffer.from('small')); assert.equal(db.data.size, 2);
  assert.equal((await archive.read('room-1')).toString(), 'small');
  await archive.remove('room-1'); assert.equal(db.data.size, 0);
  await assert.rejects(archive.read('../another-room'), /Invalid room/);
});
test('failed cloud reads propagate, never becoming an empty archive', async () => {
  const archive = createFirestoreArchive(() => ({ collection: () => ({ doc: () => ({}) }), runTransaction: async () => { throw new Error('network offline'); } }));
  await assert.rejects(archive.read('room-1'), /network offline/);
});
