import {
  ROLES,
  sanitizeDisplayName,
  signSessionToken,
  verifySessionToken,
} from './auth.js';
import { RATE_LIMIT } from './config.js';
import { roomManager, GRANTABLE_TOOLS } from './room-manager.js';
import * as docStore from './doc-store.js';

/**
 * Socket.io signaling with server-side authority.
 *
 * Previously every privileged action was decided in the browser: the client
 * asserted its own `peerId`, decided whether it was the host by reading
 * localStorage, and sent `KICK_PEER` / `MUTE_PEER` / `END_FOR_ALL` straight down
 * a data channel that receivers applied without checking who sent it. Any
 * participant could therefore impersonate anyone, moderate anyone, or end the
 * meeting. Every one of those decisions now happens here, against a
 * server-signed session token.
 */

const MAX_SDP_BYTES = 128 * 1024;
const MAX_CANDIDATE_BYTES = 4 * 1024;
const MAX_EPHEMERAL_BYTES = 8 * 1024;
const MAX_DOC_UPDATE_BYTES = 1024 * 1024;

const EPHEMERAL_TYPES = new Set([
  'REACTION',
  'CURSOR',
  'SCREEN_SHARE',
  'TYPING',
  'WIDGET_FOCUS',
  'PING',
  /**
   * Whether a peer's mic/camera are on. Announced explicitly rather than
   * inferred from the remote track's `muted` flag: disabling a track does not
   * reliably fire `onmute` on the receiving side, and when it does it can lag by
   * seconds — long enough for the UI to show someone as speaking while they are
   * muted.
   */
  'MEDIA_STATE',
  /** Where the presenter's viewport is, for follow-the-presenter. */
  'PRESENTER_VIEW',
]);

const MODERATION_ACTIONS = new Set([
  'mute-audio',
  'mute-video',
  'kick',
  'end-room',
  'grant-edit',
  'revoke-edit',
  'make-host',
  'lower-hand',
  'set-locked',
  'set-follow-host',
  /** Per-tool access to the whiteboard / code editor, answering a request. */
  'grant-tool',
  'revoke-tool',
]);

/** Simple token bucket. Cheap insurance against a client flooding the room. */
class RateLimiter {
  constructor(burst = RATE_LIMIT.burst, perSecond = RATE_LIMIT.perSecond) {
    this.capacity = burst;
    this.perSecond = perSecond;
    this.tokens = burst;
    this.last = Date.now();
  }

