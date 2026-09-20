/**
 * ICE configuration and signaling endpoints.
 *
 * The hardcoded STUN-only list this file used to export was the single biggest
 * cause of "connecting…" forever: STUN alone cannot traverse symmetric NAT or
 * most corporate firewalls, so a meaningful slice of real users could never
 * connect at all. TURN credentials must be short-lived and therefore cannot be
 * baked into a client bundle — so the list is now fetched from the server at
 * runtime (`GET /rtc/ice`), which mints ephemeral HMAC credentials per request.
 *
 * The static list below survives only as the offline fallback, so a signaling
 * outage degrades to "same-network calls still work" instead of a hard failure.
 */

/** Last-resort fallback. Same-LAN and easy-NAT calls work; hard NAT will not. */
export const FALLBACK_ICE_SERVERS = (() => {
  const fromEnv = process.env.NEXT_PUBLIC_STUN_URLS;
  const urls = (fromEnv || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return urls.map((u) => ({ urls: u }));
})();

/**
 * @deprecated Use `fetchIceConfig()`. Kept so any straggling import keeps
 * working rather than throwing at module load.
 */
export const ICE_SERVERS = FALLBACK_ICE_SERVERS;

// Where the socket.io signaling client should connect.
//
// Resolution order:
//  1. NEXT_PUBLIC_SIGNALING_URL — explicit override (e.g. a second tunnel or a
//     deployed signaling server). Use this if you point the client straight at
//     the signaling server's own public URL.
//  2. localhost / 127.0.0.1 — talk directly to the local signaling server on
//     :3001 (native WebSocket, unchanged local-dev behaviour).
//  3. Anything else (LAN IP, HTTPS tunnel, prod) — connect to the SAME origin
//     the page was served from. Next.js proxies "/socket.io" to the signaling
//     server via a rewrite (see next.config.mjs), so a single hostname/tunnel
//     serves both the app and signaling, with no CORS and correct https/wss.
function resolveSignalingUrl() {
  if (process.env.NEXT_PUBLIC_SIGNALING_URL) {
    return process.env.NEXT_PUBLIC_SIGNALING_URL;
  }
  if (typeof window !== 'undefined') {
    const { hostname, origin } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:3001';
    }
    return origin;
  }
  return 'http://localhost:3001';
}

export const SIGNALING_SERVER_URL = resolveSignalingUrl();

/**
 * A Next.js `rewrites()` entry proxies `/rtc/*` to the signaling server, so
 * when we are same-origin the REST base is just a path — one tunnel, no CORS.
 */
export const API_BASE = (() => {
  if (typeof window === 'undefined') return `${SIGNALING_SERVER_URL}/rtc`;
  return SIGNALING_SERVER_URL === window.location.origin
    ? '/rtc'
    : `${SIGNALING_SERVER_URL}/rtc`;
})();

/** True when a socket.io upgrade cannot survive the proxy (see next.config.mjs). */
export const SIGNALING_IS_PROXIED =
  typeof window !== 'undefined' && SIGNALING_SERVER_URL === window.location.origin;

let cached = null;

/**
 * Fetch the live ICE configuration. Cached until shortly before the TURN
 * credentials expire, then refetched — a call that outlives its credentials
 * would silently lose the ability to ICE-restart onto the relay.
 */
export async function fetchIceConfig({ force = false, signal } = {}) {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const res = await fetch(`${API_BASE}/ice`, { signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`ice endpoint returned ${res.status}`);
    const json = await res.json();

    const iceServers = Array.isArray(json.iceServers) && json.iceServers.length
      ? json.iceServers
      : FALLBACK_ICE_SERVERS;

    const value = {
      iceServers,
      hasTurn: Boolean(json.hasTurn),
      iceTransportPolicyOptions: json.iceTransportPolicyOptions || ['all'],
      degraded: false,
    };

    // Refresh at 80% of the credential lifetime, floored at 60s.
    const ttlMs = Math.max(60_000, (json.ttlSeconds || 3600) * 800);
    cached = { value, expiresAt: Date.now() + ttlMs };
    return value;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.warn('[ice] falling back to STUN-only:', err?.message);
    return {
      iceServers: FALLBACK_ICE_SERVERS,
      hasTurn: false,
      iceTransportPolicyOptions: ['all'],
      degraded: true,
    };
  }
}

export function clearIceCache() {
  cached = null;
}
