'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalingClient } from '../lib/signaling';
import { PeerConnectionManager, CHANNELS, qualityLadderFor } from '../lib/webrtc';
import { fetchIceConfig } from '../constants/ice-servers';

/**
 * Wire the signaling socket, the WebRTC mesh and the CRDT document together.
 *
 * This replaces ~300 lines that lived inline in the room page and carried the
 * project's worst bugs: peers were connected by immediately calling
 * `createOffer` on both sides (guaranteed glare), moderation was a data-channel
 * message any participant could forge, and window layout was re-broadcast on
 * every drag frame as a full JSON array.
 *
 * The division of labour now:
 *   - signaling server  → identity, roles, moderation, durable doc storage
 *   - data channels     → cursors, reactions, CRDT deltas (low latency)
 *   - the CRDT document → anything that must survive a reload
 */
export function useRoomConnection({ roomId, session, provider, onEvent }) {
  const [connected, setConnected] = useState(false);
  const [transportNote, setTransportNote] = useState(null);
  const [peers, setPeers] = useState(new Map());
  const [remoteStreams, setRemoteStreams] = useState(new Map());
  const [roomState, setRoomState] = useState({
    hostPeerId: null,
    ownerPeerId: null,
    locked: false,
    followHost: false,
    waiting: [],
  });
  const [iceInfo, setIceInfo] = useState({ hasTurn: false, degraded: false });
  /**
   * How many peer connections have given up entirely this session.
   *
   * Counted here rather than derived from `peers`, because a failed peer is
   * removed from the roster on the same tick — so by the time a render could look
   * for `connectionState === 'failed'` there is nothing left to find. This is what
   * the room page uses to decide whether a missing TURN relay is worth mentioning.
   */
  const [relayFailures, setRelayFailures] = useState(0);
  /** Which shared tools this peer may open. Hosts bypass it entirely. */
  const [toolAccess, setToolAccess] = useState({ whiteboard: false, code: false });

  const signalingRef = useRef(null);
  const meshRef = useRef(null);
  const localStreamRef = useRef(null);
  const onEventRef = useRef(onEvent);
  // Latest-ref, written in an effect rather than during render: the callers pass
  // a fresh closure every render, and a render-phase ref write is not guaranteed
  // to happen once.
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const emit = useCallback((type, payload) => {
    onEventRef.current?.({ type, ...payload });
  }, []);

  const peerId = session?.peerId || null;
  const sessionToken = session?.sessionToken || null;

  /**
   * The token is held in a ref, deliberately *not* in the effect's dependency
   * list.
   *
   * Keying the connection on it is what turned a role change into a full
   * teardown — `leaveRoom()`, `disconnect()`, `mesh.destroy()` — followed by a
   * fresh join. Refresh a tab three or four times and the resulting storm of
   * rebuilds left the room stuck on "Connecting…", because each new socket was
   * torn down mid-handshake and the 10s join ack expired. The token only ever
   * needs to reach the socket for the *next* re-join, which is exactly what
   * `updateSessionToken` is for.
   */
  const sessionTokenRef = useRef(sessionToken);
  useEffect(() => {
    sessionTokenRef.current = sessionToken;
    if (sessionToken) signalingRef.current?.updateSessionToken(sessionToken);
  }, [sessionToken]);

  // Only the *existence* of a token gates the connection, so the first token
  // starts the socket and every later one is handed over in place.
  const hasSession = Boolean(sessionToken);

  /* ---------------------------------------------------------------------- */
  /* Mesh + socket lifetime. Keyed on the identity, so a role change or a     */
  /* re-render never tears the call down.                                    */
  /* ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!roomId || !peerId || !hasSession || !provider) return undefined;

    let cancelled = false;
    const signaling = new SignalingClient();
    const mesh = new PeerConnectionManager({ localPeerId: peerId });
    signalingRef.current = signaling;
    meshRef.current = mesh;
    // Media may have been acquired before this effect ran (or before a
    // reconnect rebuilt the mesh); re-publish rather than starting muted.
    if (localStreamRef.current) mesh.setLocalStream(localStreamRef.current);

    const patchPeer = (id, patch) =>
      setPeers((prev) => {
        const existing = prev.get(id);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(id, { ...existing, ...patch });
        return next;
      });

    const forgetPeer = (id) => {
      mesh.closePeer(id);
      provider.dropPeer(id);
      setPeers((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setRemoteStreams((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    };

    /* ------------------------------ mesh → app ---------------------------- */

    mesh.onDescription = (to, description) => {
      // Perfect negotiation produces both offers and answers from the same
      // callback; the server keeps them on separate events.
      if (description?.type === 'answer') signaling.sendAnswer(to, description);
      else signaling.sendOffer(to, description);
    };
    mesh.onIceCandidate = (to, candidate) => signaling.sendIceCandidate(to, candidate);

    mesh.onRemoteStream = (id, stream) =>
      setRemoteStreams((prev) => {
        if (prev.get(id) === stream) return prev;
        const next = new Map(prev);
        next.set(id, stream);
        return next;
      });

    // The transport's own answer to "is their camera actually on". It does not
    // depend on the peer announcing anything, so a tile stops guessing from a
    // presence frame that may never arrive.
    mesh.onRemoteTrackState = (id, kind, live) =>
      patchPeer(id, kind === 'video' ? { videoLive: live } : { audioLive: live });

    mesh.onConnectionStateChange = (id, state) => {
      patchPeer(id, { connectionState: state });
      // Only terminal states remove a tile. 'disconnected' is usually a
      // transient ICE blip that restartIce recovers from; tearing down there is
      // what made tiles flicker.
      if (state === 'failed') setRelayFailures((prev) => prev + 1);
      if (state === 'failed' || state === 'closed') forgetPeer(id);
    };

    mesh.onQualityUpdate = (id, info) => {
      if (info.changed || info.muted !== undefined) patchPeer(id, { quality: info.quality, ...info });
    };

    mesh.onChannelOpen = (id, label) => {
      if (label === CHANNELS.sync.label) provider.syncWithPeer(id);
    };

    mesh.onChannelMessage = (id, label, data) => {
      if (label === CHANNELS.sync.label) {
        provider.receiveFromPeer(id, data);
        return;
      }
      // The lossy channel carries presence: awareness frames and reactions.
      provider.receiveFromPeer(id, data);
    };

    /* --------------------------- provider transports ---------------------- */

    // Via `setTransport`, not by assigning to the provider's fields: `provider`
    // is a hook argument, and the compiler is free to assume arguments are not
    // mutated. The returned function unwires exactly these three.
    const unwireTransport = provider.setTransport({
      sendToPeer: (id, bytes) => mesh.send(id, CHANNELS.sync.label, bytes),
      broadcastToPeers: (bytes) => mesh.broadcast(CHANNELS.sync.label, bytes),
      // The server copy is what makes the room persistent; it is also the only
      // path to a peer whose data channel has not opened yet.
      sendToServer: (update) => signaling.sendDocUpdate(update),
    });

    /* ------------------------------ signaling ----------------------------- */

    signaling.on('connection', ({ connected: isUp, error, transport }) => {
      if (cancelled) return;
      setConnected(isUp);
      if (error) setTransportNote(error);
      else if (isUp) setTransportNote(transport ? `via ${transport}` : null);
    });

    signaling.on('error-notice', ({ code, message }) => {
      if (code === 'read-only') return; // The UI already shows a read-only state.
      emit('notice', { message: message || code });
    });

    signaling.on('room-state', (state) => {
      if (cancelled) return;
      setRoomState((prev) => ({ ...prev, ...state, waiting: state.waiting ?? prev.waiting }));
    });

    signaling.on('room-peers', ({ peers: list = [] }) => {
      if (cancelled) return;
      setPeers(() => {
        const next = new Map();
        for (const peer of list) {
          if (peer.peerId === peerId) continue;
          next.set(peer.peerId, { ...peer, quality: 'good' });
        }
        return next;
      });

      // Just create the connection. Adding local tracks fires
      // `onnegotiationneeded`, and perfect negotiation resolves the resulting
      // simultaneous offers — so there is no need for one side to "win" the
      // right to offer, which is what the old explicit createOffer-on-both-sides
      // dance got wrong.
      for (const peer of list) {
        if (peer.peerId === peerId) continue;
        mesh.ensurePeer(peer.peerId);
      }
      mesh.applyQualityLadder(list.length);
    });

    signaling.on('peer-joined', ({ peer, isReconnect }) => {
      if (cancelled || !peer || peer.peerId === peerId) return;
      setPeers((prev) => new Map(prev).set(peer.peerId, { ...peer, quality: 'good' }));
      mesh.ensurePeer(peer.peerId);
      mesh.applyQualityLadder(mesh.peers.size + 1);
      if (!isReconnect) emit('peer-joined', { peer });
    });

    signaling.on('peer-updated', ({ peerId: id, patch }) => {
      if (id === peerId) return;
      patchPeer(id, patch || {});
    });

    signaling.on('peer-left', ({ peerId: id, reason }) => {
      if (!id) return;
      // Read the name out of the setter rather than the render closure, which
      // would be a stale snapshot from whenever this effect ran.
      let departingName;
      setPeers((prev) => {
        departingName = prev.get(id)?.displayName;
        return prev;
      });
      forgetPeer(id);
      mesh.applyQualityLadder(Math.max(1, mesh.peers.size + 1));
      emit('peer-left', { peerId: id, reason, displayName: departingName });
    });

    signaling.on('sdp-offer', ({ from, sdp }) => mesh.handleDescription(from, sdp));
    signaling.on('sdp-answer', ({ from, sdp }) => mesh.handleDescription(from, sdp));
    signaling.on('ice-candidate', ({ from, candidate }) => mesh.handleCandidate(from, candidate));

    /* ------------------------- roles and moderation ----------------------- */

    signaling.on('role-changed', ({ role, by, sessionToken: refreshed }) => {
      // The server re-issues the token so the new role survives a reload. This
      // no longer recycles the socket: the token goes straight into the client.
      signaling.updateSessionToken(refreshed);
      sessionTokenRef.current = refreshed || sessionTokenRef.current;
      emit('role-changed', { role, by, sessionToken: refreshed });
    });

    signaling.on('tool-access', ({ tool, allowed, by, tools }) => {
      if (cancelled) return;
      setToolAccess((prev) => ({ ...prev, ...(tools || { [tool]: allowed }) }));
      emit('tool-access', { tool, allowed, by });
    });

    signaling.on('access-request', (payload) => {
      if (cancelled || !payload) return;
      emit('access-request', payload);
    });

    signaling.on('moderated', ({ action, kind, by }) => emit('moderated', { action, kind, by }));
    signaling.on('kicked', ({ by }) => emit('kicked', { by }));
    signaling.on('room-ended', ({ by }) => emit('room-ended', { by }));
    signaling.on('artifacts-cleared', ({ by }) => emit('artifacts-cleared', { by }));

    signaling.on('waiting-room', ({ waiting }) =>
      setRoomState((prev) => ({ ...prev, waiting: waiting || [] }))
    );
    signaling.on('waiting-approved', (payload) => {
      if (cancelled) return;
      // Admission is a join: the peer list and room state arrive with the
      // approval, and the mesh has to be built from them. Emitting the event
      // without doing this left an admitted guest staring at an empty room.
      const list = payload?.peers || [];
      setPeers(() => {
        const next = new Map();
        for (const peer of list) {
          if (peer.peerId === peerId) continue;
          next.set(peer.peerId, { ...peer, quality: 'good' });
        }
        return next;
      });
      for (const peer of list) {
        if (peer.peerId !== peerId) mesh.ensurePeer(peer.peerId);
      }
      mesh.applyQualityLadder(list.length + 1);
      if (payload?.room) setRoomState((prev) => ({ ...prev, ...payload.room }));
      if (payload?.tools) setToolAccess((prev) => ({ ...prev, ...payload.tools }));
      emit('waiting-approved', payload);
    });
    signaling.on('waiting-denied', ({ by }) => emit('waiting-denied', { by }));

    /* ---------------------------- ephemeral presence ---------------------- */

    signaling.on('ephemeral', (payload) => {
      if (!payload || payload.from === peerId) return;
      // `kind`, not `type`: `emit` spreads the payload over `{ type }`, so a
      // payload carrying its own `type` overwrote the event name and every
      // presence frame — mic state, reactions, typing — fell through the page's
      // switch into `default` and vanished.
      emit('ephemeral', { from: payload.from, kind: payload.type, data: payload.data });
    });

    /* ------------------------------- documents ---------------------------- */

    signaling.on('doc-snapshot', ({ updates, seq }) => {
      // This is the persistence payoff: everything the room ever contained,
      // restored before the first frame of video arrives.
      const applied = provider.applyServerSnapshot(updates);
      if (applied > 0) emit('artifacts-restored', { updates: applied, seq });
    });

    signaling.on('doc-update', ({ from, update }) => {
      if (from === peerId) return;
      provider.receiveFromServer(update);
    });

    signaling.on('doc-compact-request', () => {
      // The server cannot compact its own log — it has no CRDT — so it asks a
      // client for a merged snapshot and collapses onto that.
      signaling.sendDocSnapshot(provider.snapshot());
    });

    /* -------------------------------- start ------------------------------- */

    (async () => {
      // TURN credentials are short-lived, so the list is fetched per session
      // rather than baked into the bundle.
      try {
        const ice = await fetchIceConfig();
        if (cancelled) return;
        setIceInfo({ hasTurn: ice.hasTurn, degraded: ice.degraded });
        mesh.setIceConfig({ iceServers: ice.iceServers });
        // Deliberately no notice here. A missing TURN relay is not a problem
        // until a connection actually fails, and on a LAN it never does — the
        // banner used to fire on every call and scare people off a working room.
        // The room page raises it from a real `connectionState === 'failed'`.
      } catch {
        /* fetchIceConfig already falls back to STUN. */
      }

      if (cancelled) return;
      signaling.connect();
      const result = await signaling.joinRoom(sessionTokenRef.current);
      if (cancelled) return;
      if (!result?.ok) {
        emit('join-failed', { error: result?.error || 'join-failed' });
        return;
      }
      // A locked room answers 'waiting', and the page has to render a lobby
      // rather than an empty call. The old code dropped this field, so someone
      // held in the waiting room saw a room that simply never populated.
      if (result.status === 'waiting') {
        emit('waiting', { roomId: result.roomId });
        return;
      }
      if (result.room) setRoomState((prev) => ({ ...prev, ...result.room }));
      if (result.waiting) setRoomState((prev) => ({ ...prev, waiting: result.waiting }));
      if (result.tools) setToolAccess((prev) => ({ ...prev, ...result.tools }));
      emit('joined', { role: result.role, isOwner: result.isOwner });
    })();

    return () => {
      cancelled = true;
      unwireTransport();
      signaling.leaveRoom();
      signaling.disconnect();
      mesh.destroy();
      signalingRef.current = null;
      meshRef.current = null;
    };
  }, [roomId, peerId, hasSession, provider, emit]);

  /** Publish the local stream to every peer (and to peers joining later). */
  const publishStream = useCallback((stream) => {
    localStreamRef.current = stream || null;
    meshRef.current?.setLocalStream(stream);
  }, []);

  /** Screen share and camera-return both go through here — no renegotiation. */
  const replaceVideoTrack = useCallback((track) => {
    const mesh = meshRef.current;
    if (!mesh) return Promise.resolve(0);
    return mesh.replaceVideoTrack(track);
  }, []);

  const sendEphemeral = useCallback((type, data) => {
    signalingRef.current?.sendEphemeral(type, data);
  }, []);

  const moderate = useCallback(
    (action, targetPeerId, value) =>
      signalingRef.current?.moderate(action, targetPeerId, value) ??
      Promise.resolve({ ok: false, error: 'not-connected' }),
    []
  );

  const admit = useCallback(
    (targetPeerId, allow) =>
      signalingRef.current?.admit(targetPeerId, allow) ??
      Promise.resolve({ ok: false, error: 'not-connected' }),
    []
  );

  const raiseHand = useCallback((raised) => signalingRef.current?.raiseHand(raised), []);
  const rename = useCallback((name) => signalingRef.current?.rename(name), []);
  const leave = useCallback(() => signalingRef.current?.leaveRoom(), []);

  const requestAccess = useCallback(
    (tool) =>
      signalingRef.current?.requestAccess(tool) ??
      Promise.resolve({ ok: false, error: 'not-connected' }),
    []
  );

  /** Re-request the durable document, e.g. after a long disconnection. */
  const resync = useCallback(async () => {
    const result = await signalingRef.current?.resyncDoc();
    return result?.ok ?? false;
  }, []);

  /* Keep encodings matched to room size: mesh upload cost is O(n²), so the
     bitrate that is fine for two people saturates an uplink at six. */
  useEffect(() => {
    meshRef.current?.applyQualityLadder(peers.size + 1);
  }, [peers.size]);

  /**
   * The creator, and nobody else, wears the Host badge — `ownerPeerId` is
   * server-owned and no longer moves when somebody reloads.
   */
  const isOwner = Boolean(peerId) && roomState.ownerPeerId === peerId;
  /**
   * Who may *moderate*. The owner, plus anyone holding a host credential (a
   * deliberately invited co-host, or the acting host of a room no creator has
   * ever claimed).
   */
  const isHost =
    Boolean(peerId) && (isOwner || roomState.hostPeerId === peerId || session?.role === 'host');

  return {
    connected,
    transportNote,
    peers,
    remoteStreams,
    roomState,
    isHost,
    isOwner,
    toolAccess,
    iceInfo,
    relayFailures,
    qualityTarget: qualityLadderFor(peers.size + 1),
    publishStream,
    replaceVideoTrack,
    sendEphemeral,
    moderate,
    admit,
    requestAccess,
    raiseHand,
    rename,
    resync,
    leave,
  };
}
