import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createDesktopAuthBroker } from '../src/desktop-auth.js';
const secret = () => randomBytes(32).toString('base64url');
const challenge = s => createHash('sha256').update(s).digest('base64url');
const options = { enabled: () => true, verify: async () => ({ uid: 'test-user', firebase: { sign_in_provider: 'google.com' } }), mint: async uid => `custom-for-${uid}` };

test('desktop exchange is pending until browser approval and can be used once', async () => {
  const broker = createDesktopAuthBroker(options); const verifier = secret();
  const { requestId, code } = broker.start(challenge(verifier));
  assert.deepEqual(await broker.exchange(requestId, verifier), { pending: true });
  assert.equal(broker.info(requestId).code, code);
  await broker.complete(requestId, 'firebase-id-token', code);
  assert.deepEqual(await broker.exchange(requestId, verifier), { customToken: 'custom-for-test-user' });
  await assert.rejects(broker.exchange(requestId, verifier), { status: 410 });
});
test('a stolen request id cannot redeem the login or invalidate the real verifier', async () => {
  const broker = createDesktopAuthBroker(options); const verifier = secret();
  const { requestId, code } = broker.start(challenge(verifier));
  await assert.rejects(broker.exchange(requestId, secret()), { status: 403 });
  await assert.rejects(broker.complete(requestId, 'token', 'BAD-CODE'), { status: 400 });
  await broker.complete(requestId, 'token', code);
  assert.equal((await broker.exchange(requestId, verifier)).customToken, 'custom-for-test-user');
});
test('expired and invalid requests fail closed', async () => {
  let time = 0;
  const broker = createDesktopAuthBroker({ ...options, now: () => time, ttlMs: 100 });
  assert.throws(() => broker.start('weak'), { status: 400 });
  const verifier = secret(); const { requestId } = broker.start(challenge(verifier));
  time = 101;
  assert.throws(() => broker.info(requestId), { status: 410 });
  await assert.rejects(broker.exchange(requestId, verifier), { status: 410 });
});
test('unverified tokens and non-Google approvals cannot grant desktop sessions', async () => {
  const broker = createDesktopAuthBroker({ ...options, verify: async () => { throw new Error('invalid'); } });
  const { requestId, code } = broker.start(challenge(secret()));
  await assert.rejects(broker.complete(requestId, 'invalid', code), { status: 401 });
  const password = createDesktopAuthBroker({ ...options, verify: async () => ({ uid: 'test', firebase: { sign_in_provider: 'password' } }) });
  const req = password.start(challenge(secret()));
  await assert.rejects(password.complete(req.requestId, 'token', req.code), { status: 401 });
});
test('parallel redemption never issues two tokens', async () => {
  let calls = 0;
  const broker = createDesktopAuthBroker({ ...options, mint: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return 'only-token'; } });
  const verifier = secret(); const { requestId, code } = broker.start(challenge(verifier));
  await broker.complete(requestId, 'valid', code);
  const results = await Promise.all([broker.exchange(requestId, verifier), broker.exchange(requestId, verifier)]);
  assert.equal(calls, 1); assert.equal(results.filter(r => r.customToken).length, 1);
});
test('requests are bounded and missing credentials give actionable errors', () => {
  const disabled = createDesktopAuthBroker({ enabled: () => false });
  assert.throws(() => disabled.start(challenge(secret())), { status: 503 });
  const broker = createDesktopAuthBroker({ ...options, capacity: 2 });
  broker.start(challenge(secret())); broker.start(challenge(secret()));
  assert.throws(() => broker.start(challenge(secret())), { status: 429 });
});
