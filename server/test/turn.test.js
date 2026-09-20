import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TURN configuration, tested through `/rtc/ice`.
 *
 * It is tested from the outside rather than by importing `buildIceConfig`
 * because `config.js` reads `process.env` once at import time: a unit test
 * cannot stage a second environment in the same process, and the first import
 * would decide the answer for every case after it. Spawning the real server per
 * environment is what `http.test.js` already does, and it has the side benefit
 * of covering the route's async plumbing.
 *
 * The Metered cases point `METERED_API_BASE` at a local stub, so nothing here
 * touches the network or needs an account.
 */

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** What Metered's GET /api/v1/turn/credentials actually returns. */
const METERED_RESPONSE = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:standard.relay.metered.ca:80', username: 'mu', credential: 'mp' },
  { urls: 'turn:standard.relay.metered.ca:80?transport=tcp', username: 'mu', credential: 'mp' },
  { urls: 'turn:standard.relay.metered.ca:443', username: 'mu', credential: 'mp' },
  { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username: 'mu', credential: 'mp' },
];

/**
 * A stand-in for Metered's API that records what it was asked for, so the cache
 * can be observed rather than inferred.
 */
async function startStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(new URL(req.url, 'http://stub'));
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const okStub = () =>
  startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(METERED_RESPONSE));
  });

/** Boots the real server on an ephemeral port with `env` layered on top. */
async function startServer(t, port, env) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      JWT_SECRET: 'test-secret-that-is-definitely-long-enough-32',
      CLIENT_ORIGIN: '',
      DOC_STORE_ENABLED: 'false',
      // Inherited values would otherwise decide these cases for us.
      TURN_URLS: '',
      TURN_SECRET: '',
      TURN_USERNAME: '',
      TURN_PASSWORD: '',
      METERED_APP_NAME: '',
      METERED_API_KEY: '',
      METERED_API_BASE: '',
      METERED_REGION: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  t.after(async () => {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  });

  const base = `http://127.0.0.1:${port}/rtc`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 120));
  }

  return { base, ice: async () => (await fetch(`${base}/ice`)).json(), bootLog: () => log };
}

const relays = (config) =>
  config.iceServers.filter((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => /^turns?:/i.test(u));
  });

test('with no relay configured, /ice is STUN-only and says so', async (t) => {
  const server = await startServer(t, 34210, {});
  const config = await server.ice();

  assert.equal(config.hasTurn, false);
  assert.equal(relays(config).length, 0);
  assert.ok(config.iceServers.length > 0, 'STUN list is never empty');
  assert.ok(config.iceServers.every((s) => /^stun:/i.test(s.urls)));
  // No relay means no point offering the "force relay" privacy toggle, and a
  // short TTL so a client re-checks soon after one is configured.
  assert.deepEqual(config.iceTransportPolicyOptions, ['all']);
  assert.equal(config.ttlSeconds, 300);
  assert.match(server.bootLog(), /TURN relay: NOT configured/);
});

test('metered credentials are fetched, filtered to relays, and merged with STUN', async (t) => {
  const stub = await okStub();
  t.after(() => stub.close());

  const server = await startServer(t, 34211, {
    METERED_APP_NAME: 'ftos-test',
    METERED_API_KEY: 'credential-key',
    METERED_API_BASE: stub.base,
  });

  const config = await server.ice();

  assert.equal(config.hasTurn, true);
  assert.deepEqual(config.iceTransportPolicyOptions, ['all', 'relay']);

  // Four relay entries in, four out — and Metered's own STUN entry dropped,
  // since this server already ships a STUN list.
  const turns = relays(config);
  assert.equal(turns.length, 4);
  assert.ok(turns.every((s) => s.username === 'mu' && s.credential === 'mp'));
  assert.ok(config.iceServers.some((s) => /^stun:/i.test(s.urls)));
  assert.ok(
    !config.iceServers.some((s) => String(s.urls).includes('stun.relay.metered.ca')),
    "Metered's STUN entry should be filtered out"
  );

  // The API key travels as a query parameter, and only to the provider.
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].pathname, '/api/v1/turn/credentials');
  assert.equal(stub.requests[0].searchParams.get('apiKey'), 'credential-key');
  assert.equal(stub.requests[0].searchParams.get('region'), null);
  assert.match(server.bootLog(), /TURN relay: metered \(default region\)/);
});

test('the credential list is cached, so a busy room is not one lookup per join', async (t) => {
  const stub = await okStub();
  t.after(() => stub.close());

  const server = await startServer(t, 34212, {
    METERED_APP_NAME: 'ftos-test',
    METERED_API_KEY: 'k',
    METERED_API_BASE: stub.base,
    METERED_CACHE_SECONDS: '600',
  });

  const first = await server.ice();
  const second = await server.ice();
  const third = await server.ice();

  assert.equal(stub.requests.length, 1, 'three joins, one outbound request');
  assert.deepEqual(second.iceServers, first.iceServers);
  assert.deepEqual(third.iceServers, first.iceServers);
});