  take(cost = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

function byteLength(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Buffer.isBuffer(value)) return value.length;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Infinity;
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Buffer.from(value);
  return null;
}

function roomStatePayload(room) {
  return {
    roomId: room.id,
    title: room.title,
    locked: room.locked,
    followHost: room.followHost,
    hostPeerId: room.hostPeerId,
    /** Who created the room. The Host badge follows this, never an election. */
    ownerPeerId: room.ownerPeerId,
    createdAt: room.createdAt,
  };
}

const roomChannel = (roomId) => `room:${roomId}`;
const waitingChannel = (roomId) => `waiting:${roomId}`;

function emitToHosts(io, roomId, event, payload) {
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  for (const peer of room.peers.values()) {
    if (peer.role === ROLES.HOST) io.to(peer.socketId).emit(event, payload);
  }
}

/**
 * Push a role change to one peer *with* a freshly signed session token.
 *
 * The token is the point: without it the new role lasts until the next reload
 * and then silently reverts to whatever the stale token claimed.
 */
function pushRole(io, roomId, peer, role, meta = {}) {
  const socketId = peer?.socketId;
  if (!socketId) return;
  const s = io.sockets.sockets.get(socketId);
  if (s) s.data.role = role;
  io.to(socketId).emit('role-changed', {
    role,
    sessionToken: signSessionToken({
      roomId,
      peerId: peer.peerId,
      role,
      displayName: peer.displayName,
    }),
    ...meta,
  });
}

/**
 * Finish wiring a verified peer into a room: evict any stale socket from a
 * previous tab, join the broadcast channel, hand over the persisted document,
 * and announce the arrival.
 */
async function attachPeer(io, socket, result) {
  const { room, peer, isReconnect, previousSocketId, demoted = [] } = result;

  socket.data.roomId = room.id;
  socket.data.peerId = peer.peerId;
  socket.data.role = peer.role;
  socket.data.displayName = peer.displayName;

  if (previousSocketId) {
    const stale = io.sockets.sockets.get(previousSocketId);
    if (stale && stale.id !== socket.id) {
      stale.data.roomId = null;
      stale.data.peerId = null;
      stale.emit('error-notice', {
        code: 'superseded',
        message: 'This session was reopened in another tab.',
      });
      stale.leave(roomChannel(room.id));
      stale.disconnect(true);
    }
  }

  socket.join(roomChannel(room.id));

  // The creator came back to a room the server had put somebody else in charge
  // of. Tell that peer, and re-sign their token, or their browser keeps a HOST
  // credential it is no longer entitled to.
  for (const peerId of demoted) {
    const other = room.peers.get(peerId);
    if (!other) continue;
    pushRole(io, room.id, other, other.role, { by: 'server', reason: 'owner-returned' });
    io.to(roomChannel(room.id)).emit('peer-updated', {
      peerId,
      patch: { role: other.role },
    });
  }

  // Ship the durable artifacts before announcing the peer, so the newcomer's
  // editors are already populated when video starts negotiating.
  await docStore.ensureLoaded(room.id);
  const updates = docStore.getUpdates(room.id);
  socket.emit('doc-snapshot', { updates, seq: docStore.getStats(room.id).seq });

  socket.to(roomChannel(room.id)).emit('peer-joined', {
    peer: {
      peerId: peer.peerId,
      displayName: peer.displayName,
      role: peer.role,
      joinedAt: peer.joinedAt,
      handRaised: peer.handRaised,
      mutedByHost: peer.mutedByHost,
      tools: { ...peer.tools },
      isOwner: peer.peerId === room.ownerPeerId,
    },
    isReconnect,
  });

  io.to(roomChannel(room.id)).emit('room-peers', {
    peers: roomManager.getRoomPeers(room.id),
  });
  io.to(roomChannel(room.id)).emit('room-state', roomStatePayload(room));
}

/** Remove a socket from its room and notify everyone still there. */
function handleDeparture(io, socket, { silent = false, reason = 'left' } = {}) {
  const pending = socket.data?.pending;
  if (pending) {
    roomManager.removeFromWaitingRoom(pending.roomId, pending.peerId);
    socket.leave(waitingChannel(pending.roomId));
    emitToHosts(io, pending.roomId, 'waiting-room', {
      waiting: roomManager.getWaitingRoom(pending.roomId),
    });
    socket.data.pending = null;
  }

  const roomId = socket.data?.roomId;
  const peerId = socket.data?.peerId;
  if (!roomId || !peerId) return;

  socket.data.roomId = null;
  socket.data.peerId = null;
  socket.leave(roomChannel(roomId));

  const { room, removed, newHostPeerId, roomClosed } = roomManager.leaveRoom(
    roomId,
    peerId,
    socket.id
  );
  if (!removed) return;

  if (!silent) {
    io.to(roomChannel(roomId)).emit('peer-left', { peerId, reason });
  }

  if (roomClosed) {
    // Flush the artifacts so the room can be resumed from its link later.
    docStore.flush(roomId).catch(() => {});
    return;
  }

  if (newHostPeerId) {
    // Only ever reached for a room no creator has claimed — `leaveRoom` refuses
    // to elect while an owner exists, so a reload no longer hands the room to
    // whoever happened to be present.
    const newHost = room.peers.get(newHostPeerId);
    if (newHost) pushRole(io, roomId, newHost, ROLES.HOST, { by: 'server', reason: 'host-left' });
  }

  io.to(roomChannel(roomId)).emit('room-peers', { peers: roomManager.getRoomPeers(roomId) });
  if (room) io.to(roomChannel(roomId)).emit('room-state', roomStatePayload(room));
}

export function setupSignaling(io) {
  io.on('connection', (socket) => {
    const limiter = new RateLimiter();
    socket.data.limiter = limiter;

    const deny = (code, message) => socket.emit('error-notice', { code, message });

    /** Identity, only ever populated from a verified session token. */
    const identity = () => {
      const { roomId, peerId, role } = socket.data;
      if (!roomId || !peerId) return null;
      return { roomId, peerId, role };
    };

    const guard = (cost = 1) => {
      if (!limiter.take(cost)) {
        deny('rate-limited', 'Too many messages — slow down.');
        return false;
      }
      return true;
    };

    // ---------------------------------------------------------------- join ---

    socket.on('join-room', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!guard(2)) return respond({ ok: false, error: 'rate-limited' });

      const claims = verifySessionToken(payload?.sessionToken);
      if (!claims) {
        deny('bad-session', 'Session token missing, expired or invalid. Rejoin the room.');
        return respond({ ok: false, error: 'bad-session' });
      }

      const { roomId, peerId, role, displayName } = claims;

      // Re-joining a different room on the same socket would leave the old room
      // in a half-populated state, so tear the previous membership down first.
      if (socket.data.roomId && socket.data.roomId !== roomId) {
        handleDeparture(io, socket);
      }

      const existingRoom = roomManager.getRoom(roomId);
      const needsApproval =
        existingRoom?.locked && role !== ROLES.HOST && !existingRoom.peers.has(peerId);

      if (needsApproval) {
        socket.data.pending = { roomId, peerId, role, displayName };
        socket.join(waitingChannel(roomId));
        const waiting = roomManager.addToWaitingRoom(roomId, {
          peerId,
          displayName,
          socketId: socket.id,
        });
        emitToHosts(io, roomId, 'waiting-room', { waiting });
        return respond({ ok: true, status: 'waiting', roomId, peerId });
      }

      try { await docStore.ensureLoaded(roomId); }
      catch {
        deny('storage-unavailable', 'Saved work is temporarily unavailable. Please rejoin in a moment.');
        return respond({ ok: false, error: 'storage-unavailable' });
      }
      const result = roomManager.joinRoom({
        roomId,
        peerId,
        socketId: socket.id,
        displayName,
        role,
      });

      if (!result.ok) {
        deny(result.error, result.error === 'room-full' ? 'This room is full.' : 'Could not join.');
        return respond({ ok: false, error: result.error });
      }

      await attachPeer(io, socket, result);
      return respond({
        ok: true,
        status: 'joined',
        roomId,
        peerId,
        role: result.peer.role,
        tools: { ...result.peer.tools },
        isOwner: result.isOwner,
        peers: roomManager.getRoomPeers(roomId, { excludePeerId: peerId }),
        room: roomStatePayload(result.room),
        waiting: result.peer.role === ROLES.HOST ? roomManager.getWaitingRoom(roomId) : [],
      });
    });

    // --------------------------------------------------------------- relay ---

    /**
     * SDP and ICE are relayed only between two peers that are *both* verified
     * members of the *same* room, and `from` is stamped by the server rather
     * than accepted from the payload.
     */
    const relay = (event, field, maxBytes) => {
      socket.on(event, (payload) => {
        if (!guard()) return;
        const me = identity();
        if (!me) return deny('not-joined', 'Join a room first.');

        const target = payload?.to;
        const body = payload?.[field];
        if (typeof target !== 'string' || !body) return;
        if (byteLength(body) > maxBytes) return deny('too-large', `${field} payload too large.`);

        const targetSocketId = roomManager.findSocketIdInRoom(me.roomId, target);
        if (!targetSocketId) return; // Not in my room: silently drop.

        io.to(targetSocketId).emit(event, { from: me.peerId, [field]: body });
      });
    };

    relay('sdp-offer', 'sdp', MAX_SDP_BYTES);
    relay('sdp-answer', 'sdp', MAX_SDP_BYTES);
    relay('ice-candidate', 'candidate', MAX_CANDIDATE_BYTES);

    /**
     * Small, ephemeral, room-wide messages (reactions, cursor positions,
     * screen-share announcements). Relayed through the server so the sender
     * identity is trustworthy, and type-allowlisted so a client cannot invent a
     * message the receiver treats as privileged.
     */
    socket.on('ephemeral', (payload) => {
      if (!guard()) return;
      const me = identity();
      if (!me) return;
      const type = payload?.type;
      if (!EPHEMERAL_TYPES.has(type)) return;
      if (byteLength(payload?.data) > MAX_EPHEMERAL_BYTES) return;

      socket.to(roomChannel(me.roomId)).emit('ephemeral', {
        from: me.peerId,
        type,
        data: payload.data ?? null,
        at: Date.now(),
      });
    });

    socket.on('hand', (payload) => {
      if (!guard()) return;
      const me = identity();
      if (!me) return;
      const peer = roomManager.setHandRaised(me.roomId, me.peerId, payload?.raised);
      if (!peer) return;
      io.to(roomChannel(me.roomId)).emit('peer-updated', {
        peerId: me.peerId,
        patch: { handRaised: peer.handRaised },
      });
    });

    socket.on('rename', (payload) => {
      if (!guard()) return;
      const me = identity();
      if (!me) return;
      const room = roomManager.getRoom(me.roomId);
      const peer = room?.peers.get(me.peerId);
      if (!peer) return;
      peer.displayName = sanitizeDisplayName(payload?.displayName, peer.displayName);
      io.to(roomChannel(me.roomId)).emit('peer-updated', {
        peerId: me.peerId,
        patch: { displayName: peer.displayName },
      });
    });

    // ---------------------------------------------------------- moderation ---

    socket.on('moderate', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!guard(2)) return respond({ ok: false, error: 'rate-limited' });

      const me = identity();
      if (!me) return respond({ ok: false, error: 'not-joined' });

      const action = payload?.action;
      if (!MODERATION_ACTIONS.has(action)) return respond({ ok: false, error: 'unknown-action' });

      // The single authorization check that the old data-channel design lacked.
      if (!roomManager.isHost(me.roomId, me.peerId)) {
        deny('forbidden', 'Only the host can do that.');
        return respond({ ok: false, error: 'forbidden' });
      }

      const room = roomManager.getRoom(me.roomId);
      if (!room) return respond({ ok: false, error: 'no-room' });

      const targetPeerId = payload?.targetPeerId;
      const value = payload?.value;

      switch (action) {
        case 'set-locked': {
          const locked = roomManager.setLocked(me.roomId, value);
          io.to(roomChannel(me.roomId)).emit('room-state', roomStatePayload(room));
          return respond({ ok: true, locked });
        }
        case 'set-follow-host': {
          const followHost = roomManager.setFollowHost(me.roomId, value);
          io.to(roomChannel(me.roomId)).emit('room-state', roomStatePayload(room));
          return respond({ ok: true, followHost });
        }
        case 'end-room': {
          io.to(roomChannel(me.roomId)).emit('room-ended', { by: me.peerId, at: Date.now() });
          for (const peer of [...room.peers.values()]) {
            const s = io.sockets.sockets.get(peer.socketId);
            if (s && s.id !== socket.id) {
              handleDeparture(io, s, { silent: true });
              s.leave(roomChannel(me.roomId));
            }
          }
          handleDeparture(io, socket, { silent: true });
          return respond({ ok: true });
        }
        default:
          break;
      }

      // Everything below targets one specific peer in my room.
      if (typeof targetPeerId !== 'string' || !room.peers.has(targetPeerId)) {
        return respond({ ok: false, error: 'no-such-peer' });
      }
      if (targetPeerId === me.peerId && action !== 'lower-hand') {
        return respond({ ok: false, error: 'cannot-target-self' });
      }

      const targetSocketId = roomManager.findSocketIdInRoom(me.roomId, targetPeerId);

      switch (action) {
        case 'mute-audio':
        case 'mute-video': {
          const kind = action === 'mute-audio' ? 'audio' : 'video';
          if (kind === 'audio') roomManager.setMutedByHost(me.roomId, targetPeerId, true);
          // A host can force-mute but cannot force-unmute: unmuting someone's
          // microphone remotely is a privacy violation, so the target is asked
          // instead. Browsers cannot be made to publish audio without consent.
          if (targetSocketId) {
            io.to(targetSocketId).emit('moderated', { action, kind, by: me.peerId });
          }
          io.to(roomChannel(me.roomId)).emit('peer-updated', {
            peerId: targetPeerId,
            patch: kind === 'audio' ? { mutedByHost: true } : {},
          });
          return respond({ ok: true });
        }
        case 'kick': {
          if (targetSocketId) {
            const s = io.sockets.sockets.get(targetSocketId);
            io.to(targetSocketId).emit('kicked', { by: me.peerId, at: Date.now() });
            if (s) {
              handleDeparture(io, s, { reason: 'kicked' });
              s.leave(roomChannel(me.roomId));
            }
          } else {
            roomManager.leaveRoom(me.roomId, targetPeerId);
            io.to(roomChannel(me.roomId)).emit('peer-left', { peerId: targetPeerId });
          }
          return respond({ ok: true });
        }
        case 'grant-edit':
        case 'revoke-edit':
        case 'make-host': {
          const nextRole =
            action === 'make-host'
              ? ROLES.HOST
              : action === 'grant-edit'
                ? ROLES.EDITOR
                : ROLES.VIEWER;
          const peer = roomManager.setRole(me.roomId, targetPeerId, nextRole);
          if (!peer) return respond({ ok: false, error: 'no-such-peer' });
          // Hand back a refreshed token so the new role survives a reload or
          // reconnect instead of silently reverting.
          pushRole(io, me.roomId, peer, nextRole, { by: me.peerId });
          if (action === 'make-host') {
            // `setRole` transfers ownership, which demotes the previous owner.
            const self = room.peers.get(me.peerId);
            if (self && self.role !== ROLES.HOST) {
              pushRole(io, me.roomId, self, self.role, { by: me.peerId, reason: 'handed-over' });
            }
          }
          io.to(roomChannel(me.roomId)).emit('room-peers', {
            peers: roomManager.getRoomPeers(me.roomId),
          });
          io.to(roomChannel(me.roomId)).emit('room-state', roomStatePayload(room));
          return respond({ ok: true, role: nextRole });
        }
        case 'grant-tool':
        case 'revoke-tool': {
          const tool = typeof value === 'string' ? value : null;
          if (!tool || !GRANTABLE_TOOLS.includes(tool)) {
            return respond({ ok: false, error: 'unknown-tool' });
          }
          const allowed = action === 'grant-tool';
          const peer = roomManager.setToolAccess(me.roomId, targetPeerId, tool, allowed);
          if (!peer) return respond({ ok: false, error: 'no-such-peer' });
          if (targetSocketId) {
            io.to(targetSocketId).emit('tool-access', {
              tool,
              allowed,
              by: me.peerId,
              tools: { ...peer.tools },
            });
          }
          io.to(roomChannel(me.roomId)).emit('peer-updated', {
            peerId: targetPeerId,
            patch: { tools: { ...peer.tools } },
          });
          return respond({ ok: true, tool, allowed });
        }
        case 'lower-hand': {
          roomManager.setHandRaised(me.roomId, targetPeerId, false);
          io.to(roomChannel(me.roomId)).emit('peer-updated', {
            peerId: targetPeerId,
            patch: { handRaised: false },
          });
          return respond({ ok: true });
        }
        default:
          return respond({ ok: false, error: 'unknown-action' });
      }
    });

    // ------------------------------------------------------- waiting room ---

    socket.on('admit', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!guard(2)) return respond({ ok: false, error: 'rate-limited' });
      const me = identity();
      if (!me || !roomManager.isHost(me.roomId, me.peerId)) {
        return respond({ ok: false, error: 'forbidden' });
      }

      const targetPeerId = payload?.peerId;
      const entry = roomManager.getWaitingRoom(me.roomId).find((w) => w.peerId === targetPeerId);
      if (!entry) return respond({ ok: false, error: 'not-waiting' });

      const targetSocket = io.sockets.sockets.get(entry.socketId);
      roomManager.removeFromWaitingRoom(me.roomId, targetPeerId);

      if (!payload?.admit) {
        targetSocket?.emit('waiting-denied', { by: me.peerId });
        targetSocket?.leave(waitingChannel(me.roomId));
        emitToHosts(io, me.roomId, 'waiting-room', {
          waiting: roomManager.getWaitingRoom(me.roomId),
        });
        return respond({ ok: true, admitted: false });
      }

      if (!targetSocket?.data?.pending) return respond({ ok: false, error: 'gone' });

      const pending = targetSocket.data.pending;
      try { await docStore.ensureLoaded(pending.roomId); }
      catch { return respond({ ok: false, error: 'storage-unavailable' }); }
      const result = roomManager.joinRoom({
        roomId: pending.roomId,
        peerId: pending.peerId,
        socketId: targetSocket.id,
        displayName: pending.displayName,
        role: pending.role,
      });
      if (!result.ok) return respond({ ok: false, error: result.error });

      targetSocket.data.pending = null;
      targetSocket.leave(waitingChannel(me.roomId));
      await attachPeer(io, targetSocket, result);
      targetSocket.emit('waiting-approved', {
        roomId: pending.roomId,
        peerId: pending.peerId,
        role: result.peer.role,
        tools: { ...result.peer.tools },
        peers: roomManager.getRoomPeers(pending.roomId, { excludePeerId: pending.peerId }),
        room: roomStatePayload(result.room),
      });
      emitToHosts(io, me.roomId, 'waiting-room', {
        waiting: roomManager.getWaitingRoom(me.roomId),
      });
      return respond({ ok: true, admitted: true });
    });

    // ------------------------------------------------------ tool access ---

    /**
     * A non-host asking to use the whiteboard or the code editor.
     *
     * Deliberately not an `ephemeral` broadcast: the request has to reach the
     * hosts and nobody else, and the sender is stamped here rather than trusted
     * from the payload, so a guest cannot raise a request on someone else's
     * behalf and get *them* granted access.
     */
    socket.on('request-access', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!guard(2)) return respond({ ok: false, error: 'rate-limited' });
      const me = identity();
      if (!me) return respond({ ok: false, error: 'not-joined' });

      const tool = payload?.tool;
      if (typeof tool !== 'string' || !GRANTABLE_TOOLS.includes(tool)) {
        return respond({ ok: false, error: 'unknown-tool' });
      }
      if (roomManager.canUseTool(me.roomId, me.peerId, tool)) {
        return respond({ ok: true, alreadyAllowed: true });
      }

      const room = roomManager.getRoom(me.roomId);
      const peer = room?.peers.get(me.peerId);
      if (!peer) return respond({ ok: false, error: 'not-joined' });

      emitToHosts(io, me.roomId, 'access-request', {
        peerId: me.peerId,
        displayName: peer.displayName,
        tool,
        at: Date.now(),
      });
      return respond({ ok: true, pending: true });
    });

    // ------------------------------------------------------------ doc sync ---

    /**
     * The server is a durable relay for Yjs updates: it fans them out to the
     * room *and* appends them to the room's persistent log, so artifacts survive
     * everybody leaving. Updates stay opaque binary here — see doc-store.js.
     */
    socket.on('doc-update', (payload) => {
      if (!guard()) return;
      const me = identity();
      if (!me) return;
      // Viewers may not mutate shared artifacts.
      if (!roomManager.canEdit(me.roomId, me.peerId)) {
        return deny('read-only', 'You have view-only access to this room.');
      }

      const update = toBuffer(payload?.update);
      if (!update || update.length === 0) return;
      if (update.length > MAX_DOC_UPDATE_BYTES) return deny('too-large', 'Document update too large.');

      socket.to(roomChannel(me.roomId)).emit('doc-update', { from: me.peerId, update });

      const { needsCompaction } = docStore.appendUpdate(me.roomId, update);
      if (needsCompaction && !socket.data.compactionRequested) {
        socket.data.compactionRequested = true;
        socket.emit('doc-compact-request', {});
        setTimeout(() => {
          socket.data.compactionRequested = false;
        }, 30_000).unref?.();
      }
    });

    socket.on('doc-compact', (payload) => {
      if (!guard(3)) return;
      const me = identity();
      if (!me || !roomManager.canEdit(me.roomId, me.peerId)) return;
      const snapshot = toBuffer(payload?.snapshot);
      if (!snapshot) return;
      docStore.replaceWithSnapshot(me.roomId, snapshot);
    });

    socket.on('doc-resync', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!guard(3)) return respond({ ok: false });
      const me = identity();
      if (!me) return respond({ ok: false });
      try {
        await docStore.ensureLoaded(me.roomId);
        return respond({ ok: true, updates: docStore.getUpdates(me.roomId) });
      } catch { return respond({ ok: false, error: 'storage-unavailable' }); }
    });

    // ------------------------------------------------------------- leaving ---

    socket.on('leave-room', () => {
      handleDeparture(io, socket);
    });

    socket.on('disconnect', () => {
      handleDeparture(io, socket);
    });
  });
}
