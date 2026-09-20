/**
 * The REST client and the local session cache.
 *
 * The cache is the interesting half. Sessions used to live in `localStorage`,
 * which is shared by every tab of an origin, so two windows in one profile
 * overwrote each other's seat and a reload could resume the *other* peer's
 * token — the Host badge landing on the wrong person. These tests pin the
 * behaviour that fixed it: seats are per tab, names are per browser, and a
 * seat older than the server's token lifetime is not replayed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  roomApi,
  ApiError,
  saveSession,
  loadSession,
  clearSession,
  rememberName,
  rememberedName,
  saveHostToken,
  loadHostToken,
} from '../src/lib/room-api.js';

/** The two Web Storage areas, in memory, distinguishable from each other. */
function memStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function fakeWindow(t, { sessionStorage = memStorage(), localStorage = memStorage() } = {}) {
  globalThis.window = { sessionStorage, localStorage };
  t.after(() => {
    delete globalThis.window;
  });
  return { sessionStorage, localStorage };
}

function stubFetch(t, impl) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : undefined });
    return impl(url, options);
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

const ok = (json) => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(json),
});

/* ------------------------------- the requests ------------------------------ */

test('each endpoint is called with the method and body the server expects', async (t) => {
  const calls = stubFetch(t, ok({ roomId: 'r1' }));

  await roomApi.health();
  await roomApi.createRoom("Alok's room");
  await roomApi.probeRoom('r1');
  await roomApi.createSession('r1', { displayName: 'Alok', inviteToken: 'inv' });
  await roomApi.createInvite('r1', { sessionToken: 'sess', role: 'viewer', ttl: 3600 });
  await roomApi.clearArtifacts('r1', 'sess');

  assert.deepEqual(
    calls.map((call) => `${call.options.method ?? 'GET'} ${call.url.replace(/^.*\/rtc/, '')}`),
    [
      'GET /health',
      'POST /rooms',
      'GET /rooms/r1',
      'POST /rooms/r1/session',
      'POST /rooms/r1/invites',
      'DELETE /rooms/r1/artifacts',
    ]
  );

  assert.deepEqual(calls[1].body, { title: "Alok's room" });
  // No `resumeToken` key at all — an absent token must not be sent as null, or
  // the server tries to verify it and rejects the join.
  assert.deepEqual(calls[3].body, { displayName: 'Alok', inviteToken: 'inv' });
  assert.deepEqual(calls[4].body, { sessionToken: 'sess', role: 'viewer', ttl: 3600 });
  assert.deepEqual(calls[5].body, { sessionToken: 'sess' });

  // Nothing is cached: a probe must see the room as it is now.
  assert.ok(calls.every((call) => call.options.cache === 'no-store'));
  // A body always announces its type; a GET never sends one.
  assert.equal(calls[0].options.headers, undefined);
  assert.deepEqual(calls[1].options.headers, { 'content-type': 'application/json' });
});

test('an unreachable server is reported as offline, not as a failed request', async (t) => {
  stubFetch(t, async () => {
    throw new TypeError('Failed to fetch');
  });

  await assert.rejects(() => roomApi.health(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'offline');
    assert.equal(error.status, undefined);
    assert.match(error.message, /Could not reach the meeting server/);
    return true;
  });
});

test('an aborted probe rejects as an abort, so the caller can ignore it', async (t) => {
  stubFetch(t, async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });

  await assert.rejects(() => roomApi.probeRoom('r1'), { name: 'AbortError' });
});

test("the server's own error message is what the user sees", async (t) => {
  stubFetch(t, async () => ({
    ok: false,
    status: 423,
    text: async () => JSON.stringify({ error: 'room-locked', message: 'The host locked this room.' }),
  }));

  await assert.rejects(() => roomApi.createSession('r1', { displayName: 'Alok' }), (error) => {
    assert.equal(error.status, 423);
    assert.equal(error.code, 'room-locked');
    assert.equal(error.message, 'The host locked this room.');
    return true;
  });
});

test('a failure with no JSON body still carries its status', async (t) => {
  stubFetch(t, async () => ({ ok: false, status: 502, text: async () => '' }));

  await assert.rejects(() => roomApi.health(), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /Request failed \(502\)/);
    return true;
  });
});

test('an HTML error page from a proxy is not mistaken for a response', async (t) => {
  stubFetch(t, async () => ({
    ok: false,
    status: 504,
    text: async () => '<html>Gateway Timeout</html>',
  }));

  await assert.rejects(() => roomApi.health(), (error) => {
    assert.equal(error.code, 'bad-response');
    assert.equal(error.status, 504);
    return true;
  });
});

test('an empty successful body is null rather than a parse error', async (t) => {
  stubFetch(t, async () => ({ ok: true, status: 204, text: async () => '' }));
  assert.equal(await roomApi.clearArtifacts('r1', 'sess'), null);
});

/* ---------------------------- the session cache ---------------------------- */

