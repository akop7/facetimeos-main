/**
 * Where the desktop shell points, and which OAuth client it uses.
 *
 * Three layers, most specific first: environment variables (handy for `npm
 * start` against a dev server), then a `settings.json` in the OS user-data
 * directory, then nothing — in which case the app shows its setup screen rather
 * than a blank window or a hardcoded URL that only works for one person.
 *
 * Electron-free on purpose so the tests can drive it with a temp directory;
 * `main.js` passes `app.getPath('userData')`.
 */

import fs from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE = 'settings.json';

/**
 * Only http(s), and no credentials embedded in the URL. This value ends up as
 * the origin whose pages get the sign-in bridge and camera access, so a
 * `file://` or `javascript:` value here would be a real hole rather than a typo.
 */
export function normalizeAppUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // A bare host is the common way to type this; keep the path if one was given.
  return url.toString().replace(/\/$/, '') || null;
}

function readSettings(userDataDir) {
  try {
    const file = path.join(userDataDir, SETTINGS_FILE);
    return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    // Missing is the first-run case; corrupt is not worth crashing over, since
    // the setup screen can rewrite it.
    return {};
  }
}

/**
 * Merge into `settings.json`, creating it if needed.
 *
 * Keys whose value is `undefined` are dropped rather than written, so a setup
 * screen that leaves a field blank keeps whatever was already stored instead of
 * silently erasing it. Pass `null` to clear a value on purpose.
 */
export function saveSettings(userDataDir, patch) {
  const given = Object.entries(patch ?? {}).filter(([, value]) => value !== undefined);
  const merged = { ...readSettings(userDataDir), ...Object.fromEntries(given) };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, SETTINGS_FILE), `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

export function loadConfig(userDataDir, env = process.env) {
  const stored = readSettings(userDataDir);
  const appUrl =
    normalizeAppUrl(env.FACETIMEOS_APP_URL) || normalizeAppUrl(stored.appUrl) || null;

  return {
    appUrl,
    /** The origin that gets the sign-in bridge and media permissions. */
    origin: appUrl ? new URL(appUrl).origin : null,
    google: {
      clientId: env.FACETIMEOS_GOOGLE_CLIENT_ID || stored.googleClientId || null,
      clientSecret: env.FACETIMEOS_GOOGLE_CLIENT_SECRET || stored.googleClientSecret || null,
    },
    /** Where the value came from, so the setup screen can say so. */
    fromEnv: Boolean(normalizeAppUrl(env.FACETIMEOS_APP_URL)),
  };
}
