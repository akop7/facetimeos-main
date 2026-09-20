import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DynamoDBRoomManager,
  createRoom,
  getRoom,
  updateParticipantState,
  closeRoom,
} from '../src/dynamodb-room-manager.js';

test('DynamoDBRoomManager initializes with default table name and region', () => {
  const manager = new DynamoDBRoomManager({ forceFallback: true });
  assert.equal(manager.tableName, 'facetimeos-rooms');
  assert.ok(manager.region);
  assert.equal(manager.isDynamoAvailable(), false);
  const stats = manager.stats();
  assert.equal(stats.provider, 'in-memory-fallback');
  assert.equal(stats.tableName, 'facetimeos-rooms');
});

test('DynamoDBRoomManager custom table name and region configuration', () => {
  const manager = new DynamoDBRoomManager({
    tableName: 'custom-hackathon-rooms',
    region: 'us-west-2',
    forceFallback: true,
  });
  assert.equal(manager.tableName, 'custom-hackathon-rooms');
  assert.equal(manager.region, 'us-west-2');
});

test('meeting room lifecycle in fallback/local mode: createRoom and getRoom', async () => {
  const manager = new DynamoDBRoomManager({ forceFallback: true });
  const roomId = 'room-test-123';
  const hostInfo = { peerId: 'peer-host', displayName: 'Alice' };
  const metadata = { title: "Alice's Room", maxPeers: 12 };

  const created = await manager.createRoom(roomId, hostInfo, metadata);
  assert.equal(created.roomId, roomId);
  assert.equal(created.status, 'active');
  assert.deepEqual(created.hostInfo, hostInfo);
  assert.deepEqual(created.metadata, metadata);
  assert.ok(created.createdAt);
  assert.ok(created.ttl);

  const retrieved = await manager.getRoom(roomId);
  assert.ok(retrieved);
  assert.equal(retrieved.roomId, roomId);
  assert.equal(retrieved.status, 'active');
  assert.equal(retrieved.hostInfo.displayName, 'Alice');
});

test('participant state updates for join and leave', async () => {
  const manager = new DynamoDBRoomManager({ forceFallback: true });
  const roomId = 'room-presence-test';
  await manager.createRoom(roomId, { peerId: 'host-1' });

  // Participant connects
  const joinPresence = await manager.updateParticipantState(roomId, 'guest-1', true, {
    displayName: 'Bob',
    role: 'editor',
  });
  assert.equal(joinPresence.participantId, 'guest-1');
  assert.equal(joinPresence.isConnected, true);
  assert.equal(joinPresence.displayName, 'Bob');
  assert.ok(joinPresence.lastSeen);

  let room = await manager.getRoom(roomId);
  assert.ok(room.participants['guest-1']);
  assert.equal(room.participants['guest-1'].isConnected, true);

  // Participant disconnects
  const leavePresence = await manager.updateParticipantState(roomId, 'guest-1', false);
  assert.equal(leavePresence.isConnected, false);

  room = await manager.getRoom(roomId);
  assert.equal(room.participants['guest-1'].isConnected, false);
});

test('closeRoom updates room status and records closedAt timestamp', async () => {
  const manager = new DynamoDBRoomManager({ forceFallback: true });
  const roomId = 'room-close-test';
  await manager.createRoom(roomId, { peerId: 'host-1' });

  const closeResult = await manager.closeRoom(roomId);
  assert.equal(closeResult.ok, true);
  assert.equal(closeResult.roomId, roomId);
  assert.equal(closeResult.status, 'closed');
  assert.ok(closeResult.closedAt);

  const room = await manager.getRoom(roomId);
  assert.equal(room.status, 'closed');
  assert.ok(room.closedAt);
});

test('graceful fallback when mock DynamoDB client throws errors', async () => {
  const mockFailingDocClient = {
    send: async () => {
      const err = new Error('ResourceNotFoundException: Table does not exist');
      err.name = 'ResourceNotFoundException';
      throw err;
    },
  };

  const manager = new DynamoDBRoomManager({
    docClient: mockFailingDocClient,
  });

  // Initially appears available before first failure
  assert.equal(manager.isDynamoAvailable(), true);

  // Operation should gracefully trigger fallback instead of throwing
  const created = await manager.createRoom('fallback-room', { peerId: 'h1' });
  assert.equal(created.roomId, 'fallback-room');
  assert.equal(manager.fallbackActive, true);
  assert.equal(manager.isDynamoAvailable(), false);

  // Subsequent reads and updates continue working via in-memory store
  const room = await manager.getRoom('fallback-room');
  assert.equal(room.roomId, 'fallback-room');

  await manager.updateParticipantState('fallback-room', 'p1', true);
  const updated = await manager.getRoom('fallback-room');
  assert.equal(updated.participants['p1'].isConnected, true);

  const closed = await manager.closeRoom('fallback-room');
  assert.equal(closed.status, 'closed');
});

test('AWS SDK commands execution when DynamoDB is available and responds', async () => {
  const recordedCommands = [];
  const mockSuccessDocClient = {
    send: async (cmd) => {
      recordedCommands.push(cmd);
      if (cmd.input?.Key?.roomId) {
        return {
          Item: {
            roomId: cmd.input.Key.roomId,
            status: 'active',
            fromMock: true,
          },
        };
      }
      return {};
    },
  };

  const manager = new DynamoDBRoomManager({
    docClient: mockSuccessDocClient,
  });

  assert.equal(manager.isDynamoAvailable(), true);

  await manager.createRoom('aws-room-1', { peerId: 'host-1' }, { title: 'AWS Room' });
  assert.equal(recordedCommands.length, 1);
  assert.equal(recordedCommands[0].input.TableName, 'facetimeos-rooms');
  assert.equal(recordedCommands[0].input.Item.roomId, 'aws-room-1');

  const fetched = await manager.getRoom('aws-room-1');
  assert.equal(recordedCommands.length, 2);
  assert.equal(fetched.roomId, 'aws-room-1');

  await manager.updateParticipantState('aws-room-1', 'p1', true);
  assert.equal(recordedCommands.length, 3);

  await manager.closeRoom('aws-room-1');
  assert.equal(recordedCommands.length, 4);
});

test('exported standalone helper functions operate correctly', async () => {
  const roomId = 'helper-func-room';
  const created = await createRoom(roomId, { peerId: 'host-h' }, { title: 'Helper' });
  assert.equal(created.roomId, roomId);

  const found = await getRoom(roomId);
  assert.equal(found.roomId, roomId);

  const presence = await updateParticipantState(roomId, 'p-help', true);
  assert.equal(presence.isConnected, true);

  const closed = await closeRoom(roomId);
  assert.equal(closed.status, 'closed');
});
