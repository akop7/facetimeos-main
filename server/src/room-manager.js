import { ROLES, roleAtLeast, sanitizeDisplayName } from './auth.js';
import { MAX_PEERS_PER_ROOM } from './config.js';

/**
 * Authoritative room state.
 *
 * The important change from the previous version: a room no longer stores a
 * client-generated `hostToken` and no longer decides who the host is by
 * comparing opaque strings the browser sent. Roles arrive already verified
 * (they are claims inside a server-signed session token), and this module is
 * the single place that answers "may this peer do that?".
 */

/** Shared artifacts a non-host has to be granted access to, one at a time. */
export const GRANTABLE_TOOLS = Object.freeze(['whiteboard', 'code']);

const blankTools = () => ({ whiteboard: false, code: false });

/**
 * "Alok's room", but "Chris' room" — a name already ending in s does not take a
 * second one.
 */
function roomTitleFor(displayName) {
  const name = (displayName || '').trim();
  if (!name) return null;
  return `${name}${/s$/i.test(name) ? "'" : "'s"} room`;
}

class Room {
  constructor(id) {
    this.id = id;
    this.createdAt = Date.now();
    /**
     * Null, not the string 'Untitled room'.
     *
     * Only `POST /rooms` ever passed a title, and rooms live in memory — so a
     * host link opened after a server restart, or any link opened by somebody
     * who never hit the create endpoint, resurrected the room through
     * `joinRoom` and inherited this default. That is the "Untitled room" the
     * header was showing: not a room nobody had named, a name that was lost.
     * An absent title is now absent, and `joinRoom` derives one from whoever is
     * in charge.
     */
    this.title = null;
    /** @type {Map<string, PeerRecord>} */
    this.peers = new Map();
    /** Primary host, for display and for "who do we ask to compact the doc". */
    this.hostPeerId = null;
    /**
     * The creator: whoever first presented a host invite token for this room.
     *
     * Its absence is what made the host badge jump between participants. The
     * host's socket drops for the second a reload takes, `hasLiveHost()` goes
     * false, and `_electHost` handed the room to the longest-present peer with a
     * freshly signed HOST token — permanently, because the returning creator
     * found `hostPeerId` already taken. Reserving the slot for the owner means a
     * reload changes nothing, and nobody is promoted behind their back.
     */
    this.ownerPeerId = null;
    /** When true, non-host joins land in the waiting room. */
    this.locked = false;
    /** @type {Map<string, {peerId: string, displayName: string, socketId: string, at: number}>} */
    this.waiting = new Map();
    /** Everyone-follows-the-host layout mode. */
    this.followHost = false;
    this.lastActivity = Date.now();
  }

  get size() {
    return this.peers.size;
  }

