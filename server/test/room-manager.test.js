import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomManager } from '../src/room-manager.js';
import { ROLES } from '../src/auth.js';

const join = (rm, roomId, peerId, role = ROLES.EDITOR, socketId = `s-${peerId}`) =>
  rm.joinRoom({ roomId, peerId, socketId, displayName: peerId, role });

test('the first peer in a room always ends up in charge', () => {
  const rm = new RoomManager();
  const res = join(rm, 'A', 'p1', ROLES.EDITOR);
  assert.equal(res.ok, true);
  // Without this, a room created from a plain link would have nobody able to
  // moderate it.
  assert.equal(res.peer.role, ROLES.HOST);
  assert.equal(rm.getRoom('A').hostPeerId, 'p1');
});

test('a host token holder becomes the primary host', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'guest', ROLES.EDITOR);
  const res = join(rm, 'A', 'owner', ROLES.HOST);
  assert.equal(res.peer.role, ROLES.HOST);
  assert.equal(rm.isHost('A', 'owner'), true);
});

test('signaling lookups cannot cross room boundaries', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'alice', ROLES.EDITOR, 'sock-alice');
  join(rm, 'B', 'bob', ROLES.EDITOR, 'sock-bob');

  assert.equal(rm.findSocketIdInRoom('A', 'alice'), 'sock-alice');
  // The regression this locks down: the old findSocketIdByPeerId walked every
  // room, so a peer in A could address a peer in B by guessing an id.
  assert.equal(rm.findSocketIdInRoom('A', 'bob'), null);
  assert.equal(rm.findSocketIdInRoom('B', 'alice'), null);
  assert.equal(rm.findSocketIdInRoom('nope', 'alice'), null);
});

test('the creator keeps the room across a reload instead of losing it', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'owner', ROLES.HOST);
  const early = join(rm, 'A', 'early', ROLES.EDITOR);
  early.peer.joinedAt = 1000;

  // The reload: the creator's socket drops for a moment. Promoting `early` here
  // is the exact bug the user hit — the Host badge moved and then stuck, because
  // the returning creator found the primary slot taken.
  const { newHostPeerId } = rm.leaveRoom('A', 'owner', 's-owner');
  assert.equal(newHostPeerId, null);
  assert.equal(rm.isHost('A', 'early'), false);
  assert.equal(rm.getRoom('A').hostPeerId, null);
  assert.equal(rm.getRoom('A').ownerPeerId, 'owner');

  const back = join(rm, 'A', 'owner', ROLES.HOST, 's-owner-2');
  assert.equal(back.isOwner, true);
  assert.equal(rm.getRoom('A').hostPeerId, 'owner');
  assert.equal(rm.isHost('A', 'early'), false);
});

test('an unclaimed room still elects someone who can moderate it', () => {
  const rm = new RoomManager();
  // Nobody ever presented a host credential, so there is no creator to reserve
  // the slot for and the room would otherwise be unmoderatable.
  const first = join(rm, 'A', 'early', ROLES.EDITOR);
  const late = join(rm, 'A', 'late', ROLES.EDITOR);
  first.peer.joinedAt = 1000;
  late.peer.joinedAt = 2000;
  assert.equal(rm.isHost('A', 'early'), true);

  const { newHostPeerId } = rm.leaveRoom('A', 'early', 's-early');
  assert.equal(newHostPeerId, 'late');
  assert.equal(rm.isHost('A', 'late'), true);
});

test('the creator reclaims the room from an acting host', () => {
  const rm = new RoomManager();
  const acting = join(rm, 'A', 'guest', ROLES.EDITOR);
  // Elected because the room was unclaimed.
  assert.equal(acting.peer.role, ROLES.HOST);

  const owner = join(rm, 'A', 'owner', ROLES.HOST);
  assert.equal(owner.isOwner, true);
  assert.deepEqual(owner.demoted, ['guest']);
  assert.equal(rm.getRoom('A').hostPeerId, 'owner');
  // The acting host goes back to being an editor rather than keeping a HOST
  // credential the server would have to honour on its next reload.
  assert.equal(rm.isHost('A', 'guest'), false);
  assert.equal(rm.canEdit('A', 'guest'), true);
});

