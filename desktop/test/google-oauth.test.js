/**
 * The sign-in flow, end to end, without Google and without a display.
 *
 * `signInWithGoogle` takes `openExternal`, `fetchImpl` and `tokenEndpoint` as
 * arguments for exactly this: the loopback server here is the real one, the
 * authorize URL is the real one, and the only things replaced are the browser
 * (a `fetch` to the redirect URI) and Google's token endpoint (a local stub).
 *
 * Which means the parts that are easy to get wrong and impossible to eyeball —
 * state matching, PKCE, the redirect URI travelling identically through both
 * requests — are actually exercised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  signInWithGoogle,
  startLoopback,
} from '../src/google-oauth.js';

/** A stand-in for Google's token endpoint. Records what it was sent. */
function startTokenStub(t, respond) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ params, contentType: req.headers['content-type'] });
      const { status, payload } = respond(params);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({ url: `http://127.0.0.1:${server.address().port}/token`, calls });
    });
  });
}

const idToken = (sub = 'user-1') =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(
    JSON.stringify({ sub, email: 'a@example.com' })
  ).toString('base64url')}.sig`;

test('PKCE pairs are random and the challenge is the S256 of the verifier', () => {
  const a = createPkcePair();
  const b = createPkcePair();
  assert.notEqual(a.verifier, b.verifier);
  // base64url: no padding, no + or /, or Google rejects the request outright.
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    a.challenge,
    crypto.createHash('sha256').update(a.verifier).digest('base64url')
  );
});

test('the authorize URL carries what a native app has to send', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: 'cid.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:5555',
      challenge: 'chal',
      state: 'st',
    })
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'chal');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555');
  // `openid` is what makes the response include an id_token at all.
  assert.deepEqual(url.searchParams.get('scope').split(' '), ['openid', 'email', 'profile']);
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.has('login_hint'), false);
});

test('a missing client id fails before a browser is opened', () => {
  assert.throws(() => buildAuthorizeUrl({ redirectUri: 'http://127.0.0.1:1', challenge: 'c', state: 's' }));
});

test('the loopback listens on 127.0.0.1 with an OS-assigned port', async () => {
  const loopback = await startLoopback({ state: 'st' });
  // Google matches loopback redirect URIs by address and ignores the port, which
  // is what makes port 0 usable without registering anything.
  assert.match(loopback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+$/);
  loopback.close();
  await assert.rejects(loopback.code);
});

test('a matching redirect yields the code and a page saying so', async () => {
  const loopback = await startLoopback({ state: 'st' });
  const res = await fetch(`${loopback.redirectUri}/?code=abc123&state=st`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /You are signed in/);
  assert.equal(await loopback.code, 'abc123');
  loopback.close();
});

test('a mismatched state is ignored rather than trusted', async () => {
  const loopback = await startLoopback({ state: 'st' });
  const res = await fetch(`${loopback.redirectUri}/?code=abc123&state=someone-elses`);
  assert.match(await res.text(), /ignored/i);
  await assert.rejects(loopback.code, /state did not match/);
  loopback.close();
});

test('a cancelled sign-in reports cancellation, not a generic failure', async () => {
  const loopback = await startLoopback({ state: 'st' });
  await fetch(`${loopback.redirectUri}/?error=access_denied&state=st`);
  await assert.rejects(loopback.code, /cancelled/i);
  loopback.close();
});

test('a redirect with no code at all is an error, not a hang', async () => {
  const loopback = await startLoopback({ state: 'st' });
  await fetch(`${loopback.redirectUri}/?state=st`);
  await assert.rejects(loopback.code, /without an authorization code/);
  loopback.close();
});

test('paths other than the redirect path are 404, not accepted', async () => {
  const loopback = await startLoopback({ state: 'st' });
  const res = await fetch(`${loopback.redirectUri}/favicon.ico?code=abc&state=st`);
  assert.equal(res.status, 404);
  loopback.close();
});

test('the code exchange sends the verifier, and the secret only when configured', async (t) => {
  const stub = await startTokenStub(t, () => ({
    status: 200,
    payload: { id_token: idToken(), access_token: 'at' },
  }));

  const withSecret = await exchangeCode({
    clientId: 'cid',
    clientSecret: 'shh',
    code: 'code-1',
    verifier: 'ver-1',
    redirectUri: 'http://127.0.0.1:5555',
    tokenEndpoint: stub.url,
  });
  assert.equal(withSecret.idToken, idToken());
  assert.equal(withSecret.accessToken, 'at');

  await exchangeCode({
    clientId: 'cid',
    code: 'code-2',
    verifier: 'ver-2',
    redirectUri: 'http://127.0.0.1:5555',
    tokenEndpoint: stub.url,
  });

  assert.equal(stub.calls[0].contentType, 'application/x-www-form-urlencoded');
  assert.equal(stub.calls[0].params.grant_type, 'authorization_code');
  assert.equal(stub.calls[0].params.code_verifier, 'ver-1');
  assert.equal(stub.calls[0].params.client_secret, 'shh');
  // PKCE is what secures this, so an unset secret must simply be absent rather
  // than sent as an empty string — Google rejects the latter.
  assert.equal('client_secret' in stub.calls[1].params, false);
});

test("Google's own error text is surfaced, because the fixes differ", async (t) => {
  const stub = await startTokenStub(t, () => ({
    status: 400,
    payload: { error: 'invalid_grant', error_description: 'Bad Request' },
  }));
  await assert.rejects(
    exchangeCode({ clientId: 'cid', code: 'c', verifier: 'v', redirectUri: 'r', tokenEndpoint: stub.url }),
    /Bad Request/
  );
});

test('a 200 with no id_token is refused rather than returned as undefined', async (t) => {
  const stub = await startTokenStub(t, () => ({ status: 200, payload: { access_token: 'at' } }));
  await assert.rejects(
    exchangeCode({ clientId: 'cid', code: 'c', verifier: 'v', redirectUri: 'r', tokenEndpoint: stub.url }),
    /no ID token/
  );
});

test('the whole flow: browser redirect in, ID token out', async (t) => {
  const stub = await startTokenStub(t, (params) => {
    // Assert inside the stub: the verifier must match the challenge the authorize
    // request carried, and the redirect URI must be byte-identical in both legs.
    const expected = crypto.createHash('sha256').update(params.code_verifier).digest('base64url');
    assert.equal(expected, seen.challenge);
    assert.equal(params.redirect_uri, seen.redirectUri);
    assert.equal(params.code, 'code-from-google');
    return { status: 200, payload: { id_token: idToken('desktop-user') } };
  });

  const seen = {};
  const result = await signInWithGoogle({
    clientId: 'cid.apps.googleusercontent.com',
    tokenEndpoint: stub.url,
    // Stands in for the system browser: read the authorize URL, then call back.
    openExternal: async (url) => {
      const parsed = new URL(url);
      seen.challenge = parsed.searchParams.get('code_challenge');
      seen.redirectUri = parsed.searchParams.get('redirect_uri');
      const back = new URL(seen.redirectUri);
      back.searchParams.set('code', 'code-from-google');
      back.searchParams.set('state', parsed.searchParams.get('state'));
      await fetch(back);
    },
  });

  assert.equal(result.idToken, idToken('desktop-user'));
});

test('a browser that never opens fails the sign-in instead of hanging', async () => {
  await assert.rejects(
    signInWithGoogle({
      clientId: 'cid',
      openExternal: () => {
        throw new Error('no browser');
      },
    }),
    /no browser/
  );
});

test('the loopback closes even when the exchange fails, so ports are not leaked', async (t) => {
  const stub = await startTokenStub(t, () => ({ status: 400, payload: { error: 'invalid_client' } }));
  let redirectUri = null;

  await assert.rejects(
    signInWithGoogle({
      clientId: 'cid',
      tokenEndpoint: stub.url,
      openExternal: async (url) => {
        const parsed = new URL(url);
        redirectUri = parsed.searchParams.get('redirect_uri');
        const back = new URL(redirectUri);
        back.searchParams.set('code', 'c');
        back.searchParams.set('state', parsed.searchParams.get('state'));
        await fetch(back);
      },
    }),
    /invalid_client/
  );

  await assert.rejects(fetch(`${redirectUri}/?code=again&state=x`), /fetch failed/);
});
