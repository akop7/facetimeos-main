'use client';

/**
 * Thin client for the signaling server's REST surface.
 *
 * This replaces the browser inventing its own authority. The old home page did
 * `localStorage.setItem('hostToken_' + roomId, hostToken)` with a token it made
 * up locally, and the room trusted it — so anyone could be host of any room by
 * writing one key. Now every capability is a server-signed JWT this module
 * fetches and stores, and the server verifies it on every privileged action.
 */

import { API_BASE } from '../constants/ice-servers';

const SESSION_KEY = (roomId) => `ftos.session.${roomId}`;
const NAME_KEY = 'ftos.displayName';

class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError('Could not reach the meeting server.', { code: 'offline' });
  }

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError('The meeting server sent an unreadable response.', {
        status: res.status,
        code: 'bad-response',
      });
    }
  }

  if (!res.ok) {
    throw new ApiError(json?.message || json?.error || `Request failed (${res.status})`, {
      status: res.status,
      code: json?.error,
    });
  }
  return json;
}

export const roomApi = {
  health: () => request('/health'),

  /** Mint a room plus its host token and role-scoped invite tokens. */
  createRoom: (title) => request('/rooms', { method: 'POST', body: { title } }),

  /** Pre-join probe: does the room exist, is it locked, is there saved work? */
  probeRoom: (roomId, signal) => request(`/rooms/${roomId}`, { signal }),

  /**
   * Exchange an invite or resume token for a session. The server assigns the
   * peerId — the client never picks its own identity.
   */
  createSession: (roomId, { displayName, inviteToken, resumeToken }) =>
    request(`/rooms/${roomId}/session`, {
      method: 'POST',
      body: { displayName, inviteToken, resumeToken },
    }),

  /** Host-only: mint an extra invite link for a given role. */
  createInvite: (roomId, { sessionToken, role, ttl }) =>
    request(`/rooms/${roomId}/invites`, {
      method: 'POST',
      body: { sessionToken, role, ttl },
    }),

  /** Host-only: wipe the durable artifacts for a room. */
  clearArtifacts: (roomId, sessionToken) =>
    request(`/rooms/${roomId}/artifacts`, { method: 'DELETE', body: { sessionToken } }),
};

/* --------------------------- local session cache --------------------------- */

/**
 * Sessions are per **tab**, names and host credentials are per **browser**.
 *
 * `localStorage` is shared by every tab of an origin, so two windows in the same
 * profile were overwriting one another's `ftos.session.<roomId>` record. The
 * second window to join won, and a reload in the first one resumed the *other*
 * peer's token — same peerId, same role — which is one of the two ways the Host
 * badge ended up on the wrong person. `sessionStorage` is scoped to the tab and
 * still survives a reload, which is exactly the lifetime a seat should have.
 */
function sessionStore() {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveSession(roomId, session) {
  if (!session?.sessionToken) return;
  const store = sessionStore();
  try {
    store?.setItem(
      SESSION_KEY(roomId),
      JSON.stringify({
        sessionToken: session.sessionToken,
        peerId: session.peerId,
        role: session.role,
        displayName: session.displayName,
        savedAt: Date.now(),
      })
    );
    // The name is a preference, not an identity, so it stays browser-wide.
    if (session.displayName) window.localStorage.setItem(NAME_KEY, session.displayName);
  } catch {
    /* Private mode; the room still works, reloads just cost a new identity. */
  }
}

export function loadSession(roomId) {
  const store = sessionStore();
  if (!store) return null;
  try {
    let raw = store.getItem(SESSION_KEY(roomId));
    if (!raw) {
      // One-time migration for a tab that still has a session from the old
      // localStorage layout, so this change does not log everyone out.
      raw = window.localStorage.getItem(SESSION_KEY(roomId));
      if (raw) {
        store.setItem(SESSION_KEY(roomId), raw);
        window.localStorage.removeItem(SESSION_KEY(roomId));
      }
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Session tokens live 12h server-side; do not bother replaying older ones.
    if (Date.now() - (parsed.savedAt || 0) > 12 * 60 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(roomId) {
  try {
    sessionStore()?.removeItem(SESSION_KEY(roomId));
    window.localStorage?.removeItem(SESSION_KEY(roomId));
  } catch {
    /* nothing to do */
  }
}

export function rememberedName() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * Remember a name before there is a session to save it with — the home page asks
 * for it, and the room's join screen should not ask again a second later.
 */
export function rememberName(name) {
  if (typeof window === 'undefined' || !name) return;
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    /* nothing to do */
  }
}

/** Host tokens are kept per-room so the creator can rejoin as host later. */
export function saveHostToken(roomId, hostToken) {
  if (typeof window === 'undefined' || !hostToken) return;
  try {
    window.localStorage.setItem(`ftos.host.${roomId}`, hostToken);
  } catch {
    /* nothing to do */
  }
}

export function loadHostToken(roomId) {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(`ftos.host.${roomId}`);
  } catch {
    return null;
  }
}

export { ApiError };
