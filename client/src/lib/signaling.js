'use client';

/**
 * Socket.io client for the signaling server.
 *
 * Rewritten against the server-authoritative protocol. Three things changed
 * that matter:
 *
 *  1. `join-room` now carries a server-signed **session token** and nothing
 *     else. The old version sent `{roomId, peerId, displayName, hostToken}`,
 *     all of it client-asserted — any tab could claim any identity, and host
 *     powers came from a token the browser minted for itself.
 *  2. Every relay message addresses `to` and the server stamps `from`, so a
 *     peer can no longer forge the sender or reach into another room.
 *  3. Document updates travel as binary. They used to be JSON arrays of byte
 *     values, roughly a 4x inflation on the hot path.
 */

import { io } from 'socket.io-client';
import { SIGNALING_SERVER_URL, SIGNALING_IS_PROXIED } from '../constants/ice-servers';

/** Server→client events fanned out to `on(event, handler)` subscribers. */
const SERVER_EVENTS = [
  'error-notice',
  'peer-joined',
  'peer-left',
  'room-peers',
  'peer-updated',
  'room-state',
  'role-changed',
  'sdp-offer',
  'sdp-answer',
  'ice-candidate',
  'moderated',
  'kicked',
  'room-ended',
  'waiting-room',
  'waiting-approved',
  'waiting-denied',
  'ephemeral',
  'doc-snapshot',
  'doc-update',
  'doc-compact-request',
  'artifacts-cleared',
  /** A participant asking a host for the whiteboard or the code editor. */
  'access-request',
  /** The host's answer, addressed to the peer who asked. */
  'tool-access',
];

export class SignalingClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    /** The session token is the only identity we ever present. */
    this._sessionToken = null;
    this._hasConnectedOnce = false;
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event)?.delete(handler);
  }

  _emitLocal(event, payload) {
    for (const handler of this._listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (err) {
        console.warn(`[signaling] ${event} handler threw:`, err?.message);
      }
    }
  }

  connect(serverUrl = SIGNALING_SERVER_URL) {
    if (this.socket) return this.socket;

    // Transport selection is the whole ballgame for tunnels and LAN access.
    // When we are same-origin, socket.io is going through a Next.js rewrite,
    // and rewrites forward plain HTTP but not WebSocket upgrades — an attempted
    // upgrade fails and can drop the connection, leaving peers stuck at "1
    // participant". Polling is forwarded reliably, and signaling is low volume;
    // the media itself never touches this socket.
    const transports = SIGNALING_IS_PROXIED ? ['polling'] : ['polling', 'websocket'];

    this.socket = io(serverUrl, {
      transports,
      upgrade: !SIGNALING_IS_PROXIED,
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      this.connected = true;
      this._emitLocal('connection', { connected: true, transport: this.socket.io.engine.transport.name });
      // Re-join after a blip. The token still proves who we are, so the server
      // restores the same peerId, role and joinedAt instead of creating a ghost.
      if (this._hasConnectedOnce && this._sessionToken) {
        this.joinRoom(this._sessionToken);
      }
      this._hasConnectedOnce = true;
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      this._emitLocal('connection', { connected: false, reason });
    });

    this.socket.on('connect_error', (err) => {
      this.connected = false;
      // Surfaces the real cause of a failed tunnel/LAN connection (CORS,
      // transport, proxy 404) instead of an unexplained empty room.
      this._emitLocal('connection', { connected: false, error: err?.message || String(err) });
    });

    for (const event of SERVER_EVENTS) {
      this.socket.on(event, (payload) => this._emitLocal(event, payload));
    }

    return this.socket;
  }

  /** Promise-wrapped emit for the handful of events the server acknowledges. */
  _request(event, payload) {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve({ ok: false, error: 'not-connected' });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: 'timeout' });
        }
      }, 10_000);
      this.socket.emit(event, payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response || { ok: false, error: 'no-response' });
      });
    });
  }

  /**
   * Join with a session token minted by `POST /rtc/rooms/:roomId/session`.
   * Identity, role and display name all come out of the token server-side.
   */
  joinRoom(sessionToken) {
    this._sessionToken = sessionToken;
    return this._request('join-room', { sessionToken });
  }

  /** After a role change the server issues a fresh token; keep it for re-joins. */
  updateSessionToken(sessionToken) {
    if (sessionToken) this._sessionToken = sessionToken;
  }

  sendOffer(to, sdp) {
    this.socket?.emit('sdp-offer', { to, sdp });
  }

  sendAnswer(to, sdp) {
    this.socket?.emit('sdp-answer', { to, sdp });
  }

  sendIceCandidate(to, candidate) {
    this.socket?.emit('ice-candidate', { to, candidate });
  }

  /** Fire-and-forget presence: cursors, reactions, typing, screen-share flags. */
  sendEphemeral(type, data) {
    this.socket?.emit('ephemeral', { type, data });
  }

  raiseHand(raised) {
    this.socket?.emit('hand', { raised });
  }

  rename(displayName) {
    this.socket?.emit('rename', { displayName });
  }

  /** Host-only. The server enforces it; this is just the request. */
  moderate(action, targetPeerId, value) {
    return this._request('moderate', { action, targetPeerId, value });
  }

  admit(peerId, admit) {
    return this._request('admit', { peerId, admit });
  }

  /** Ask the host to open one shared tool for me. */
  requestAccess(tool) {
    return this._request('request-access', { tool });
  }

  /** Binary Yjs update for durable storage and relay to peers we cannot reach. */
  sendDocUpdate(update) {
    if (!this.socket || !update?.length) return;
    this.socket.emit('doc-update', { update });
  }

  sendDocSnapshot(snapshot) {
    if (!this.socket || !snapshot?.length) return;
    this.socket.emit('doc-compact', { snapshot });
  }

  resyncDoc() {
    return this._request('doc-resync', {});
  }

  leaveRoom() {
    this._sessionToken = null;
    this.socket?.emit('leave-room');
  }

  disconnect() {
    this._sessionToken = null;
    this._hasConnectedOnce = false;
    this._listeners.clear();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
  }
}
