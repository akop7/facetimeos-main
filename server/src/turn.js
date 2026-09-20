import crypto from 'node:crypto';
import { TURN, STUN_URLS, METERED } from './config.js';

/** Metered is in play only when both halves of the pair are present. */
const meteredConfigured = () => Boolean(METERED.appName && METERED.apiKey);

function meteredEndpoint() {
  const base = METERED.apiBase || `https://${encodeURIComponent(METERED.appName)}.metered.live`;
  const url = new URL('/api/v1/turn/credentials', base);
  url.searchParams.set('apiKey', METERED.apiKey);
  if (METERED.region) url.searchParams.set('region', METERED.region);
  return url;
}

/**
 * Keep only the relay entries.
 *
 * Metered's response opens with its own STUN server, which is redundant — this
 * server already sends a STUN list, and a duplicate only adds a candidate the
 * browser has to gather and discard. Entries without a username and credential
 * cannot authenticate against a relay, so they are dropped rather than shipped
 * as something that will fail during the call.
 */
function relayEntries(body) {
  const raw = Array.isArray(body) ? body : Array.isArray(body?.iceServers) ? body.iceServers : [];
  return raw.filter((entry) => {
    const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
    const isRelay = urls.every((u) => typeof u === 'string' && /^turns?:/i.test(u));
    return isRelay && Boolean(entry.username) && Boolean(entry.credential);
  });
}

let meteredCache = null;
let meteredWarnedAt = 0;

/**
 * A relay outage must not become a call-setup outage: every failure here is
 * logged and swallowed by the caller, which then falls back to STUN-only. The
 * log is throttled because the failing path is per-join and a provider outage
 * would otherwise write a line per participant per reconnect.
 */
function warnMetered(error) {
  if (Date.now() - meteredWarnedAt < 60_000) return;
  meteredWarnedAt = Date.now();
  console.warn(`[turn] Metered lookup failed (${error.message}) — falling back to STUN only.`);
}

async function meteredIceServers() {
  if (meteredCache && Date.now() - meteredCache.fetchedAt < METERED.cacheSeconds * 1000) {
    return meteredCache.iceServers;
  }

  // A hung provider would otherwise hang the join: `/rtc/ice` is on the critical
  // path to the first offer.
  const signal = AbortSignal.timeout(4000);
  const res = await fetch(meteredEndpoint(), { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const iceServers = relayEntries(await res.json());
  if (iceServers.length === 0) throw new Error('no usable relay entries in response');

  meteredCache = { iceServers, fetchedAt: Date.now() };
  return iceServers;
}

/**
 * Ephemeral TURN credentials, per the coturn REST API convention
 * (`static-auth-secret` / "TURN REST API" draft):
 *
 *   username   = "<unix-expiry>:<opaque-id>"
 *   credential = base64( HMAC-SHA1( shared_secret, username ) )
 *
 * This is how you ship a relay to a browser without ever shipping a long-lived
 * password. A leaked credential expires on its own.
 */
function ephemeralCredentials(identity) {
  const expiry = Math.floor(Date.now() / 1000) + TURN.ttlSeconds;
  const username = `${expiry}:${identity}`;
  const credential = crypto.createHmac('sha1', TURN.secret).update(username).digest('base64');
  return { username, credential, expiresAt: expiry * 1000 };
}

/**
 * Build the ICE server list handed to the browser.
 *
 * STUN alone only works when at least one side can be reached directly. Behind
 * symmetric NAT, CGNAT, or a firewall that blocks UDP — common on mobile
 * carriers and corporate networks — the connection never establishes. A TURN
 * relay is the only fix, so this is the difference between "works on my laptop"
 * and "works for everyone".
 *
 * Async because one of the two supported relay sources is an HTTP lookup. It
 * still resolves without a relay rather than rejecting: a call with a smaller
 * chance of connecting beats no call at all.
 */
export async function buildIceConfig(identity = 'anon') {
  const iceServers = STUN_URLS.map((urls) => ({ urls }));
  let ttlSeconds = TURN.ttlSeconds;
  let hasTurn = false;

  if (TURN.urls.length > 0) {
    if (TURN.secret) {
      const { username, credential } = ephemeralCredentials(identity);
      iceServers.push({ urls: TURN.urls, username, credential });
      hasTurn = true;
    } else if (TURN.staticUsername && TURN.staticPassword) {
      iceServers.push({
        urls: TURN.urls,
        username: TURN.staticUsername,
        credential: TURN.staticPassword,
      });
      hasTurn = true;
    } else {
      console.warn('[turn] TURN_URLS is set but neither TURN_SECRET nor TURN_USERNAME/PASSWORD is — skipping TURN.');
    }
  }

  if (meteredConfigured()) {
    try {
      iceServers.push(...(await meteredIceServers()));
      hasTurn = true;
    } catch (error) {
      warnMetered(error);
    }
  }

  if (!hasTurn) ttlSeconds = 300;

  return {
    iceServers,
    hasTurn,
    // The browser re-fetches shortly before credentials lapse.
    ttlSeconds,
    // `relay` forces every candidate through TURN; useful for a "hide my IP"
    // privacy toggle, but only offer it when a relay actually exists.
    iceTransportPolicyOptions: hasTurn ? ['all', 'relay'] : ['all'],
  };
}

export function turnConfigured() {
  const selfHosted = TURN.urls.length > 0 && Boolean(TURN.secret || (TURN.staticUsername && TURN.staticPassword));
  return selfHosted || meteredConfigured();
}

/**
 * Which relay sources are configured, for the boot log. "Configured" here means
 * the environment is complete — whether Metered actually answers is only known
 * once someone joins, which is why the lookup failure is logged separately.
 */
export function turnProviders() {
  const providers = [];
  if (TURN.urls.length > 0 && TURN.secret) providers.push('self-hosted (HMAC)');
  else if (TURN.urls.length > 0 && TURN.staticUsername && TURN.staticPassword) {
    providers.push('self-hosted (static)');
  }
  if (meteredConfigured()) providers.push(`metered (${METERED.region || 'default region'})`);
  return providers;
}
