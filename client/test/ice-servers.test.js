/**
 * Where the client thinks the signaling server is, and what it does when the ICE
 * endpoint is unreachable.
 *
 * These two things are worth a test because both fail quietly and identically:
 * everyone sits in the room alone. The resolution order is evaluated at module
 * load from `process.env` and `window.location`, so each case imports the module
 * fresh under a different fake environment — hence the `?case=` suffixes, which
 * are how you defeat the ESM module cache without a mocking library.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const MODULE = '../src/constants/ice-servers.js';

/** Load the module fresh with `window` and the env vars staged. */
async function loadWith({ caseId, env = {}, location = null }) {
  const previousEnv = {};
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (location) globalThis.window = { location };

  try {
    return await import(`${MODULE}?case=${caseId}`);
  } finally {
    delete globalThis.window;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('an explicit signaling URL wins over everything else', async () => {
  const mod = await loadWith({
    caseId: 'explicit',
    env: { NEXT_PUBLIC_SIGNALING_URL: 'https://signal.example.com' },
    location: { hostname: 'app.vercel.app', origin: 'https://app.vercel.app' },
  });

  assert.equal(mod.SIGNALING_SERVER_URL, 'https://signal.example.com');
  assert.equal(mod.API_BASE, 'https://signal.example.com/rtc');
  // Cross-origin, so socket.io can upgrade to a real WebSocket.
  assert.equal(mod.SIGNALING_IS_PROXIED, false);
});

test('on localhost the client talks straight to the dev server on 3001', async () => {
  const mod = await loadWith({
    caseId: 'localhost',
    env: { NEXT_PUBLIC_SIGNALING_URL: undefined },
    location: { hostname: 'localhost', origin: 'http://localhost:3000' },
  });

  assert.equal(mod.SIGNALING_SERVER_URL, 'http://localhost:3001');
  assert.equal(mod.API_BASE, 'http://localhost:3001/rtc');
  assert.equal(mod.SIGNALING_IS_PROXIED, false);
});

test('any other host falls back to same-origin, which means proxied transport', async () => {
  const mod = await loadWith({
    caseId: 'tunnel',
    env: { NEXT_PUBLIC_SIGNALING_URL: undefined },
    location: { hostname: 'abc.trycloudflare.com', origin: 'https://abc.trycloudflare.com' },
  });

  assert.equal(mod.SIGNALING_SERVER_URL, 'https://abc.trycloudflare.com');
  assert.equal(mod.API_BASE, '/rtc');
  // This flag is what forces polling-only: a Next rewrite cannot carry a
  // WebSocket upgrade, and without the flag the socket retries forever.
  assert.equal(mod.SIGNALING_IS_PROXIED, true);
});

test('rendered on the server, with no window at all, nothing throws', async () => {
  const mod = await loadWith({
    caseId: 'ssr',
    env: { NEXT_PUBLIC_SIGNALING_URL: undefined },
  });

  assert.equal(mod.SIGNALING_SERVER_URL, 'http://localhost:3001');
  assert.equal(mod.API_BASE, 'http://localhost:3001/rtc');
  assert.equal(mod.SIGNALING_IS_PROXIED, false);
});

test('the STUN fallback list is configurable and never empty', async () => {
  const fromEnv = await loadWith({
    caseId: 'stun-env',
    env: { NEXT_PUBLIC_STUN_URLS: 'stun:one.example:3478, stun:two.example:3478 ,' },
  });
  assert.deepEqual(fromEnv.FALLBACK_ICE_SERVERS, [
    { urls: 'stun:one.example:3478' },
    { urls: 'stun:two.example:3478' },
  ]);

  const defaults = await loadWith({
    caseId: 'stun-default',
    env: { NEXT_PUBLIC_STUN_URLS: undefined },
  });
  assert.ok(defaults.FALLBACK_ICE_SERVERS.length > 0);
  assert.match(defaults.FALLBACK_ICE_SERVERS[0].urls, /^stun:/);
  // The deprecated alias must keep resolving rather than throw at import.
  assert.deepEqual(defaults.ICE_SERVERS, defaults.FALLBACK_ICE_SERVERS);
});

/* -------------------------------------------------------------------------- */
/* fetchIceConfig                                                              */
/* -------------------------------------------------------------------------- */

const TURN_RESPONSE = {
  iceServers: [
    { urls: 'stun:stun.example:3478' },
    { urls: 'turn:turn.example:3478', username: 'ephemeral', credential: 'hmac' },
  ],
  hasTurn: true,
  ttlSeconds: 3600,
  iceTransportPolicyOptions: ['all', 'relay'],
};

/** Replace `fetch` and `console.warn` for the duration of one test. */
function stubFetch(t, impl) {
  const calls = [];
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  console.warn = () => {};
  t.after(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  });
  return calls;
}

test('live TURN credentials are returned and then cached', async (t) => {
  const mod = await loadWith({ caseId: 'fetch-ok' });
  const calls = stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => TURN_RESPONSE,
  }));

  const config = await mod.fetchIceConfig();
  assert.equal(config.hasTurn, true);
  assert.equal(config.degraded, false);
  assert.deepEqual(config.iceServers, TURN_RESPONSE.iceServers);
  assert.deepEqual(config.iceTransportPolicyOptions, ['all', 'relay']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rtc\/ice$/);
  assert.equal(calls[0].options.cache, 'no-store');

  // A second caller inside the credential lifetime reuses the answer.
  await mod.fetchIceConfig();
  assert.equal(calls.length, 1);

  // `force` is what an ICE restart uses when a call outlives its credentials.
  await mod.fetchIceConfig({ force: true });
  assert.equal(calls.length, 2);

  mod.clearIceCache();
  await mod.fetchIceConfig();
  assert.equal(calls.length, 3);
});

test('an unreachable ICE endpoint degrades to STUN instead of failing the call', async (t) => {
  const mod = await loadWith({ caseId: 'fetch-throws' });
  stubFetch(t, async () => {
    throw new Error('ECONNREFUSED');
  });

  const config = await mod.fetchIceConfig();
  assert.equal(config.degraded, true);
  assert.equal(config.hasTurn, false);
  assert.deepEqual(config.iceServers, mod.FALLBACK_ICE_SERVERS);
  assert.deepEqual(config.iceTransportPolicyOptions, ['all']);

  // A degraded answer is deliberately not cached — the next attempt retries.
  const again = await mod.fetchIceConfig();
  assert.equal(again.degraded, true);
});

test('an error status is treated as no answer, not as an empty answer', async (t) => {
  const mod = await loadWith({ caseId: 'fetch-500' });
  stubFetch(t, async () => ({ ok: false, status: 503, json: async () => ({}) }));

  const config = await mod.fetchIceConfig();
  assert.equal(config.degraded, true);
  assert.equal(config.hasTurn, false);
});

test('a server with no TURN configured still returns usable STUN', async (t) => {
  const mod = await loadWith({ caseId: 'fetch-no-turn' });
  stubFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ iceServers: [], hasTurn: false }),
  }));

  const config = await mod.fetchIceConfig();
  assert.equal(config.hasTurn, false);
  // Reached the server, so not degraded — but the list must not be empty, or
  // there is no candidate gathering at all.
  assert.equal(config.degraded, false);
  assert.deepEqual(config.iceServers, mod.FALLBACK_ICE_SERVERS);
});

test('an aborted request propagates instead of poisoning the cache', async (t) => {
  const mod = await loadWith({ caseId: 'fetch-abort' });
  stubFetch(t, async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });

  await assert.rejects(() => mod.fetchIceConfig(), { name: 'AbortError' });
});
