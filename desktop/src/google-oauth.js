/**
 * Google sign-in for a desktop app, done the way Google requires.
 *
 * `signInWithPopup` — what the web app uses — cannot work here. Google refuses
 * OAuth inside an embedded user agent (`disallowed_useragent`), and an Electron
 * window is exactly that. Spoofing the user-agent string does work today and is
 * both against Google's policy and one Chromium bump away from breaking, so this
 * takes the sanctioned route instead: the authorization code flow with PKCE,
 * carried out in the user's real browser, with the response caught on a loopback
 * server this process opens (RFC 8252, "OAuth 2.0 for Native Apps").
 *
 * What comes back is a Google ID token. The renderer hands that to Firebase as a
 * credential, so the signed-in user is the same user with the same uid as in the
 * browser — no second identity, no Admin SDK, no server involvement.
 *
 * Deliberately free of Electron imports: everything here is plain Node, which is
 * what lets `test/google-oauth.test.js` drive the whole flow against a stub
 * without a display or a Google account.
 */

import crypto from 'node:crypto';
import http from 'node:http';

const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** `openid` is what makes the token response include an `id_token`. */
const SCOPES = ['openid', 'email', 'profile'];

/**
 * PKCE. The verifier never leaves this process; only its SHA-256 hash travels
 * with the authorization request, so a code intercepted from the loopback
 * redirect is useless to anyone who does not hold the verifier. That matters
 * more here than on the web: every other process on the machine can also listen
 * on localhost.
 */
export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl({ clientId, redirectUri, challenge, state, loginHint = null }) {
  if (!clientId) throw new Error('A Google OAuth client ID is required.');
  const url = new URL(AUTHORIZE_ENDPOINT);
  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // The browser's default account is often not the one you want in the app.
    prompt: 'select_account',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

/** The page the browser tab is left showing. Plain, and it says what happened. */
function resultPage(heading, detail) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>FaceTimeOS</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
         background:#0b0b0f; color:#f4f4f5 }
  main { max-width:26rem; padding:2rem; text-align:center }
  h1 { font-size:1.15rem; margin:0 0 .5rem }
  p { margin:0; opacity:.7; font-size:.9rem }
</style></head>
<body><main><h1>${heading}</h1><p>${detail}</p></main></body></html>`;
}

/**
 * A one-shot HTTP server on 127.0.0.1 that waits for Google to redirect back.
 *
 * Port 0, i.e. whatever is free. Google allows this: for loopback redirect URIs
 * it matches the address but ignores the port, so nothing has to be registered
 * in the console per port and two instances cannot collide.
 */
export function startLoopback({ state, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolveServer, rejectServer) => {
    let settle = null;
    const code = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    // A caller that closes the loopback without awaiting this — because opening the
    // browser failed, or because it only wanted the port — would otherwise leave
    // the rejection unhandled and, under `node --test`, fail an unrelated case.
    // A no-op handler here does not stop a real awaiter from seeing the result.
    code.catch(() => {});

    const finish = (fn, value, page) => {
      if (!settle) return page;
      const done = settle;
      settle = null;
      clearTimeout(timer);
      // Let the response flush before the socket goes away with the server.
      setTimeout(() => done[fn](value), 50);
      return page;
    };

    const timer = setTimeout(() => {
      finish('reject', new Error('Sign-in timed out — the browser never came back.'));
      server.close();
    }, timeoutMs);
    timer.unref?.();

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }

      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const authCode = url.searchParams.get('code');

      let page;
      if (error) {
        page = finish(
          'reject',
          new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google returned "${error}".`),
          resultPage('Sign-in cancelled', 'You can close this tab and try again in the app.')
        );
      } else if (returnedState !== state) {
        // Someone else's redirect, or a tampered one. Not our flow.
        page = finish(
          'reject',
          new Error('Sign-in state did not match — the response was ignored.'),
          resultPage('That response was ignored', 'It did not match the request this app made.')
        );
      } else if (!authCode) {
        page = finish(
          'reject',
          new Error('Google redirected back without an authorization code.'),
          resultPage('Something went wrong', 'No authorization code came back. Try again in the app.')
        );
      } else {
        page = finish(
          'resolve',
          authCode,
          resultPage('You are signed in', 'You can close this tab and go back to FaceTimeOS.')
        );
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    });

    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({
        redirectUri: `http://127.0.0.1:${port}`,
        code,
        close: () => {
          clearTimeout(timer);
          finish('reject', new Error('Sign-in was closed before it finished.'));
          server.close();
        },
      });
    });
  });
}

/**
 * Swap the authorization code for tokens.
 *
 * `client_secret` is included when configured, because Google's own docs require
 * it for "Desktop app" clients — and also state plainly that the secret in an
 * installed app is not treated as confidential. PKCE is what actually secures
 * this exchange, which is why the verifier is mandatory here and the secret is
 * not.
 */
export async function exchangeCode({
  clientId,
  clientSecret = null,
  code,
  verifier,
  redirectUri,
  fetchImpl = fetch,
  tokenEndpoint = TOKEN_ENDPOINT,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    // Google's error bodies are genuinely useful — surface them rather than a
    // status code, because "invalid_client" and "redirect_uri_mismatch" call for
    // completely different fixes in the console.
    const detail = payload?.error_description || payload?.error || `HTTP ${res.status}`;
    throw new Error(`Google rejected the sign-in: ${detail}`);
  }
  if (!payload?.id_token) {
    throw new Error('Google returned no ID token — check that the "openid" scope is allowed.');
  }
  return { idToken: payload.id_token, accessToken: payload.access_token ?? null };
}

/**
 * The whole flow: open the browser, wait, exchange, return an ID token.
 *
 * `openExternal` is injected rather than imported so this module stays testable
 * and Electron-free; `main.js` passes `shell.openExternal`.
 */
export async function signInWithGoogle({
  clientId,
  clientSecret = null,
  openExternal,
  timeoutMs,
  fetchImpl = fetch,
  tokenEndpoint = TOKEN_ENDPOINT,
  authorizeUrlFor = buildAuthorizeUrl,
}) {
  if (!clientId) throw new Error('No Google OAuth client ID is configured.');

  const { verifier, challenge } = createPkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  const loopback = await startLoopback({ state, timeoutMs });

  try {
    await openExternal(
      authorizeUrlFor({ clientId, redirectUri: loopback.redirectUri, challenge, state })
    );
    const code = await loopback.code;
    return await exchangeCode({
      clientId,
      clientSecret,
      code,
      verifier,
      redirectUri: loopback.redirectUri,
      fetchImpl,
      tokenEndpoint,
    });
  } finally {
    loopback.close();
  }
}
