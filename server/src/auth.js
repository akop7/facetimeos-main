import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, TOKEN_TTL, MAX_DISPLAY_NAME } from './config.js';

export const ROLES = Object.freeze({
  HOST: 'host',
  EDITOR: 'editor',
  VIEWER: 'viewer',
});

const ROLE_RANK = { [ROLES.VIEWER]: 0, [ROLES.EDITOR]: 1, [ROLES.HOST]: 2 };

export function isValidRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, role);
}

/** True when `role` is at least as privileged as `required`. */
export function roleAtLeast(role, required) {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[required] ?? Infinity);
}

export function newPeerId() {
  return crypto.randomUUID();
}

export function newRoomId() {
  return crypto.randomUUID();
}

/**
 * Strip control characters (C0, DEL, C1) and clamp length. Never trust a
 * client-sent name: unfiltered, it can smuggle newlines or terminal escape
 * sequences into server logs and into every other participant's UI.
 */
export function sanitizeDisplayName(raw, fallback = 'Guest') {
  if (typeof raw !== 'string') return fallback;
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    cleaned += ch;
  }
  cleaned = cleaned.trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, MAX_DISPLAY_NAME);
}

export function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * An invite token proves "the bearer may join room X with role Y". Only the
 * server can mint one, which is what makes host authority real: previously the
 * host token was a UUID the *browser* generated and stashed in localStorage, so
 * anyone could invent one and claim the room.
 */
export function signInviteToken({ roomId, role = ROLES.VIEWER, ttl = TOKEN_TTL.invite }) {
  if (!isValidRole(role)) throw new Error(`Unknown role: ${role}`);
  return jwt.sign({ rid: roomId, role, typ: 'invite' }, JWT_SECRET, { expiresIn: ttl });
}

/**
 * A session token binds a specific peerId + role to a specific room. The socket
 * handshake carries only this token, so `peerId` is no longer client-asserted
 * and cannot be spoofed to impersonate another participant.
 */
export function signSessionToken({ roomId, peerId, role, displayName }) {
  if (!isValidRole(role)) throw new Error(`Unknown role: ${role}`);
  return jwt.sign(
    { rid: roomId, pid: peerId, role, name: displayName, typ: 'session' },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL.session }
  );
}

function verify(token, expectedTyp) {
  if (typeof token !== 'string' || token.length === 0) return null;
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    if (claims.typ !== expectedTyp) return null;
    if (!isValidRole(claims.role)) return null;
    return claims;
  } catch {
    // Deliberately silent: expired/forged tokens are routine, and logging the
    // raw error echoes attacker-controlled input into the log.
    return null;
  }
}

/** @returns {{roomId: string, role: string}|null} */
export function verifyInviteToken(token) {
  const claims = verify(token, 'invite');
  if (!claims || typeof claims.rid !== 'string') return null;
  return { roomId: claims.rid, role: claims.role };
}

/** @returns {{roomId: string, peerId: string, role: string, displayName: string}|null} */
export function verifySessionToken(token) {
  const claims = verify(token, 'session');
  if (!claims || typeof claims.rid !== 'string' || typeof claims.pid !== 'string') return null;
  return {
    roomId: claims.rid,
    peerId: claims.pid,
    role: claims.role,
    displayName: sanitizeDisplayName(claims.name),
  };
}
