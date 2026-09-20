import { NativeModules } from 'react-native';
import * as Y from 'yjs';
import { RoomEngine } from '../src/RoomEngine';
jest.mock('react-native-webrtc', () => ({
  mediaDevices: {},
  MediaStream: jest.fn(),
}));
jest.mock('react-native-incall-manager', () => ({
  stop: jest.fn(),
  setKeepScreenOn: jest.fn(),
}));
jest.mock('socket.io-client', () => ({ io: jest.fn() }));
jest.mock('../../client/src/lib/webrtc', () => ({
  PeerConnectionManager: jest.fn(),
}));
jest.mock('../../client/src/lib/yjs-transport', () => ({
  encodeUpdate: value => value,
}));

let engine, handlers;
beforeEach(() => {
  NativeModules.FaceTimeMeeting = { stopMeeting: jest.fn() };
  engine = new RoomEngine(
    { roomId: 'test' },
    { displayName: 'Mobile' },
    jest.fn(),
  );
  engine.session = { peerId: 'mobile', displayName: 'Mobile' };
  handlers = {};
  engine.socket = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
  engine.rtc = {
    broadcast: jest.fn(),
    destroy: jest.fn(),
    peers: new Map(),
    applyQualityLadder: jest.fn().mockResolvedValue(),
    closePeer: jest.fn(),
  };
  engine.wire();
  engine.joined = true;
  engine.patch({
    role: 'editor',
    connected: true,
    tools: { whiteboard: true },
  });
});
afterEach(() => engine.dispose());

test('editing is blocked until cloud snapshot loads and while reconnecting', () => {
  expect(engine.canEdit()).toBe(false);
  handlers['doc-snapshot']({ updates: [] });
  expect(engine.canEdit()).toBe(true);
  expect(engine.canEdit('whiteboard')).toBe(true);
  expect(engine.canEdit('code')).toBeFalsy();
  handlers.disconnect();
  expect(engine.canEdit()).toBe(false);
});
test('malformed persisted data fails closed instead of overwriting cloud work', () => {
  handlers['doc-snapshot']({ updates: ['invalid'] });
  expect(engine.canEdit()).toBe(false);
  engine.sendChat('not allowed');
  expect(engine.doc.getArray('chat').length).toBe(0);
});
test('timeline/chat match web schema, incoming data is not echoed back', () => {
  handlers['doc-snapshot']({ updates: [] });
  engine.log('decision', 'Ship a beta');
  engine.sendChat(' hello web ');
  expect(engine.doc.getArray('timeline').get(0)).toMatchObject({
    by: 'mobile',
    byName: 'Mobile',
    kind: 'decision',
  });
  expect(engine.doc.getArray('chat').get(0)).toMatchObject({
    from: 'mobile',
    name: 'Mobile',
    text: 'hello web',
  });
  const remote = new Y.Doc();
  remote.getText('notes').insert(0, 'from browser');
  engine.socket.emit.mockClear();
  handlers['doc-update']({ update: Y.encodeStateAsUpdate(remote) });
  expect(engine.doc.getText('notes').toString()).toBe('from browser');
  expect(engine.socket.emit).not.toHaveBeenCalled();
  remote.destroy();
});
test('viewers cannot publish edits or use granted tools', () => {
  handlers['doc-snapshot']({ updates: [] });
  engine.patch({ role: 'viewer' });
  expect(engine.canEdit('whiteboard')).toBe(false);
  engine.sendChat('blocked');
  engine.log('decision', 'blocked');
  expect(engine.doc.getArray('chat').length).toBe(0);
  expect(engine.doc.getArray('timeline').length).toBe(0);
});
test('participants joining during screen share receive screen track', () => {
  const track = { id: 'screen' },
    replaceTrack = jest.fn().mockResolvedValue();
  engine.screenStream = { getVideoTracks: () => [track], getTracks: () => [] };
  engine.rtc.ensurePeer = jest.fn(id => {
    const peer = { senders: new Map([['video', { replaceTrack }]]) };
    engine.rtc.peers.set(id, peer);
    return peer;
  });
  engine.updatePeers([{ peerId: 'browser', role: 'editor' }]);
  expect(replaceTrack).toHaveBeenCalledWith(track);
});