  hasLiveHost() {
    for (const peer of this.peers.values()) {
      if (peer.role === ROLES.HOST) return true;
    }
    return false;
  }
}

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  createRoom(roomId, { title } = {}) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    if (title) room.title = sanitizeDisplayName(title, room.title);
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  roomExists(roomId) {
    return this.rooms.has(roomId);
  }

  /**
   * Add (or re-attach) a peer.
   *
   * @returns {{ok: true, room: Room, peer: object, isReconnect: boolean,
   *            previousSocketId: string|null, role: string, roleChanged: boolean,
   *            isOwner: boolean, demoted: string[]}
   *          | {ok: false, error: string}}
   */
  joinRoom({ roomId, peerId, socketId, displayName, role }) {
    const room = this.createRoom(roomId);
    const existing = room.peers.get(peerId);

    if (!existing && room.size >= MAX_PEERS_PER_ROOM) {
      return { ok: false, error: 'room-full' };
    }

    const previousSocketId = existing?.socketId && existing.socketId !== socketId
      ? existing.socketId
      : null;

    let effectiveRole = role;
    if (!roleAtLeast(effectiveRole, ROLES.VIEWER)) effectiveRole = ROLES.VIEWER;

    const peer = {
      peerId,
      socketId,
      displayName: sanitizeDisplayName(displayName, existing?.displayName || 'Guest'),
      role: effectiveRole,
      // Preserved across reconnects so host election stays deterministic.
      joinedAt: existing?.joinedAt ?? Date.now(),
      handRaised: existing?.handRaised ?? false,
      mutedByHost: existing?.mutedByHost ?? false,
      /** Per-tool grants, so a guest keeps whiteboard access through a reload. */
      tools: existing?.tools ?? blankTools(),
      /**
       * True only for a peer the *server* promoted because the room had nobody
       * in charge. It is the flag that lets the real creator take the room back
       * without also demoting a co-host the creator invited on purpose.
       */
      actingHost: existing?.actingHost ?? false,
      lastSeen: Date.now(),
    };

    room.peers.set(peerId, peer);
    room.waiting.delete(peerId);
    room.lastActivity = Date.now();

    /* ----------------------------- ownership ------------------------------ */

    const demoted = [];
    let isOwner = room.ownerPeerId === peerId;

    if (effectiveRole === ROLES.HOST) {
      // Presenting a host credential claims the room when it is unclaimed, or
      // reclaims it when the recorded owner is no longer here (the creator lost
      // their tab-scoped session and came back through the host link).
      const ownerElsewhere =
        room.ownerPeerId && room.ownerPeerId !== peerId && room.peers.has(room.ownerPeerId);
      if (!ownerElsewhere) {
        room.ownerPeerId = peerId;
        room.hostPeerId = peerId;
        peer.actingHost = false;
        isOwner = true;
        // Anyone the server had put in charge in the creator's absence goes back
        // to being an editor. Without this the room would carry two HOST roles
        // and the badge would depend on render order.
        for (const other of room.peers.values()) {
          if (other.peerId !== peerId && other.actingHost) {
            other.role = ROLES.EDITOR;
            other.actingHost = false;
            demoted.push(other.peerId);
          }
        }
      }
      // Otherwise this is a co-host: full host powers, but the primary slot and
      // the Host badge stay with the creator.
    }

    if (isOwner) room.hostPeerId = peerId;
    else if (!room.hostPeerId && !room.ownerPeerId && !room.hasLiveHost()) {
      // No creator has ever claimed this room, so somebody has to be able to
      // moderate it. This is the only path that hands out an acting host.
      this._electHost(room);
    }

    /* -------------------------------- naming ------------------------------ */

    // A room reached by link has no title, and the header has to print
    // something. Name it after whoever is in charge — the same string the create
    // endpoint builds — so the answer is the person, not a placeholder or a
    // slice of a uuid. Set once: a room that already has a name keeps it.
    if (!room.title) {
      const namer = room.peers.get(room.hostPeerId) || peer;
      room.title = roomTitleFor(namer.displayName);
    }

    return {
      ok: true,
      room,
      peer,
      isReconnect: Boolean(existing),
      previousSocketId,
      role: peer.role,
      roleChanged: existing ? existing.role !== peer.role : false,
      isOwner,
      demoted,
    };
  }

  /**
   * @returns {{room: Room|null, removed: object|null, newHostPeerId: string|null, roomClosed: boolean}}
   */
  leaveRoom(roomId, peerId, socketId = null) {
    const room = this.rooms.get(roomId);
    if (!room) return { room: null, removed: null, newHostPeerId: null, roomClosed: false };

    const peer = room.peers.get(peerId);
    if (!peer) return { room, removed: null, newHostPeerId: null, roomClosed: false };

    // Guard against a stale socket removing a peer that already reconnected on
    // a newer socket.
    if (socketId && peer.socketId !== socketId) {
      return { room, removed: null, newHostPeerId: null, roomClosed: false };
    }

    room.peers.delete(peerId);
    room.waiting.delete(peerId);
    room.lastActivity = Date.now();

    let newHostPeerId = null;
    if (room.hostPeerId === peerId) room.hostPeerId = null;

    if (room.ownerPeerId) {
      // The creator's seat is reserved. A reload takes their socket down for a
      // moment; promoting somebody else in that window is exactly the bug where
      // the Host badge jumped to another participant and stayed there. If the
      // creator is simply gone, the room runs without a host until they return.
      if (room.ownerPeerId !== peerId && room.peers.has(room.ownerPeerId)) {
        room.hostPeerId = room.ownerPeerId;
      }
    } else if (!room.hasLiveHost() && room.size > 0) {
      newHostPeerId = this._electHost(room);
    } else if (!room.hostPeerId && room.size > 0) {
      for (const [id, p] of room.peers) {
        if (p.role === ROLES.HOST) {
          room.hostPeerId = id;
          break;
        }
      }
    }

    const roomClosed = room.size === 0;
    if (roomClosed) {
      // Drop the live room, but leave the persisted artifacts alone: re-entering
      // the same link later restores the work.
      this.rooms.delete(roomId);
    }

    return { room, removed: peer, newHostPeerId, roomClosed };
  }

  /** Promote the longest-present peer. @returns {string|null} the new host id */
  _electHost(room) {
    let candidate = null;
    for (const peer of room.peers.values()) {
      if (!candidate || peer.joinedAt < candidate.joinedAt) candidate = peer;
    }
    if (!candidate) {
      room.hostPeerId = null;
      return null;
    }
    candidate.role = ROLES.HOST;
    candidate.actingHost = true;
    room.hostPeerId = candidate.peerId;
    return candidate.peerId;
  }

  setRole(roomId, peerId, role) {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(peerId);
    if (!peer) return null;
    peer.role = role;
    room.lastActivity = Date.now();
    if (role === ROLES.HOST) {
      // A deliberate hand-over transfers the room itself, otherwise the creator
      // could pass the crown and then take it back on their next reload.
      peer.actingHost = false;
      room.ownerPeerId = peerId;
      room.hostPeerId = peerId;
      for (const other of room.peers.values()) {
        if (other.peerId !== peerId && other.role === ROLES.HOST) {
          other.role = ROLES.EDITOR;
          other.actingHost = false;
        }
      }
    } else if (room.hostPeerId === peerId) {
      room.hostPeerId = null;
      if (room.ownerPeerId === peerId) room.ownerPeerId = null;
      if (!room.hasLiveHost() && !room.ownerPeerId) this._electHost(room);
    }
    return peer;
  }

  /**
   * Grant or revoke one shared tool for one peer.
   *
   * @returns {object|null} the updated peer record
   */
  setToolAccess(roomId, peerId, tool, allowed) {
    if (!GRANTABLE_TOOLS.includes(tool)) return null;
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(peerId);
    if (!peer) return null;
    peer.tools = { ...peer.tools, [tool]: Boolean(allowed) };
    room.lastActivity = Date.now();
    return peer;
  }

  /** Hosts always may; everyone else needs an explicit grant. */
  canUseTool(roomId, peerId, tool) {
    const peer = this.rooms.get(roomId)?.peers.get(peerId);
    if (!peer) return false;
    if (peer.role === ROLES.HOST) return true;
    return Boolean(peer.tools?.[tool]);
  }

  isOwner(roomId, peerId) {
    return this.rooms.get(roomId)?.ownerPeerId === peerId;
  }

  isHost(roomId, peerId) {
    const peer = this.rooms.get(roomId)?.peers.get(peerId);
    return peer?.role === ROLES.HOST;
  }

  canEdit(roomId, peerId) {
    const peer = this.rooms.get(roomId)?.peers.get(peerId);
    return Boolean(peer) && roleAtLeast(peer.role, ROLES.EDITOR);
  }

  setHandRaised(roomId, peerId, raised) {
    const peer = this.rooms.get(roomId)?.peers.get(peerId);
    if (!peer) return null;
    peer.handRaised = Boolean(raised);
    return peer;
  }

  setMutedByHost(roomId, peerId, muted) {
    const peer = this.rooms.get(roomId)?.peers.get(peerId);
    if (!peer) return null;
    peer.mutedByHost = Boolean(muted);
    return peer;
  }

  setLocked(roomId, locked) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.locked = Boolean(locked);
    if (!room.locked) room.waiting.clear();
    return room.locked;
  }

  setFollowHost(roomId, follow) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.followHost = Boolean(follow);
    return room.followHost;
  }

  addToWaitingRoom(roomId, { peerId, displayName, socketId }) {
    const room = this.createRoom(roomId);
    room.waiting.set(peerId, {
      peerId,
      displayName: sanitizeDisplayName(displayName),
      socketId,
      at: Date.now(),
    });
    return [...room.waiting.values()];
  }

  removeFromWaitingRoom(roomId, peerId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    room.waiting.delete(peerId);
    return [...room.waiting.values()];
  }

  getWaitingRoom(roomId) {
    const room = this.rooms.get(roomId);
    return room ? [...room.waiting.values()] : [];
  }

  /** Public shape of the peer list, minus socket ids. */
  getRoomPeers(roomId, { excludePeerId = null } = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const peers = [];
    for (const peer of room.peers.values()) {
      if (peer.peerId === excludePeerId) continue;
      peers.push({
        peerId: peer.peerId,
        displayName: peer.displayName,
        role: peer.role,
        joinedAt: peer.joinedAt,
        handRaised: peer.handRaised,
        mutedByHost: peer.mutedByHost,
        tools: { ...peer.tools },
        isOwner: peer.peerId === room.ownerPeerId,
      });
    }
    return peers.sort((a, b) => a.joinedAt - b.joinedAt);
  }

  isPeerInRoom(roomId, peerId) {
    return Boolean(this.rooms.get(roomId)?.peers.has(peerId));
  }

  /**
   * Resolve a peerId to a socket id **within one room**.
   *
   * The previous implementation iterated every room in the process, so a peer in
   * room A could address a peer in room B purely by guessing an id — a
   * cross-room signaling leak. Scoping the lookup closes it.
   */
  findSocketIdInRoom(roomId, peerId) {
    const peer = this.rooms.get(roomId)?.peers.get(peerId);
    return peer ? peer.socketId : null;
  }

  /** @returns {Array<{roomId: string, peerId: string}>} */
  findBySocketId(socketId) {
    const found = [];
    for (const room of this.rooms.values()) {
      for (const peer of room.peers.values()) {
        if (peer.socketId === socketId) found.push({ roomId: room.id, peerId: peer.peerId });
      }
    }
    return found;
  }

  removeSocketFromAllRooms(socketId) {
    const results = [];
    for (const { roomId, peerId } of this.findBySocketId(socketId)) {
      results.push({ roomId, peerId, ...this.leaveRoom(roomId, peerId, socketId) });
    }
    return results;
  }

  stats() {
    let peers = 0;
    for (const room of this.rooms.values()) peers += room.size;
    return { rooms: this.rooms.size, peers };
  }

  /** Test seam. */
  _reset() {
    this.rooms.clear();
  }
}

export const roomManager = new RoomManager();
export { RoomManager, Room };
