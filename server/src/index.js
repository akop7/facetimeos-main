import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

import { CLIENT_ORIGINS, PORT, ROOM_TTL_MS, MAX_PEERS_PER_ROOM, DOC_STORE } from './config.js';
import { firebaseAdminConfigured } from './firebase-admin.js';
import { desktopAuthRouter } from './desktop-auth.js';
import {
  ROLES,
  isUuid,
  isValidRole,
  newPeerId,
  newRoomId,
  sanitizeDisplayName,
  signInviteToken,
  signSessionToken,
  verifyInviteToken,
  verifySessionToken,
} from './auth.js';
import { roomManager } from './room-manager.js';
import { setupSignaling } from './signaling.js';
import { buildIceConfig, turnConfigured, turnProviders } from './turn.js';
import * as docStore from './doc-store.js';

const app = express();
const httpServer = createServer(app);

// `origin: true` reflects whatever Origin the request carries, which is a
// wildcard in practice. config.js refuses to boot in production without an
// explicit allowlist, so this is only ever permissive in development.
const corsOrigin = CLIENT_ORIGINS ?? true;

app.disable('x-powered-by');
app.use(cors({ origin: corsOrigin, methods: ['GET', 'POST', 'DELETE'], credentials: true }));
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const io = new Server(httpServer, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true },
  maxHttpBufferSize: 2 * 1024 * 1024,
  pingTimeout: 25_000,
});

setupSignaling(io);

/**
 * All REST endpoints live under /rtc so a single Next.js rewrite can proxy the
 * whole signaling surface (`/rtc/*` and `/socket.io/*`) and the app can run
 * behind one HTTPS origin — which is what getUserMedia requires on phones.
 */
const api = express.Router();
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
api.use('/desktop-auth', desktopAuthRouter());