test('a second host link is a co-host, not a new owner', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'owner', ROLES.HOST);
  const cohost = join(rm, 'A', 'cohost', ROLES.HOST);

  assert.equal(cohost.isOwner, false);
  assert.equal(cohost.peer.role, ROLES.HOST);
  // Full host powers, but the badge and the primary slot stay with the creator.
  assert.equal(rm.getRoom('A').hostPeerId, 'owner');
  assert.equal(rm.getRoom('A').ownerPeerId, 'owner');
});

test('a host link reclaims a room whose owner has gone', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'guest', ROLES.EDITOR);
  join(rm, 'A', 'owner-tab1', ROLES.HOST);
  rm.leaveRoom('A', 'owner-tab1', 's-owner-tab1');

  // Same person, new tab: a per-tab session was lost, so they arrive with a new
  // peerId and only the host link to prove who they are.
  const again = join(rm, 'A', 'owner-tab2', ROLES.HOST);
  assert.equal(again.isOwner, true);
  assert.equal(rm.getRoom('A').ownerPeerId, 'owner-tab2');
});

test('a reconnect keeps joinedAt so host election stays stable', () => {
  const rm = new RoomManager();
  const first = join(rm, 'A', 'p1', ROLES.HOST, 'sock-1');
  first.peer.joinedAt = 500;

  const again = join(rm, 'A', 'p1', ROLES.HOST, 'sock-2');
  assert.equal(again.isReconnect, true);
  assert.equal(again.previousSocketId, 'sock-1');
  assert.equal(again.peer.joinedAt, 500);
  assert.equal(rm.findSocketIdInRoom('A', 'p1'), 'sock-2');
});

test('a stale socket cannot evict a peer that already reconnected', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'p1', ROLES.HOST, 'sock-1');
  join(rm, 'A', 'p1', ROLES.HOST, 'sock-2');

  const { removed } = rm.leaveRoom('A', 'p1', 'sock-1');
  assert.equal(removed, null);
  assert.equal(rm.isPeerInRoom('A', 'p1'), true);

  const real = rm.leaveRoom('A', 'p1', 'sock-2');
  assert.equal(real.removed.peerId, 'p1');
  assert.equal(real.roomClosed, true);
});

test('canEdit gates viewers out of shared artifacts', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'host', ROLES.HOST);
  join(rm, 'A', 'editor', ROLES.EDITOR);
  join(rm, 'A', 'viewer', ROLES.VIEWER);

  assert.equal(rm.canEdit('A', 'host'), true);
  assert.equal(rm.canEdit('A', 'editor'), true);
  assert.equal(rm.canEdit('A', 'viewer'), false);
  assert.equal(rm.canEdit('A', 'ghost'), false);
  assert.equal(rm.canEdit('nope', 'host'), false);
});

test('grant and revoke edit change what a peer may do', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'host', ROLES.HOST);
  join(rm, 'A', 'guest', ROLES.VIEWER);

  rm.setRole('A', 'guest', ROLES.EDITOR);
  assert.equal(rm.canEdit('A', 'guest'), true);
  rm.setRole('A', 'guest', ROLES.VIEWER);
  assert.equal(rm.canEdit('A', 'guest'), false);
});

test('the peer list never leaks socket ids', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'p1', ROLES.HOST, 'secret-socket');
  const [peer] = rm.getRoomPeers('A');
  assert.equal('socketId' in peer, false);
  assert.deepEqual(Object.keys(peer).sort(), [
    'displayName',
    'handRaised',
    'isOwner',
    'joinedAt',
    'mutedByHost',
    'peerId',
    'role',
    'tools',
  ]);
});

test('the whiteboard and the code editor need an explicit grant', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'owner', ROLES.HOST);
  join(rm, 'A', 'guest', ROLES.EDITOR);

  // The host never has to ask.
  assert.equal(rm.canUseTool('A', 'owner', 'whiteboard'), true);
  assert.equal(rm.canUseTool('A', 'guest', 'whiteboard'), false);
  assert.equal(rm.canUseTool('A', 'guest', 'code'), false);

  rm.setToolAccess('A', 'guest', 'whiteboard', true);
  assert.equal(rm.canUseTool('A', 'guest', 'whiteboard'), true);
  // One grant is one tool: the code editor is still closed.
  assert.equal(rm.canUseTool('A', 'guest', 'code'), false);

  rm.setToolAccess('A', 'guest', 'whiteboard', false);
  assert.equal(rm.canUseTool('A', 'guest', 'whiteboard'), false);

  // Unknown tools cannot be granted at all.
  assert.equal(rm.setToolAccess('A', 'guest', 'terminal', true), null);
  assert.equal(rm.canUseTool('A', 'guest', 'terminal'), false);
});

