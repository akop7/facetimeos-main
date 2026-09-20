import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 34117;
const BASE = `http://127.0.0.1:${PORT}/rtc`;

let child;
let dataDir;

const api = async (method, urlPath, body) => {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

test.before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ftos-http-'));
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
      JWT_SECRET: 'test-secret-that-is-definitely-long-enough-32',
      DOC_STORE_DIR: dataDir,
      CLIENT_ORIGIN: '',
      // These cases assert the no-relay behaviour, so the relay configuration has
      // to be cleared rather than assumed absent: a developer with a working
      // `server/.env` would otherwise fail two tests for doing the right thing.
      // `turn.test.js` covers the configured cases.
      TURN_URLS: '',
      TURN_SECRET: '',
      TURN_USERNAME: '',
      TURN_PASSWORD: '',
      METERED_APP_NAME: '',
      METERED_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 150));
  }
});

test.after(async () => {
  child?.kill();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

test('GET /rtc/health reports readiness and whether TURN is configured', async () => {
  const { status, json } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  // Surfacing this matters: without a relay, some peers simply cannot connect.
  assert.equal(json.turn, false);
});

test('GET /rtc/ice returns an ICE list even with no TURN configured', async () => {
  const { status, json } = await api('GET', '/ice');
  assert.equal(status, 200);
  assert.ok(json.iceServers.length >= 1);
  assert.equal(json.hasTurn, false);
  assert.deepEqual(json.iceTransportPolicyOptions, ['all']);
});

test('creating a room mints server-signed tokens', async () => {
  const { status, json } = await api('POST', '/rooms', { title: 'Standup' });
  assert.equal(status, 201);
  assert.match(json.roomId, /^[0-9a-f-]{36}$/);
  assert.equal(json.title, 'Standup');
  // Three JWTs the browser could never have produced itself.
  for (const token of [json.hostToken, json.inviteTokens.editor, json.inviteTokens.viewer]) {
    assert.equal(token.split('.').length, 3);
  }
});

test('a host token yields a host session; a viewer link yields view-only', async () => {
  const { json: room } = await api('POST', '/rooms', {});

  const host = await api('POST', `/rooms/${room.roomId}/session`, {
    displayName: 'Alok',
    inviteToken: room.hostToken,
  });
  assert.equal(host.status, 200);
  assert.equal(host.json.role, 'host');
  assert.match(host.json.peerId, /^[0-9a-f-]{36}$/);

  const viewer = await api('POST', `/rooms/${room.roomId}/session`, {
    displayName: 'Guest',
    inviteToken: room.inviteTokens.viewer,
  });
  assert.equal(viewer.json.role, 'viewer');
  // Identities are server-assigned, so two joiners can never collide or spoof.
  assert.notEqual(host.json.peerId, viewer.json.peerId);
});

test('a session survives a reload with the same identity and role', async () => {
  const { json: room } = await api('POST', '/rooms', {});
  const first = await api('POST', `/rooms/${room.roomId}/session`, {
    displayName: 'Alok',
    inviteToken: room.hostToken,
  });
  const resumed = await api('POST', `/rooms/${room.roomId}/session`, {
    displayName: 'Alok',
    resumeToken: first.json.sessionToken,
  });
  assert.equal(resumed.json.peerId, first.json.peerId);
  assert.equal(resumed.json.role, 'host');
});

test('a token from another room is refused', async () => {
  const { json: roomA } = await api('POST', '/rooms', {});
  const { json: roomB } = await api('POST', '/rooms', {});
  const res = await api('POST', `/rooms/${roomB.roomId}/session`, {
    displayName: 'Attacker',
    inviteToken: roomA.hostToken,
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'token-room-mismatch');
});

test('a garbage invite token is refused instead of silently downgraded', async () => {
  const { json: room } = await api('POST', '/rooms', {});
  const res = await api('POST', `/rooms/${room.roomId}/session`, {
    displayName: 'Attacker',
    inviteToken: 'aaa.bbb.ccc',
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'invalid-invite-token');
});

test('joining with no token at all still works (guest join) as an editor', async () => {
  const { json: room } = await api('POST', '/rooms', {});
  const res = await api('POST', `/rooms/${room.roomId}/session`, { displayName: 'Walk-in' });
  assert.equal(res.status, 200);
  assert.equal(res.json.role, 'editor');
  assert.equal(res.json.displayName, 'Walk-in');
});

test('a malformed room id is rejected before touching storage', async () => {
  const res = await api('POST', '/rooms/..%2F..%2Fetc/session', { displayName: 'x' });
  assert.equal(res.status, 400);
  const probe = await api('GET', '/rooms/not-a-uuid');
  assert.equal(probe.status, 400);
});

test('only a host may mint extra invite links', async () => {
  const { json: room } = await api('POST', '/rooms', {});
  const host = await api('POST', `/rooms/${room.roomId}/session`, {
    displayName: 'Host',
    inviteToken: room.hostToken,
  });
  const viewer = await api('POST', `/rooms/${room.roomId}/session`, {
    displayName: 'Viewer',
    inviteToken: room.inviteTokens.viewer,
  });

  const allowed = await api('POST', `/rooms/${room.roomId}/invites`, {
    sessionToken: host.json.sessionToken,
    role: 'editor',
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.role, 'editor');

  const denied = await api('POST', `/rooms/${room.roomId}/invites`, {
    sessionToken: viewer.json.sessionToken,
    role: 'host',
  });
  assert.equal(denied.status, 403);
});

test('deleting saved artifacts requires a host session', async () => {
  const { json: room } = await api('POST', '/rooms', {});
  const viewer = await api('POST', `/rooms/${room.roomId}/session`, {
    displayName: 'Viewer',
    inviteToken: room.inviteTokens.viewer,
  });
  const denied = await api('DELETE', `/rooms/${room.roomId}/artifacts`, {
    sessionToken: viewer.json.sessionToken,
  });
  assert.equal(denied.status, 403);
});

test('unknown routes return json, not an html error page', async () => {
  const { status, json } = await api('GET', '/nope');
  assert.equal(status, 404);
  assert.equal(json.error, 'not-found');
});

test('a room created without a title has no title, rather than a placeholder', async () => {
  const { json } = await api('POST', '/rooms', {});
  // 'Untitled room' used to be minted here and in the Room constructor, which is
  // what the room header ended up printing. Absent means absent; the first join
  // names the room after the host.
  assert.equal(json.title, null);

  const probe = await api('GET', `/rooms/${json.roomId}`);
  assert.equal(probe.json.title, null);
});
