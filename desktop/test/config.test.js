/**
 * The settings layer, driven with temp directories.
 *
 * `loadConfig` takes its environment as an argument precisely so this can stage
 * several without spawning processes — the server's `config.js` reads
 * `process.env` at import time and needed a spawn per case, and that was worth
 * not repeating here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS_FILE, loadConfig, normalizeAppUrl, saveSettings } from '../src/config.js';

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftos-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a bare host, a trailing slash and a path all normalize', () => {
  assert.equal(normalizeAppUrl('https://facetimeos.vercel.app'), 'https://facetimeos.vercel.app');
  assert.equal(normalizeAppUrl('  https://facetimeos.vercel.app/  '), 'https://facetimeos.vercel.app');
  assert.equal(normalizeAppUrl('http://localhost:3000'), 'http://localhost:3000');
  // A path is kept: someone may host the app under a prefix.
  assert.equal(normalizeAppUrl('https://example.com/call'), 'https://example.com/call');
});

test('anything that is not http(s) is refused', () => {
  // This value becomes the origin that gets the camera and the sign-in bridge, so
  // these are holes rather than typos.
  for (const bad of ['', '   ', 'not a url', 'file:///C:/Windows', 'javascript:alert(1)', 'ftp://x.example']) {
    assert.equal(normalizeAppUrl(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeAppUrl(null), null);
  assert.equal(normalizeAppUrl(undefined), null);
});

test('credentials embedded in the URL are refused', () => {
  assert.equal(normalizeAppUrl('https://user:pass@example.com'), null);
  assert.equal(normalizeAppUrl('https://user@example.com'), null);
});

test('first run has no URL, so the caller can show setup instead of a blank window', (t) => {
  const dir = tempDir(t);
  const config = loadConfig(dir, {});
  assert.equal(config.appUrl, null);
  assert.equal(config.origin, null);
  assert.equal(config.google.clientId, null);
  assert.equal(config.fromEnv, false);
});

test('saved settings come back, with the origin derived from them', (t) => {
  const dir = tempDir(t);
  saveSettings(dir, { appUrl: 'https://facetimeos.vercel.app/call', googleClientId: 'abc.apps' });
  const config = loadConfig(dir, {});
  assert.equal(config.appUrl, 'https://facetimeos.vercel.app/call');
  // The origin is what permission checks compare against — path excluded.
  assert.equal(config.origin, 'https://facetimeos.vercel.app');
  assert.equal(config.google.clientId, 'abc.apps');
});

test('the environment wins over the file, and says so', (t) => {
  const dir = tempDir(t);
  saveSettings(dir, { appUrl: 'https://saved.example' });
  const config = loadConfig(dir, { FACETIMEOS_APP_URL: 'http://localhost:3000' });
  assert.equal(config.appUrl, 'http://localhost:3000');
  // The setup screen uses this to explain why editing the field looks ineffective.
  assert.equal(config.fromEnv, true);
});

test('a junk value in the environment falls through to the saved one', (t) => {
  const dir = tempDir(t);
  saveSettings(dir, { appUrl: 'https://saved.example' });
  const config = loadConfig(dir, { FACETIMEOS_APP_URL: 'nonsense' });
  assert.equal(config.appUrl, 'https://saved.example');
  assert.equal(config.fromEnv, false);
});

test('a blank field keeps the stored secret rather than erasing it', (t) => {
  const dir = tempDir(t);
  saveSettings(dir, { appUrl: 'https://a.example', googleClientSecret: 'kept' });
  // What the setup screen sends when the user edits only the URL.
  saveSettings(dir, { appUrl: 'https://b.example', googleClientSecret: undefined });
  const config = loadConfig(dir, {});
  assert.equal(config.appUrl, 'https://b.example');
  assert.equal(config.google.clientSecret, 'kept');
});

test('a corrupt settings file is treated as first run, not a crash', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), '{ this is not json');
  const config = loadConfig(dir, {});
  assert.equal(config.appUrl, null);
  // And it can be rewritten from the setup screen.
  saveSettings(dir, { appUrl: 'https://recovered.example' });
  assert.equal(loadConfig(dir, {}).appUrl, 'https://recovered.example');
});

test('saving creates the directory when the app has never written there', (t) => {
  const dir = path.join(tempDir(t), 'nested', 'userData');
  saveSettings(dir, { appUrl: 'https://a.example' });
  assert.equal(loadConfig(dir, {}).appUrl, 'https://a.example');
});