test('a region is forwarded when one is configured', async (t) => {
  const stub = await okStub();
  t.after(() => stub.close());

  const server = await startServer(t, 34213, {
    METERED_APP_NAME: 'ftos-test',
    METERED_API_KEY: 'k',
    METERED_API_BASE: stub.base,
    METERED_REGION: 'europe',
  });

  await server.ice();
  assert.equal(stub.requests[0].searchParams.get('region'), 'europe');
  assert.match(server.bootLog(), /metered \(europe\)/);
});

test('a provider outage degrades to STUN instead of failing the join', async (t) => {
  const stub = await startStub((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  t.after(() => stub.close());

  const server = await startServer(t, 34214, {
    METERED_APP_NAME: 'ftos-test',
    METERED_API_KEY: 'wrong',
    METERED_API_BASE: stub.base,
  });

  const res = await fetch(`${server.base}/ice`);
  assert.equal(res.status, 200, 'the call still gets an answer');

  const config = await res.json();
  assert.equal(config.hasTurn, false);
  assert.equal(relays(config).length, 0);
  assert.ok(config.iceServers.length > 0);

  // A failed lookup is not cached, so a fixed key takes effect on the next join.
  await server.ice();
  assert.equal(stub.requests.length, 2);
});

test('a response with no usable relay entries counts as a failure, not as TURN', async (t) => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Shaped like a real response, but every relay lacks credentials.
    res.end(
      JSON.stringify([
        { urls: 'stun:stun.relay.metered.ca:80' },
        { urls: 'turn:standard.relay.metered.ca:80' },
      ])
    );
  });
  t.after(() => stub.close());

  const server = await startServer(t, 34215, {
    METERED_APP_NAME: 'ftos-test',
    METERED_API_KEY: 'k',
    METERED_API_BASE: stub.base,
  });

  const config = await server.ice();
  assert.equal(config.hasTurn, false);
  assert.equal(relays(config).length, 0);
});

test('self-hosted coturn still mints HMAC credentials, and both sources can coexist', async (t) => {
  const stub = await okStub();
  t.after(() => stub.close());

  const server = await startServer(t, 34216, {
    TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp',
    TURN_SECRET: 'coturn-static-auth-secret',
    TURN_TTL_SECONDS: '3600',
    METERED_APP_NAME: 'ftos-test',
    METERED_API_KEY: 'k',
    METERED_API_BASE: stub.base,
  });

  const config = await server.ice();
  assert.equal(config.hasTurn, true);
  assert.equal(config.ttlSeconds, 3600);

  const own = relays(config).find((s) => String(s.urls).includes('turn.example.com'));
  assert.ok(own, 'the self-hosted relay is present');
  assert.deepEqual(own.urls, [
    'turn:turn.example.com:3478?transport=udp',
    'turns:turn.example.com:5349?transport=tcp',
  ]);

  // username = "<unix-expiry>:<identity>", and the identity is `anon` without a
  // session token. The expiry must be in the future or coturn rejects it.
  const [expiry, identity] = own.username.split(':');
  assert.equal(identity, 'anon');
  const secondsOut = Number(expiry) - Math.floor(Date.now() / 1000);
  assert.ok(secondsOut > 3400 && secondsOut <= 3600, `expiry ${secondsOut}s out of range`);
  assert.match(own.credential, /^[A-Za-z0-9+/]+={0,2}$/, 'base64 HMAC');

  assert.ok(
    relays(config).some((s) => String(s.urls).includes('metered.ca')),
    'the hosted relay is present too'
  );
  assert.match(server.bootLog(), /TURN relay: self-hosted \(HMAC\) \+ metered/);
});

test('static credentials work for a relay with no REST API', async (t) => {
  const server = await startServer(t, 34217, {
    TURN_URLS: 'turn:standard.relay.metered.ca:443',
    TURN_USERNAME: 'dashboard-user',
    TURN_PASSWORD: 'dashboard-pass',
  });

  const config = await server.ice();
  assert.equal(config.hasTurn, true);

  const [relay] = relays(config);
  assert.equal(relay.username, 'dashboard-user');
  assert.equal(relay.credential, 'dashboard-pass');
  assert.match(server.bootLog(), /TURN relay: self-hosted \(static\)/);
});

test('URLs without credentials are refused rather than shipped half-configured', async (t) => {
  const server = await startServer(t, 34218, {
    TURN_URLS: 'turn:turn.example.com:3478',
  });

  const config = await server.ice();
  assert.equal(config.hasTurn, false, 'a relay nobody can authenticate against is not a relay');
  assert.equal(relays(config).length, 0);
  assert.match(server.bootLog(), /TURN_URLS is set but neither/);
});
