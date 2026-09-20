import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const bool = (v, dflt = false) => {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
};
const int = (v, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Token signing secret. A missing secret used to silently fall back to the
 * string 'fallback-secret-for-dev-only', which would let anybody forge a host
 * token against a production deploy. Now: hard failure in production, random
 * per-boot secret in development.
 */
function resolveJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  if (IS_PRODUCTION) {
    throw new Error(
      'JWT_SECRET is required in production and must be at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
    );
  }

  if (fromEnv) {
    console.warn('[config] JWT_SECRET is shorter than 32 chars — using it anyway (dev only).');
    return fromEnv;
  }

  console.warn(
    '[config] JWT_SECRET is not set. Generating an ephemeral secret for this ' +
      'process — every restart will invalidate outstanding tokens. Set JWT_SECRET in server/.env.'
  );
  return crypto.randomBytes(48).toString('base64url');
}

export const JWT_SECRET = resolveJwtSecret();

export const PORT = int(process.env.PORT, 3001);

/**
 * `null` means "reflect the requesting origin". That is convenient for LAN and
 * tunnel testing but unacceptable in production, so production without an
 * explicit allowlist is a hard failure rather than a silent wildcard.
 */
export const CLIENT_ORIGINS = (() => {
  const origins = list(process.env.CLIENT_ORIGIN);
  if (origins.length > 0) return origins;
  if (IS_PRODUCTION) {
    throw new Error('CLIENT_ORIGIN must be set to an explicit allowlist in production.');
  }
  console.warn('[config] CLIENT_ORIGIN unset — reflecting request origin (development only).');
  return null;
})();

export const TOKEN_TTL = {
  /** Invite links stay valid for a week. */
  invite: process.env.INVITE_TTL || '7d',
  /** A browser session (survives reloads and reconnects). */
  session: process.env.SESSION_TTL || '12h',
};

export const TURN = {
  urls: list(process.env.TURN_URLS),
  secret: process.env.TURN_SECRET || null,
  ttlSeconds: int(process.env.TURN_TTL_SECONDS, 86400),
  staticUsername: process.env.TURN_USERNAME || null,
  staticPassword: process.env.TURN_PASSWORD || null,
};

/**
 * Metered.ca relay, as an alternative to running coturn.
 *
 * It does not fit the `TURN` block above. coturn hands you a shared secret and
 * you mint credentials from it; Metered mints the credentials itself and hands
 * you a key that reads them back. So instead of signing anything, the server
 * fetches a ready-made ICE list from
 * `<apiBase>/api/v1/turn/credentials?apiKey=…` and merges it into its own.
 *
 * `apiKey` is the credential-scoped key, which Metered documents as safe to use
 * from a browser. It stays on the server regardless: the client already gets its
 * ICE list from `/rtc/ice`, one round trip either way, and keeping the key here
 * means a rotation is a server restart rather than a client deploy.
 *
 * `apiBase` exists so the tests can point this at a local stub — and, less
 * theoretically, so a deployment can route through its own proxy. Leave it
 * unset in production.
 */
export const METERED = {
  appName: process.env.METERED_APP_NAME || null,
  apiKey: process.env.METERED_API_KEY || null,
  /** Paid plans only; the free plan is pinned to `standard.relay.metered.ca`. */
  region: process.env.METERED_REGION || null,
  apiBase: process.env.METERED_API_BASE || null,
  /**
   * How long to reuse a fetched list. Metered's credentials are long-lived
   * unless created with an expiry, so this is about not making an outbound call
   * per join — not about credential freshness. A revoked credential still stops
   * working within one window.
   */
  cacheSeconds: int(process.env.METERED_CACHE_SECONDS, 600),
};

export const STUN_URLS = list(process.env.STUN_URLS).length
  ? list(process.env.STUN_URLS)
  : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

export const DOC_STORE = {
  provider: process.env.DOC_STORE_PROVIDER || 'local',
  dir: path.resolve(process.cwd(), process.env.DOC_STORE_DIR || '.data'),
  enabled: bool(process.env.DOC_STORE_ENABLED, true),
  /** Refuse to persist absurdly large docs (default 8 MiB). */
  maxBytes: int(process.env.DOC_MAX_BYTES, 8 * 1024 * 1024),
  /** Ask a client for a compacted snapshot once the update log exceeds this. */
  compactAfterUpdates: int(process.env.DOC_COMPACT_AFTER, 400),
  /** Debounce window for flushing a room to disk. */
  flushDebounceMs: int(process.env.DOC_FLUSH_DEBOUNCE_MS, 2000),
};

if (!['local', 'firestore'].includes(DOC_STORE.provider)) {
  throw new Error('DOC_STORE_PROVIDER must be local or firestore.');
}

export const ROOM_TTL_MS = int(process.env.ROOM_TTL_HOURS, 72) * 60 * 60 * 1000;

/** Per-socket token bucket: burst size and refill rate for signaling traffic. */
export const RATE_LIMIT = {
  burst: int(process.env.RATE_LIMIT_BURST, 120),
  perSecond: int(process.env.RATE_LIMIT_PER_SECOND, 40),
};

export const MAX_PEERS_PER_ROOM = int(process.env.MAX_PEERS_PER_ROOM, 12);
export const MAX_DISPLAY_NAME = 40;