api.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ...roomManager.stats(),
    turn: turnConfigured(),
    storage: DOC_STORE.enabled ? DOC_STORE.provider : 'disabled',
    desktopAuth: firebaseAdminConfigured(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/**
 * ICE configuration, including short-lived TURN credentials. The browser must
 * fetch this at call setup instead of hardcoding a STUN-only list — without a
 * relay, peers behind symmetric NAT or UDP-blocking firewalls never connect.
 */
api.get('/ice', async (req, res) => {
  const claims = verifySessionToken(String(req.query.sessionToken || ''));
  try {
    // Credentials are bound to a peer when we know one, so a leaked credential is
    // attributable and expires on its own.
    res.json(await buildIceConfig(claims ? `${claims.roomId}:${claims.peerId}` : 'anon'));
  } catch (error) {
    // `buildIceConfig` swallows relay-provider failures itself, so reaching here
    // means something unforeseen. Express 4 does not catch async rejections, and
    // an unhandled one here would leave the join hanging on a socket that never
    // answers.
    console.error('[turn] ICE config failed:', error.message);
    res.status(500).json({ error: 'ice-unavailable' });
  }
});

/**
 * Create a room. This is the endpoint that removes the old
 * `localStorage.setItem('hostToken_' + roomId, crypto-random-uuid)` from the
 * browser: the host credential is now a JWT only this server can sign.
 */
api.post('/rooms', (req, res) => {
  const roomId = newRoomId();
  // No placeholder title. A caller that names the room gets that name; one that
  // does not leaves it null, and the first join names it after the host.
  const title = sanitizeDisplayName(req.body?.title, null);
  roomManager.createRoom(roomId, { title });

  res.status(201).json({
    roomId,
    title,
    hostToken: signInviteToken({ roomId, role: ROLES.HOST }),
    // Share links carry a role, so "view-only guest" is enforceable rather than
    // being a client-side suggestion.
    inviteTokens: {
      editor: signInviteToken({ roomId, role: ROLES.EDITOR }),
      viewer: signInviteToken({ roomId, role: ROLES.VIEWER }),
    },
    maxPeers: MAX_PEERS_PER_ROOM,
  });
});

/** Cheap pre-join probe so the UI can say "this room has saved work in it". */
api.get('/rooms/:roomId', asyncRoute(async (req, res) => {
  const { roomId } = req.params;
  if (!isUuid(roomId)) return res.status(400).json({ error: 'bad-room-id' });

  const room = roomManager.getRoom(roomId);
  await docStore.ensureLoaded(roomId);
  const stats = docStore.getStats(roomId);

  return res.json({
    roomId,
    exists: Boolean(room) || stats.hasContent,
    live: Boolean(room),
    title: room?.title ?? null,
    locked: room?.locked ?? false,
    participants: room?.size ?? 0,
    maxPeers: MAX_PEERS_PER_ROOM,
    hasSavedWork: stats.hasContent,
  });
}));

/**
 * Exchange an invite token (or a previous session token) for a session token.
 * The returned peerId is generated *here*: the client can no longer pick its own
 * identity, which is what made impersonation possible before.
 */
api.post('/rooms/:roomId/session', asyncRoute(async (req, res) => {
  const { roomId } = req.params;
  if (!isUuid(roomId)) return res.status(400).json({ error: 'bad-room-id' });

  const displayName = sanitizeDisplayName(req.body?.displayName, 'Guest');
  const requestedRole = req.body?.role;

  let role = ROLES.EDITOR; // Open rooms are collaborative by default.
  let peerId = null;

  // Resuming an existing session (page reload / reconnect) keeps identity+role.
  const resumed = verifySessionToken(req.body?.resumeToken);
  if (resumed && resumed.roomId === roomId) {
    peerId = resumed.peerId;
    role = resumed.role;
  }

  // An invite token upgrades (never downgrades below) the role.
  const invite = verifyInviteToken(req.body?.inviteToken);
  if (invite) {
    if (invite.roomId !== roomId) return res.status(403).json({ error: 'token-room-mismatch' });
    role = invite.role;
  } else if (req.body?.inviteToken) {
    return res.status(403).json({ error: 'invalid-invite-token' });
  } else if (isValidRole(requestedRole) && requestedRole === ROLES.VIEWER) {
    // Self-downgrading to viewer is always allowed.
    role = ROLES.VIEWER;
  }

  const room = roomManager.getRoom(roomId);
  if (room && room.size >= MAX_PEERS_PER_ROOM && !(peerId && room.peers.has(peerId))) {
    return res.status(409).json({ error: 'room-full', maxPeers: MAX_PEERS_PER_ROOM });
  }

  if (!peerId) peerId = newPeerId();
  await docStore.ensureLoaded(roomId);

  return res.json({
    roomId,
    peerId,
    role,
    displayName,
    sessionToken: signSessionToken({ roomId, peerId, role, displayName }),
    hasSavedWork: docStore.getStats(roomId).hasContent,
  });
}));

/** Host-only: mint an additional share link with a specific role. */
api.post('/rooms/:roomId/invites', (req, res) => {
  const { roomId } = req.params;
  const claims = verifySessionToken(req.body?.sessionToken);
  if (!claims || claims.roomId !== roomId || claims.role !== ROLES.HOST) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const role = isValidRole(req.body?.role) ? req.body.role : ROLES.EDITOR;
  if (role === ROLES.HOST && !req.body?.allowCoHost) {
    return res.status(400).json({ error: 'co-host-requires-confirmation' });
  }
  return res.json({ roomId, role, inviteToken: signInviteToken({ roomId, role }) });
});

/** Host-only: forget a room's saved artifacts. Irreversible, hence host-gated. */
api.delete('/rooms/:roomId/artifacts', asyncRoute(async (req, res) => {
  const { roomId } = req.params;
  const claims = verifySessionToken(req.body?.sessionToken || req.query.sessionToken);
  if (!claims || claims.roomId !== roomId || claims.role !== ROLES.HOST) {
    return res.status(403).json({ error: 'forbidden' });
  }
  await docStore.deleteRoom(roomId);
  io.to(`room:${roomId}`).emit('artifacts-cleared', { by: claims.peerId });
  return res.json({ ok: true });
}));

app.use('/rtc', api);
// Kept for backwards compatibility with the old health probe path.
app.get('/health', (req, res) => res.json({ status: 'ok', ...roomManager.stats() }));

app.use((req, res) => res.status(404).json({ error: 'not-found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http]', err.message);
  res.status(err.status || 500).json({ error: 'server-error', message: 'The server could not complete this request. Your saved work has not been replaced; please retry.' });
});

const evictionTimer = setInterval(
  () => {
    docStore
      .evictExpired()
      .then((n) => n > 0 && console.log(`[doc-store] evicted ${n} idle room(s)`))
      .catch(() => {});
  },
  Math.min(ROOM_TTL_MS, 60 * 60 * 1000)
);
evictionTimer.unref();

httpServer.listen(PORT, () => {
  console.log(`[server] signaling + authority listening on :${PORT}`);
  console.log(`[server] origins: ${CLIENT_ORIGINS ? CLIENT_ORIGINS.join(', ') : '(reflecting request origin — dev only)'}`);
  console.log(
    `[server] TURN relay: ${
      turnConfigured()
        ? turnProviders().join(' + ')
        : 'NOT configured (calls will fail behind symmetric NAT)'
    }`
  );
});

async function shutdown(signal) {
  console.log(`[server] ${signal} — flushing room artifacts...`);
  clearInterval(evictionTimer);
  try {
    await docStore.flushAll();
  } catch (err) {
    console.error('[server] flush failed:', err.message);
  }
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, io, httpServer };