test('a tool grant survives the grantee reloading', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'owner', ROLES.HOST);
  join(rm, 'A', 'guest', ROLES.EDITOR, 'sock-1');
  rm.setToolAccess('A', 'guest', 'code', true);

  join(rm, 'A', 'guest', ROLES.EDITOR, 'sock-2');
  assert.equal(rm.canUseTool('A', 'guest', 'code'), true);
});

test('handing over host transfers the room itself', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'owner', ROLES.HOST);
  join(rm, 'A', 'guest', ROLES.EDITOR);

  rm.setRole('A', 'guest', ROLES.HOST);
  assert.equal(rm.getRoom('A').ownerPeerId, 'guest');
  assert.equal(rm.getRoom('A').hostPeerId, 'guest');
  // Otherwise the previous owner would take the room back on their next reload.
  assert.equal(rm.isHost('A', 'owner'), false);
});

test('a room closes when the last peer leaves but is re-creatable', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'p1', ROLES.HOST);
  const { roomClosed } = rm.leaveRoom('A', 'p1', 's-p1');
  assert.equal(roomClosed, true);
  assert.equal(rm.getRoom('A'), null);
  // Re-entering the same link must work — the artifacts outlive the live room.
  assert.equal(join(rm, 'A', 'p2', ROLES.HOST).ok, true);
});

test('a full room is refused', () => {
  const rm = new RoomManager();
  for (let i = 0; i < 12; i += 1) join(rm, 'A', `p${i}`, ROLES.EDITOR);
  const overflow = join(rm, 'A', 'p12', ROLES.EDITOR);
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error, 'room-full');
  // An existing peer reconnecting is not an overflow.
  assert.equal(join(rm, 'A', 'p0', ROLES.EDITOR, 'new-sock').ok, true);
});

test('waiting room admits and denies without touching the live peer list', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'host', ROLES.HOST);
  rm.setLocked('A', true);
  rm.addToWaitingRoom('A', { peerId: 'guest', displayName: 'Guest', socketId: 's-guest' });

  assert.equal(rm.getWaitingRoom('A').length, 1);
  assert.equal(rm.isPeerInRoom('A', 'guest'), false);

  rm.removeFromWaitingRoom('A', 'guest');
  assert.equal(rm.getWaitingRoom('A').length, 0);

  // Unlocking clears anyone still queued.
  rm.setLocked('A', true);
  rm.addToWaitingRoom('A', { peerId: 'g2', displayName: 'G2', socketId: 's-g2' });
  rm.setLocked('A', false);
  assert.equal(rm.getWaitingRoom('A').length, 0);
});

test('removeSocketFromAllRooms cleans up a dropped connection', () => {
  const rm = new RoomManager();
  join(rm, 'A', 'p1', ROLES.HOST, 'sock-x');
  join(rm, 'A', 'p2', ROLES.EDITOR, 'sock-y');

  const results = rm.removeSocketFromAllRooms('sock-y');
  assert.equal(results.length, 1);
  assert.equal(results[0].peerId, 'p2');
  assert.equal(rm.isPeerInRoom('A', 'p2'), false);
  assert.equal(rm.isPeerInRoom('A', 'p1'), true);
});

test('a room reached by link is named after whoever is in charge', () => {
  const rm = new RoomManager();
  // The regression: rooms are in-memory, so a host link opened after a restart
  // recreated the room through joinRoom and the header read "Untitled room".
  const res = rm.joinRoom({
    roomId: 'A',
    peerId: 'p1',
    socketId: 's1',
    displayName: 'Alok',
    role: ROLES.HOST,
  });
  assert.equal(res.ok, true);
  assert.equal(rm.getRoom('A').title, "Alok's room");
});

test('a name already ending in s does not get a second one', () => {
  const rm = new RoomManager();
  rm.joinRoom({ roomId: 'A', peerId: 'p1', socketId: 's1', displayName: 'Chris', role: ROLES.HOST });
  assert.equal(rm.getRoom('A').title, "Chris' room");
});

test('an explicitly created room keeps its title when peers join', () => {
  const rm = new RoomManager();
  rm.createRoom('A', { title: 'Standup' });
  join(rm, 'A', 'p1', ROLES.HOST);
  join(rm, 'A', 'p2', ROLES.EDITOR);
  assert.equal(rm.getRoom('A').title, 'Standup');
});
