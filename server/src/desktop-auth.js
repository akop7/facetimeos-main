import { Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { firebaseAdminConfigured, firebaseAuth } from './firebase-admin.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
const validSecret = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(value);
const equal = (a, b) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createDesktopAuthBroker({
  now = Date.now,
  verify = async token => (await firebaseAuth()).verifyIdToken(token, true),
  mint = async uid => (await firebaseAuth()).createCustomToken(uid),
  enabled = firebaseAdminConfigured,
  ttlMs = 300_000,
  capacity = 500,
} = {}) {
  const requests = new Map();
  const buckets = new Map();
  function prune() {
    for (const [id, entry] of requests) if (entry.expires <= now()) requests.delete(id);
    for (const [ip, bucket] of buckets) if (bucket.expires <= now()) buckets.delete(ip);
  }
  function find(id) {
    prune();
    const entry = typeof id === 'string' ? requests.get(id) : null;
    if (!entry) throw failure(410, 'This sign-in request expired. Start again from the Windows app.');
    return entry;
  }
  return {
    start(challenge, ip = 'unknown') {
      if (!enabled()) throw failure(503, 'Desktop Google sign-in needs Firebase Admin on Render. Follow WINDOWS-SETUP.md, or use email sign-in.');
      if (!validSecret(challenge)) throw failure(400, 'Invalid sign-in challenge.');
      prune();
      const bucket = buckets.get(ip) || { count: 0, expires: now() + 60_000 };
      if (bucket.count >= 10 || requests.size >= capacity || buckets.size >= 2000) throw failure(429, 'Too many sign-in requests. Please wait a minute.');
      bucket.count++; buckets.set(ip, bucket);
      const requestId = randomBytes(32).toString('base64url');
      const rawCode = randomBytes(4).toString('hex').toUpperCase();
      const code = rawCode.slice(0, 4) + '-' + rawCode.slice(4);
      requests.set(requestId, { challenge, code, expires: now() + ttlMs, uid: null, issuing: false });
      return { requestId, code, expiresIn: Math.floor(ttlMs / 1000) };
    },
    info(id) { const entry = find(id); return { code: entry.code, expiresAt: entry.expires }; },
    async complete(id, token, code) {
      const entry = find(id);
      if (entry.uid || entry.issuing) throw failure(409, 'This request has already been approved.');
      if (typeof code !== 'string' || !equal(code, entry.code)) throw failure(400, 'Verification code does not match.');
      if (typeof token !== 'string' || token.length > 16_000) throw failure(401, 'Sign in with Google first.');
      let claims;
      try { claims = await verify(token); } catch { throw failure(401, 'Google sign-in could not be verified. Please sign in again.'); }
      if (!claims.uid || claims.firebase?.sign_in_provider !== 'google.com') throw failure(401, 'Use Google sign-in to approve this Windows app request.');
      if (find(id) !== entry || entry.uid) throw failure(409, 'This request is no longer available.');
      entry.uid = claims.uid;
      return { ok: true };
    },
    async exchange(id, verifier) {
      const entry = find(id);
      if (!validSecret(verifier) || !equal(createHash('sha256').update(verifier).digest('base64url'), entry.challenge)) throw failure(403, 'Invalid sign-in verifier.');
      if (!entry.uid || entry.issuing) return { pending: true };
      entry.issuing = true;
      try {
        const customToken = await mint(entry.uid);
        requests.delete(id);
        return { customToken };
      } catch { entry.issuing = false; throw failure(503, 'Could not finish sign-in. Check the Firebase Admin configuration on Render.'); }
    },
  };
}

export function desktopAuthRouter() {
  const router = Router(); const broker = createDesktopAuthBroker();
  const run = fn => (req, res) => Promise.resolve().then(() => fn(req)).then(data => res.json(data)).catch(err => res.status(err.status || 500).json({ error: 'desktop-auth', message: err.status ? err.message : 'Sign-in failed.' }));
  router.post('/start', run(req => broker.start(req.body?.challenge, req.ip)));
  router.get('/:requestId', run(req => broker.info(req.params.requestId)));
  router.post('/complete', run(req => broker.complete(req.body?.requestId, (req.headers.authorization || '').replace(/^Bearer /i, ''), req.body?.code)));
  router.post('/exchange', run(req => broker.exchange(req.body?.requestId, req.body?.verifier)));
  return router;
}