const SEAT = {
  sessionToken: 'jwt.for.this.tab',
  peerId: 'peer-1',
  role: 'host',
  displayName: 'Alok',
};

test('a seat is stored per tab and the name per browser', (t) => {
  const { sessionStorage, localStorage } = fakeWindow(t);

  saveSession('r1', SEAT);

  // The token must not be in localStorage, where a second tab would find it.
  assert.equal(localStorage.getItem('ftos.session.r1'), null);
  assert.ok(sessionStorage.getItem('ftos.session.r1'));
  assert.equal(localStorage.getItem('ftos.displayName'), 'Alok');

  const loaded = loadSession('r1');
  assert.equal(loaded.sessionToken, SEAT.sessionToken);
  assert.equal(loaded.peerId, 'peer-1');
  assert.equal(loaded.role, 'host');
  assert.ok(loaded.savedAt <= Date.now());

  assert.equal(rememberedName(), 'Alok');
  assert.equal(loadSession('other-room'), null);
});

test('a session with no token is not worth storing', (t) => {
  const { sessionStorage } = fakeWindow(t);
  saveSession('r1', { peerId: 'peer-1', role: 'host' });
  saveSession('r1', null);
  assert.equal(sessionStorage.map.size, 0);
});

test('a seat older than the server-side token lifetime is not replayed', (t) => {
  const { sessionStorage } = fakeWindow(t);
  const thirteenHours = 13 * 60 * 60 * 1000;

  sessionStorage.setItem(
    'ftos.session.r1',
    JSON.stringify({ ...SEAT, savedAt: Date.now() - thirteenHours })
  );
  assert.equal(loadSession('r1'), null);

  sessionStorage.setItem(
    'ftos.session.r1',
    JSON.stringify({ ...SEAT, savedAt: Date.now() - 60_000 })
  );
  assert.equal(loadSession('r1').peerId, 'peer-1');
});

test('a tab holding a seat in the old localStorage layout is migrated once', (t) => {
  const { sessionStorage, localStorage } = fakeWindow(t);
  localStorage.setItem('ftos.session.r1', JSON.stringify({ ...SEAT, savedAt: Date.now() }));

  const loaded = loadSession('r1');

  assert.equal(loaded.peerId, 'peer-1');
  assert.ok(sessionStorage.getItem('ftos.session.r1'), 'seat should have moved to this tab');
  assert.equal(localStorage.getItem('ftos.session.r1'), null, 'other tabs must not inherit it');
});

test('corrupt stored JSON is treated as no seat at all', (t) => {
  const { sessionStorage } = fakeWindow(t);
  sessionStorage.setItem('ftos.session.r1', '{not json');
  assert.equal(loadSession('r1'), null);
});

test('clearing a seat removes it from both storages', (t) => {
  const { sessionStorage, localStorage } = fakeWindow(t);
  saveSession('r1', SEAT);
  localStorage.setItem('ftos.session.r1', 'stale');

  clearSession('r1');

  assert.equal(sessionStorage.getItem('ftos.session.r1'), null);
  assert.equal(localStorage.getItem('ftos.session.r1'), null);
});

test('a name can be remembered before there is any session to attach it to', (t) => {
  fakeWindow(t);
  assert.equal(rememberedName(), '');
  rememberName('Chris');
  assert.equal(rememberedName(), 'Chris');
  // An empty name must not wipe the remembered one.
  rememberName('');
  assert.equal(rememberedName(), 'Chris');
});

test('host tokens are kept per room, so rejoining one room does not host another', (t) => {
  fakeWindow(t);
  saveHostToken('r1', 'host-jwt-1');
  saveHostToken('r2', 'host-jwt-2');

  assert.equal(loadHostToken('r1'), 'host-jwt-1');
  assert.equal(loadHostToken('r2'), 'host-jwt-2');
  assert.equal(loadHostToken('r3'), null);

  saveHostToken('r4', null);
  assert.equal(loadHostToken('r4'), null);
});

test('private browsing, where storage throws, degrades instead of crashing', (t) => {
  const throwing = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('SecurityError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  };
  fakeWindow(t, { sessionStorage: throwing, localStorage: throwing });

  assert.doesNotThrow(() => saveSession('r1', SEAT));
  assert.equal(loadSession('r1'), null);
  assert.doesNotThrow(() => clearSession('r1'));
  assert.equal(rememberedName(), '');
  assert.doesNotThrow(() => rememberName('Alok'));
  assert.equal(loadHostToken('r1'), null);
});

test('server-rendered, with no window, every accessor is inert', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.doesNotThrow(() => saveSession('r1', SEAT));
  assert.equal(loadSession('r1'), null);
  assert.equal(rememberedName(), '');
  assert.equal(loadHostToken('r1'), null);
  assert.doesNotThrow(() => rememberName('Alok'));
  assert.doesNotThrow(() => saveHostToken('r1', 'token'));
});
