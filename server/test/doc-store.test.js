import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

process.env.DOC_STORE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ftos-docstore-'));

const docStore = await import('../src/doc-store.js');
const { DOC_STORE } = await import('../src/config.js');

const buf = (...bytes) => Buffer.from(bytes);

test.beforeEach(() => docStore._resetForTests());

test('the on-disk container round-trips an update log', () => {
  const updates = [buf(1, 2, 3), buf(), buf(9)];
  const decoded = docStore._codec.decode(docStore._codec.encode(updates));
  // Zero-length entries survive the round trip, so the count never drifts.
  assert.equal(decoded.length, 3);
  assert.deepEqual([...decoded[0]], [1, 2, 3]);
  assert.deepEqual([...decoded[1]], []);
  assert.deepEqual([...decoded[2]], [9]);
});

test('a corrupt or truncated file is rejected rather than half-read', () => {
  assert.throws(() => docStore._codec.decode(Buffer.from('nope')), /not a FaceTimeOS doc file/);

  const good = docStore._codec.encode([buf(1, 2, 3, 4)]);
  assert.throws(() => docStore._codec.decode(good.subarray(0, good.length - 2)), /truncated/);

  const wrongVersion = Buffer.from(good);
  wrongVersion.writeUInt8(99, 4);
  assert.throws(() => docStore._codec.decode(wrongVersion), /unsupported doc format version/);
});

test('appendUpdate accumulates and reports when compaction is due', () => {
  assert.equal(docStore.appendUpdate('r1', buf(1)).accepted, true);
  assert.equal(docStore.appendUpdate('r1', buf(2, 3)).accepted, true);

  const stats = docStore.getStats('r1');
  assert.equal(stats.updates, 2);
  assert.equal(stats.bytes, 3);
  assert.equal(stats.hasContent, true);

  // Empty and non-buffer payloads are ignored instead of poisoning the log.
  assert.equal(docStore.appendUpdate('r1', buf()).accepted, false);
  assert.equal(docStore.appendUpdate('r1', 'not-a-buffer').accepted, false);
  assert.equal(docStore.getStats('r1').updates, 2);

  for (let i = 0; i < DOC_STORE.compactAfterUpdates; i += 1) {
    docStore.appendUpdate('r1', buf(i % 256));
  }
  assert.equal(docStore.appendUpdate('r1', buf(7)).needsCompaction, true);
});

test('the size quota stops a room growing without bound', () => {
  const big = Buffer.alloc(DOC_STORE.maxBytes);
  assert.equal(docStore.appendUpdate('r2', big).accepted, true);
  const rejected = docStore.appendUpdate('r2', buf(1));
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'quota');
  // The already-stored content is untouched.
  assert.equal(docStore.getStats('r2').updates, 1);
});

test('a snapshot collapses the log to one entry', () => {
  for (let i = 0; i < 20; i += 1) docStore.appendUpdate('r3', buf(i));
  assert.equal(docStore.getStats('r3').updates, 20);

  assert.equal(docStore.replaceWithSnapshot('r3', buf(1, 2, 3)), true);
  assert.equal(docStore.getStats('r3').updates, 1);
  assert.equal(docStore.getStats('r3').bytes, 3);

  assert.equal(docStore.replaceWithSnapshot('r3', buf()), false);
  assert.equal(docStore.replaceWithSnapshot('r3', Buffer.alloc(DOC_STORE.maxBytes + 1)), false);
});

test('artifacts survive a simulated restart', async () => {
  docStore.appendUpdate('r4', buf(10, 20));
  docStore.appendUpdate('r4', buf(30));
  await docStore.flush('r4');

  // Wipe memory, exactly as a process restart would.
  docStore._resetForTests();
  assert.equal(docStore.getStats('r4').hasContent, false);

  await docStore.ensureLoaded('r4');
  const updates = docStore.getUpdates('r4');
  assert.equal(updates.length, 2);
  assert.deepEqual([...updates[0]], [10, 20]);
  assert.deepEqual([...updates[1]], [30]);
});

test('concurrent loads of the same room share one read', async () => {
  docStore.appendUpdate('r5', buf(1));
  await docStore.flush('r5');
  docStore._resetForTests();

  const [a, b] = await Promise.all([docStore.ensureLoaded('r5'), docStore.ensureLoaded('r5')]);
  assert.equal(a, b);
  assert.equal(docStore.getUpdates('r5').length, 1);
});

test('an update appended mid-load is not lost', async () => {
  docStore.appendUpdate('r6', buf(1));
  await docStore.flush('r6');
  docStore._resetForTests();

  const loadPromise = docStore.ensureLoaded('r6');
  docStore.appendUpdate('r6', buf(2));
  await loadPromise;

  assert.equal(docStore.getUpdates('r6').length, 2);
});

test('deleteRoom removes memory and disk state', async () => {
  docStore.appendUpdate('r7', buf(1));
  await docStore.flush('r7');
  await docStore.deleteRoom('r7');

  docStore._resetForTests();
  await docStore.ensureLoaded('r7');
  assert.equal(docStore.getStats('r7').hasContent, false);
  // Deleting twice is not an error.
  await docStore.deleteRoom('r7');
});

test('evictExpired drops only idle rooms', async () => {
  docStore.appendUpdate('idle', buf(1));
  docStore.appendUpdate('active', buf(1));
  const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365;

  docStore.getUpdates('active');
  const evicted = await docStore.evictExpired(farFuture);
  assert.equal(evicted, 2, 'with a far-future clock every room is idle');

  docStore.appendUpdate('fresh', buf(1));
  assert.equal(await docStore.evictExpired(Date.now()), 0);
  assert.equal(docStore.getStats('fresh').hasContent, true);
});

test('a room id can never escape the storage directory', async () => {
  docStore.appendUpdate('../../escape', buf(1));
  await docStore.flush('../../escape');
  const files = await fs.readdir(DOC_STORE.dir);
  assert.equal(
    files.some((f) => f.includes('..')),
    false
  );
  assert.equal(files.includes('______escape.ftos'), true);
});

test.after(async () => {
  await fs.rm(DOC_STORE.dir, { recursive: true, force: true });
});
