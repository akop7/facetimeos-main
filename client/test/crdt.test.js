/**
 * The mesh provider, tested with two providers and no network.
 *
 * `sendToPeer` is just a function, so a "mesh" here is one provider's send hook
 * pointed at the other's receive method. That is enough to exercise the parts
 * that are hard to see in a running call: the sync handshake, presence, and the
 * origin rules that stop an edit from ping-ponging between peers forever.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

import {
  MeshDocProvider,
  ORIGIN,
  SHARED_KEYS,
  createSharedTypes,
  createSharedDocument,
  destroySharedDocument,
  getAwarenessColor,
} from '../src/lib/crdt.js';

/** Wire two providers straight into each other, both directions. */
function connect(a, b) {
  const undoA = a.setTransport({
    sendToPeer: (_peerId, bytes) => b.receiveFromPeer(a.peerId, bytes),
    broadcastToPeers: (bytes) => (b.receiveFromPeer(a.peerId, bytes) ? 1 : 0),
  });
  const undoB = b.setTransport({
    sendToPeer: (_peerId, bytes) => a.receiveFromPeer(b.peerId, bytes),
    broadcastToPeers: (bytes) => (a.receiveFromPeer(b.peerId, bytes) ? 1 : 0),
  });
  return () => {
    undoA();
    undoB();
  };
}

function pair(t, roomId = 'room-1') {
  const alice = new MeshDocProvider({ roomId, peerId: 'alice', identity: { displayName: 'Alice' } });
  const bob = new MeshDocProvider({ roomId, peerId: 'bob', identity: { displayName: 'Bob' } });
  // The reaper is an interval; without this the runner never exits.
  t.after(() => {
    alice.destroy();
    bob.destroy();
  });
  return { alice, bob };
}

test('createSharedTypes hands back every shared type the room uses', () => {
  const doc = new Y.Doc();
  const types = createSharedTypes(doc);

  assert.deepEqual(Object.keys(types).sort(), Object.keys(SHARED_KEYS).sort());
  assert.ok(types.code instanceof Y.Text);
  assert.ok(types.notes instanceof Y.Text);
  assert.ok(types.whiteboard instanceof Y.Array);
  assert.ok(types.timeline instanceof Y.Array);
  assert.ok(types.chat instanceof Y.Array);
  assert.ok(types.windows instanceof Y.Map);
  assert.ok(types.meta instanceof Y.Map);

  doc.destroy();
});

