/**
 * The wire format, tested without a wire.
 *
 * These frames are the one part of the collaboration stack that has no visible
 * failure mode: a wrong type byte or an off-by-one payload offset does not throw,
 * it just silently drops somebody's edit. Two documents converging is the only
 * assertion that actually proves the codec.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

import {
  MSG,
  frame,
  unframe,
  toBytes,
  encodeSyncRequest,
  encodeSyncReply,
  encodeUpdate,
  handleFrame,
} from '../src/lib/yjs-transport.js';

test('a frame is one type byte followed by the payload, unchanged', () => {
  const payload = new Uint8Array([9, 8, 7]);
  const framed = frame(MSG.UPDATE, payload);

  assert.equal(framed.length, 4);
  assert.equal(framed[0], MSG.UPDATE);

  const parsed = unframe(framed);
  assert.equal(parsed.type, MSG.UPDATE);
  assert.deepEqual([...parsed.payload], [9, 8, 7]);
});

test('an empty payload still round-trips', () => {
  const parsed = unframe(frame(MSG.SYNC_REQUEST));
  assert.equal(parsed.type, MSG.SYNC_REQUEST);
  assert.equal(parsed.payload.length, 0);
});

test('unframe rejects nothing-at-all rather than returning a bogus frame', () => {
  assert.equal(unframe(new Uint8Array(0)), null);
  assert.equal(unframe(null), null);
  assert.equal(unframe(undefined), null);
});

test('toBytes accepts every shape a data channel or socket.io can hand us', () => {
  const expected = [1, 2, 3];

  assert.deepEqual([...toBytes(new Uint8Array(expected))], expected);
  assert.deepEqual([...toBytes(new Uint8Array(expected).buffer)], expected);
  assert.deepEqual([...toBytes(expected)], expected);

  // A view into a larger buffer must be read at its own offset — this is the
  // case that silently corrupts data if `byteOffset` is ignored.
  const backing = new Uint8Array([0, 0, 1, 2, 3, 0]);
  const view = new Uint8Array(backing.buffer, 2, 3);
  assert.deepEqual([...toBytes(view)], expected);

  assert.equal(toBytes(null), null);
  assert.equal(toBytes('not bytes'), null);
});

test('a sync request carries a state vector, and the reply carries only the diff', () => {
  const theirs = new Y.Doc();
  const mine = new Y.Doc();
  mine.getText('code').insert(0, 'x'.repeat(500));

  const request = unframe(encodeSyncRequest(theirs));
  assert.equal(request.type, MSG.SYNC_REQUEST);

  const diff = unframe(encodeSyncReply(mine, request.payload));
  assert.equal(diff.type, MSG.SYNC_REPLY);

  // The peer already has nothing, so this particular diff is the whole document;
  // what matters is that the vector was accepted and produced a real update.
  assert.ok(diff.payload.length > 0);

  Y.applyUpdate(theirs, diff.payload);
  assert.equal(theirs.getText('code').toString().length, 500);

  // Now that they are level, asking again costs almost nothing — the property
  // that keeps a late joiner in a long session cheap.
  const secondRequest = unframe(encodeSyncRequest(theirs));
  const secondDiff = unframe(encodeSyncReply(mine, secondRequest.payload));
  assert.ok(secondDiff.payload.length < diff.payload.length);
});

test('handleFrame answers a sync request and applies an update', () => {
  const alice = new Y.Doc();
  const bob = new Y.Doc();
  alice.getText('notes').insert(0, 'agenda');

  // Bob asks; Alice answers.
  const answer = handleFrame({ doc: alice, data: encodeSyncRequest(bob) });
  assert.equal(answer.applied, true);
  assert.ok(answer.reply);

  const applied = handleFrame({ doc: bob, data: answer.reply, origin: 'peer' });
  assert.equal(applied.applied, true);
  assert.equal(applied.reply, undefined);
  assert.equal(bob.getText('notes').toString(), 'agenda');

  // And an incremental update afterwards.
  let update = null;
  alice.on('update', (bytes) => {
    update = bytes;
  });
  alice.getText('notes').insert(6, ': ship it');

  handleFrame({ doc: bob, data: encodeUpdate(update), origin: 'peer' });
  assert.equal(bob.getText('notes').toString(), 'agenda: ship it');
});

test('the origin passed to handleFrame reaches the local update handler', () => {
  const doc = new Y.Doc();
  const other = new Y.Doc();
  other.getMap('meta').set('codeLanguage', 'python');

  const origins = [];
  doc.on('update', (_bytes, origin) => origins.push(origin));

  handleFrame({
    doc,
    data: encodeSyncReply(other, null),
    origin: 'peer',
  });

  // Without this, a peer's edit is indistinguishable from a local one and gets
  // rebroadcast straight back at them.
  assert.deepEqual(origins, ['peer']);
});

test('empty and unknown frames are ignored rather than thrown', () => {
  const doc = new Y.Doc();

  assert.deepEqual(handleFrame({ doc, data: frame(MSG.UPDATE) }), { applied: false });
  assert.deepEqual(handleFrame({ doc, data: frame(MSG.SYNC_REPLY) }), { applied: false });
  assert.deepEqual(handleFrame({ doc, data: frame(200) }), { applied: false });
  assert.deepEqual(handleFrame({ doc, data: new Uint8Array(0) }), { applied: false });

  // Awareness frames with no awareness object are a real case: the server relay
  // carries them for documents that have no local presence attached.
  assert.deepEqual(
    handleFrame({ doc, data: frame(MSG.AWARENESS, new Uint8Array([1])) }),
    { applied: false }
  );
  assert.deepEqual(
    handleFrame({ doc, data: frame(MSG.AWARENESS_GONE, new Uint8Array([0, 0, 0, 1])) }),
    { applied: false }
  );
});
