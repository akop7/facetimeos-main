/**
 * Launches the real shell twice and checks what it loaded, then exits.
 *
 * `node --test` covers the OAuth flow and the config layering, but neither says
 * anything about whether Electron actually boots, whether the preload lands, or
 * whether a remote origin is reachable through the navigation policy. Those only
 * fail when the app runs — so this runs it.
 *
 * Both cases use a throwaway `--user-data-dir`, so a developer's saved settings
 * cannot make this pass or fail. Case two serves its own page on 127.0.0.1, which
 * means no network and no deployment is needed.
 *
 * `npm run smoke`. Exits non-zero on the first failure.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

const DESKTOP_DIR = path.join(import.meta.dirname, '..');
const TIMEOUT_MS = 90_000;

/** Electron on CI/headless Windows agents needs no flags; a display does exist here. */
function runShell({ env, userDataDir }) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, ['.', `--user-data-dir=${userDataDir}`], {
      cwd: DESKTOP_DIR,
      env: { ...process.env, FACETIMEOS_SMOKE: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    const collect = (chunk) => {
      out += chunk;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the app did not exit within ${TIMEOUT_MS / 1000}s\n${out}`));
    }, TIMEOUT_MS);

    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const failures = [];

function expect(label, condition, detail) {
  if (condition) {
    console.log(`✓ ${label}`);
    return;
  }
  console.log(`✗ ${label}`);
  failures.push(`${label}\n${detail}`);
}

/** A stand-in for the deployment: one page, on a port nobody registered. */
function startStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><title>stub</title><h1>stub app</h1>');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ftos-smoke-'));

try {
  // 1. Nothing configured: the shell must show its own setup page rather than a
  //    blank window, and the local bridge must be there for it to use.
  const first = await runShell({
    userDataDir: path.join(tmp, 'a'),
    env: { FACETIMEOS_APP_URL: '', FACETIMEOS_GOOGLE_CLIENT_ID: '' },
  });
  expect('unconfigured launch exits cleanly', first.code === 0, first.out);
  expect('unconfigured launch opens the setup page', /\[smoke\] loaded file:.*setup\.html/.test(first.out), first.out);
  expect(
    'preload exposes both bridges',
    /\[smoke\] bridge \{"desktop":true,"shell":true\}/.test(first.out),
    first.out
  );

  // 2. Configured: it must navigate to that origin, and the sign-in bridge must be
  //    reported as configured when a client id is present.
  const stub = await startStub();
  const second = await runShell({
    userDataDir: path.join(tmp, 'b'),
    env: { FACETIMEOS_APP_URL: stub.url, FACETIMEOS_GOOGLE_CLIENT_ID: 'smoke.apps.googleusercontent.com' },
  });
  stub.close();
  expect('configured launch exits cleanly', second.code === 0, second.out);
  expect(
    'configured launch loads the app URL',
    second.out.includes(`[smoke] loaded ${stub.url}`),
    second.out
  );
  expect('google client is picked up', second.out.includes('[smoke] googleClient configured'), second.out);

  // 3. A URL that refuses the connection must land on the shell's own error page —
  //    which offers retry and "change server URL" — not a Chromium error page.
  const third = await runShell({
    userDataDir: path.join(tmp, 'c'),
    // Nothing listens here, and it is outside Chromium's blocked-port list.
    env: { FACETIMEOS_APP_URL: 'http://127.0.0.1:45999' },
  });
  expect('unreachable launch exits cleanly', third.code === 0, third.out);
  expect(
    'an unreachable URL falls back to the error page',
    /\[smoke\] loaded file:.*unreachable\.html/.test(third.out),
    third.out
  );
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log('\nsmoke: the shell boots, shows setup, loads a configured URL, and falls back cleanly.');