test('a peer always gets the same awareness colour, from the palette', () => {
  const first = getAwarenessColor('peer-42');
  assert.equal(first, getAwarenessColor('peer-42'));
  assert.match(first, /^#[0-9a-f]{6}$/);

  // Different ids should not all collapse onto one colour.
  const spread = new Set(
    Array.from({ length: 40 }, (_, i) => getAwarenessColor(`peer-${i}`))
  );
  assert.ok(spread.size > 3, `expected a spread of colours, got ${spread.size}`);

  // A missing id must still resolve rather than index undefined.
  assert.match(getAwarenessColor(null), /^#[0-9a-f]{6}$/);
});

test('two peers converge on the same document', (t) => {
  const { alice, bob } = pair(t);
  connect(alice, bob);

  alice.sharedTypes.code.insert(0, 'const answer = 42;');
  alice.sharedTypes.chat.push([{ name: 'Alice', text: 'joining', at: 1 }]);

  assert.equal(bob.sharedTypes.code.toString(), 'const answer = 42;');
  assert.equal(bob.sharedTypes.chat.length, 1);

  // And back the other way, into the same buffer.
  bob.sharedTypes.code.insert(bob.sharedTypes.code.length, ' // agreed');
  assert.equal(alice.sharedTypes.code.toString(), 'const answer = 42; // agreed');
});

test('a peer that joins late is caught up by the handshake, not by luck', (t) => {
  const { alice, bob } = pair(t);

  // Alice works alone first — nothing is wired up yet.
  alice.sharedTypes.notes.insert(0, 'decided: ship on friday');
  assert.equal(bob.sharedTypes.notes.toString(), '');

  connect(alice, bob);
  let syncedFired = false;
  bob.on('synced', () => {
    syncedFired = true;
  });

  bob.syncWithPeer('alice');

  assert.equal(bob.sharedTypes.notes.toString(), 'decided: ship on friday');
  assert.equal(syncedFired, true);
  assert.ok(bob.syncedPeers.has('alice'));
  assert.equal(bob.synced, true);

  bob.dropPeer('alice');
  assert.equal(bob.syncedPeers.has('alice'), false);
});

test('presence crosses the mesh unprompted', (t) => {
  const { alice, bob } = pair(t);
  connect(alice, bob);

  alice.syncWithPeer('bob');

  const seen = bob.remoteStates();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'Alice');
  assert.equal(seen[0].peerId, 'alice');

  // Bob's own state is never in his own list of remotes.
  assert.ok(!seen.some((state) => state.peerId === 'bob'));

  alice.setLocalAwareness({ cursor: { line: 3 } });
  assert.deepEqual(bob.remoteStates()[0].cursor, { line: 3 });
});

test('an edit that arrived from the network is never sent back out', (t) => {
  const { alice } = pair(t);

  const broadcast = [];
  const toServer = [];
  alice.setTransport({
    broadcastToPeers: (bytes) => {
      broadcast.push(bytes);
      return 1;
    },
    sendToServer: (bytes) => toServer.push(bytes),
  });

  // A local edit goes everywhere.
  alice.sharedTypes.notes.insert(0, 'local');
  assert.equal(broadcast.length, 1);
  assert.equal(toServer.length, 1);

  // Something the server relayed is forwarded to peers but not echoed back to
  // the server that just sent it.
  const other = new Y.Doc();
  other.getText('notes').insert(0, 'from server');
  alice.receiveFromServer(Y.encodeStateAsUpdate(other));
  assert.equal(broadcast.length, 2);
  assert.equal(toServer.length, 1);
  other.destroy();

  // Something a peer sent is not rebroadcast at all — this is the livelock.
  const peerDoc = new Y.Doc();
  peerDoc.getText('code').insert(0, 'from peer');
  alice.receiveFromPeer('bob', new Uint8Array([2, ...Y.encodeStateAsUpdate(peerDoc)]));
  assert.equal(alice.sharedTypes.code.toString(), 'from peer');
  assert.equal(broadcast.length, 2);
  assert.equal(toServer.length, 1);
  peerDoc.destroy();
});

test('setTransport hands back a disposer that removes only its own hooks', (t) => {
  const { alice } = pair(t);

  const first = () => 1;
  const undoFirst = alice.setTransport({ broadcastToPeers: first });
  const second = () => 2;
  alice.setTransport({ broadcastToPeers: second });

  // The stale disposer must not tear down the transport that replaced it —
  // otherwise a reconnect leaves the new mesh unwired.
  undoFirst();
  assert.equal(alice.broadcastToPeers, second);
});

test('the durable server log is applied as one transaction and marks the doc synced', (t) => {
  const { alice } = pair(t);

  const source = new Y.Doc();
  const updates = [];
  source.on('update', (bytes) => updates.push(bytes));
  source.getText('notes').insert(0, 'one');
  source.getText('notes').insert(3, ' two');
  source.getArray('timeline').push([{ kind: 'decision', text: 'ship' }]);
  assert.equal(updates.length, 3);

  let repaints = 0;
  alice.doc.on('afterTransaction', () => {
    repaints += 1;
  });
  let synced = false;
  alice.on('synced', () => {
    synced = true;
  });

  const applied = alice.applyServerSnapshot(updates);

  assert.equal(applied, 3);
  assert.equal(alice.sharedTypes.notes.toString(), 'one two');
  assert.equal(alice.sharedTypes.timeline.length, 1);
  assert.equal(synced, true);
  // Three log entries, one transaction — not one repaint per entry.
  assert.equal(repaints, 1);
  source.destroy();
});

test('an empty server log still resolves the sync, rather than hanging on it', (t) => {
  const { alice } = pair(t);
  let synced = false;
  alice.on('synced', () => {
    synced = true;
  });

  assert.equal(alice.applyServerSnapshot([]), 0);
  assert.equal(synced, true);

  // Idempotent: a second resolution does not fire the event again.
  let again = false;
  alice.on('synced', () => {
    again = true;
  });
  alice.applyServerSnapshot(null);
  assert.equal(again, false);
});

test('snapshot() is a complete document the server can store as one blob', (t) => {
  const { alice } = pair(t);
  alice.sharedTypes.code.insert(0, 'print("hi")');
  alice.sharedTypes.meta.set('codeLanguage', 'python');

  const restored = new Y.Doc();
  Y.applyUpdate(restored, alice.snapshot());

  assert.equal(restored.getText('code').toString(), 'print("hi")');
  assert.equal(restored.getMap('meta').get('codeLanguage'), 'python');
  restored.destroy();
});

test('a destroyed provider stops accepting traffic instead of throwing', () => {
  const bundle = createSharedDocument('room-x', { peerId: 'solo' });
  assert.equal(bundle.provider.roomId, 'room-x');
  assert.equal(bundle.doc, bundle.provider.doc);
  assert.equal(bundle.awareness, bundle.provider.awareness);

  destroySharedDocument(bundle);

  assert.equal(bundle.provider.destroyed, true);
  assert.equal(bundle.provider.receiveFromPeer('bob', new Uint8Array([2, 1])), false);
  assert.equal(bundle.provider.receiveFromServer(new Uint8Array([1])), false);
  // Double destroy is what a React strict-mode remount does.
  destroySharedDocument(bundle);
});

test('a provider cannot be built without a room', () => {
  assert.throws(() => new MeshDocProvider({ peerId: 'nobody' }), /requires roomId/);
});

test('the origin constants are the ones the update handler branches on', () => {
  assert.deepEqual({ ...ORIGIN }, { peer: 'peer', server: 'server', local: 'idb' });
});
