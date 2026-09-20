'use client';

/**
 * WebRTC mesh with "perfect negotiation".
 *
 * The previous implementation could not renegotiate at all: `handleOffer` tore
 * the connection down whenever a remote description already existed (so screen
 * sharing was impossible), and it bailed out of any offer that arrived while the
 * signaling state was not stable — with no rollback and no retry, so two peers
 * offering at the same moment (glare) deadlocked permanently.
 *
 * This version follows the W3C perfect-negotiation pattern: each pair has a
 * deterministic polite/impolite side, the impolite side ignores colliding
 * offers, the polite side rolls back, and `onnegotiationneeded` drives
 * renegotiation so adding or replacing tracks mid-call just works.
 */

/** Both peers create these with the same ids, so there is no ondatachannel race. */
export const CHANNELS = Object.freeze({
  /** Cursors, reactions, presence pings. Lossy on purpose — stale is useless. */
  fast: { id: 0, label: 'fast', options: { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 } },
  /** Yjs updates. Must be reliable and ordered or the CRDT log has holes. */
  sync: { id: 1, label: 'sync', options: { negotiated: true, id: 1, ordered: true } },
});

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Mesh bandwidth grows as O(n²): every peer uploads its stream to every other
 * peer. Stepping resolution and bitrate down as the room fills is what keeps a
 * 6-person call usable on a normal uplink instead of collapsing.
 */
export function qualityLadderFor(peerCount) {
  if (peerCount <= 1) return { scaleResolutionDownBy: 1, maxBitrate: 1_200_000, maxFramerate: 30 };
  if (peerCount <= 3) return { scaleResolutionDownBy: 1, maxBitrate: 800_000, maxFramerate: 30 };
  if (peerCount <= 5) return { scaleResolutionDownBy: 1.5, maxBitrate: 500_000, maxFramerate: 24 };
  if (peerCount <= 8) return { scaleResolutionDownBy: 2, maxBitrate: 300_000, maxFramerate: 20 };
  return { scaleResolutionDownBy: 3, maxBitrate: 180_000, maxFramerate: 15 };
}

export function scoreConnection({ rtt = 0, packetLoss = 0, bitrate = 0 }) {
  if (rtt > 0.4 || packetLoss > 0.08) return 'poor';
  if (rtt > 0.2 || packetLoss > 0.03 || (bitrate > 0 && bitrate < 80_000)) return 'fair';
  return 'good';
}

export class PeerConnectionManager {
  constructor({ localPeerId, iceServers = DEFAULT_ICE, iceTransportPolicy = 'all' } = {}) {
    if (!localPeerId) throw new Error('PeerConnectionManager requires localPeerId');

    this.localPeerId = localPeerId;
    this.iceServers = iceServers;
    this.iceTransportPolicy = iceTransportPolicy;

    /** @type {Map<string, PeerEntry>} */
    this.peers = new Map();
    this.localStream = null;
    this.destroyed = false;

    // Callbacks — assigned by the caller.
    this.onRemoteStream = null;
    this.onRemoteStreamEnded = null;
    /** `(peerId, kind, live)` — a remote track started or stopped carrying media. */
    this.onRemoteTrackState = null;
    this.onIceCandidate = null;
    this.onDescription = null;
    this.onConnectionStateChange = null;
    this.onChannelMessage = null;
    this.onChannelOpen = null;
    this.onQualityUpdate = null;
  }

  /**
   * Deterministic tie-break for glare. Both sides compute the same answer from
   * ids alone, with no extra signaling round trip.
   */
  isPolite(remotePeerId) {
    return this.localPeerId < remotePeerId;
  }

  setIceConfig({ iceServers, iceTransportPolicy }) {
    if (iceServers) this.iceServers = iceServers;
    if (iceTransportPolicy) this.iceTransportPolicy = iceTransportPolicy;
    // Existing connections pick the new config up on their next ICE restart.
    for (const peer of this.peers.values()) {
      try {
        peer.pc.setConfiguration({
          iceServers: this.iceServers,
          iceTransportPolicy: this.iceTransportPolicy,
        });
      } catch {
        /* Older browsers cannot reconfigure mid-call; harmless. */
      }
    }
  }

  /**
   * Get or create the connection to a peer. Idempotent: calling it twice
   * returns the same connection instead of destroying a live one, which is what
   * previously killed screen sharing.
   */
  ensurePeer(remotePeerId) {
    if (this.destroyed) return null;
    const existing = this.peers.get(remotePeerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: this.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    /** @type {PeerEntry} */
    const peer = {
      peerId: remotePeerId,
      pc,
      polite: this.isPolite(remotePeerId),
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      /** Candidates that arrived before a remote description existed. */
      pendingCandidates: [],
      remoteStream: new MediaStream(),
      senders: new Map(),
      channels: new Map(),
      quality: 'good',
      statsTimer: null,
      lastStats: null,
    };
    this.peers.set(remotePeerId, peer);

    /**
     * Create the audio and video slots *before* anything is negotiated, in the
     * same order on both sides.
     *
     * This is the fix for "one person's camera never shows up". Previously the
     * m-lines were whatever `addTrack` happened to produce, so a peer who joined
     * without a camera offered audio only — and when that offer won the glare
     * tie-break, the answering side had nowhere to put its video. An answer
     * cannot invent an m-line, so the camera stayed unsent until some later
     * renegotiation that often never came. Pre-declaring both directions makes
     * the shape of the session identical for everyone: whoever has a camera
     * fills the slot with `replaceTrack`, and whoever does not leaves it empty
     * without changing the SDP.
     */
    for (const kind of ['audio', 'video']) {
      try {
        const transceiver = pc.addTransceiver(kind, { direction: 'sendrecv' });
        peer.senders.set(kind, transceiver.sender);
      } catch (err) {
        console.warn(`[webrtc] addTransceiver(${kind}) failed:`, err?.message);
      }
    }

    this._wireNegotiation(peer);
    this._wireIce(peer);
    this._wireTracks(peer);
    this._openChannels(peer);
    this._startStats(peer);

    if (this.localStream) this._attachStream(peer, this.localStream);

    return peer;
  }

  _wireNegotiation(peer) {
    const { pc, peerId } = peer;

    // Every track add / replace / removal funnels through here, so
    // renegotiation is automatic instead of something the caller must remember.
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.onDescription?.(peerId, pc.localDescription);
      } catch (err) {
        console.warn(`[webrtc] negotiation failed for ${peerId}:`, err?.message);
      } finally {
        peer.makingOffer = false;
      }
    };
  }

  _wireIce(peer) {
    const { pc, peerId } = peer;

    pc.onicecandidate = ({ candidate }) => {
      // A null candidate marks end-of-candidates; forwarding it lets the far
      // side stop waiting.
      this.onIceCandidate?.(peerId, candidate);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        // An ICE restart recovers from a network change (wifi to cellular, VPN
        // toggling) without rebuilding the connection or dropping media.
        try {
          pc.restartIce();
        } catch {
          /* Not supported everywhere; connectionstatechange handles the rest. */
        }
      }
    };

    pc.onconnectionstatechange = () => {
      this.onConnectionStateChange?.(peerId, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.onRemoteStreamEnded?.(peerId);
      }
    };
  }

  _wireTracks(peer) {
    const { pc, peerId } = peer;

    /**
     * Because both slots are declared up front, `ontrack` now fires as soon as
     * the session is negotiated — before the far side has necessarily attached
     * anything. A track in that state exists but is `muted`, so mute/unmute is
     * the honest "is their camera actually on" signal, and it does not depend on
     * the far side remembering to announce itself.
     */
    pc.ontrack = (event) => {
      const { track } = event;
      const known = peer.remoteStream.getTracks();

      if (!known.some((existing) => existing.id === track.id)) {
        // One track per kind. A replaced track arrives with a new id, so the
        // previous one has to be dropped or the element keeps playing the dead
        // one.
        for (const old of known) {
          if (old.kind === track.kind) peer.remoteStream.removeTrack(old);
        }
        peer.remoteStream.addTrack(track);
      }

      // `replaceTrack` on the far side (camera to screen share) reuses the same
      // transceiver, so this fires once per kind and the element is not re-bound
      // for every swap.
      track.onended = () => {
        this.onRemoteTrackState?.(peerId, track.kind, false);
        if (track.kind === 'video') return; // Losing video is not losing the peer.
        this.onRemoteStreamEnded?.(peerId);
      };
      track.onmute = () => this.onRemoteTrackState?.(peerId, track.kind, false);
      track.onunmute = () => this.onRemoteTrackState?.(peerId, track.kind, true);

      this.onRemoteTrackState?.(peerId, track.kind, !track.muted);
      // A fresh wrapper, so React sees a changed value when a second kind
      // arrives on a stream it is already rendering.
      this.onRemoteStream?.(peerId, new MediaStream(peer.remoteStream.getTracks()));
    };
  }

  _openChannels(peer) {
    for (const spec of Object.values(CHANNELS)) {
      try {
        const channel = peer.pc.createDataChannel(spec.label, spec.options);
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => this.onChannelOpen?.(peer.peerId, spec.label);
        channel.onmessage = (event) => this.onChannelMessage?.(peer.peerId, spec.label, event.data);
        channel.onerror = (event) => {
          // A closed-connection error is expected during teardown.
          if (event?.error?.errorDetail !== 'sctp-failure') return;
          console.warn(`[webrtc] channel ${spec.label} error for ${peer.peerId}`);
        };
        peer.channels.set(spec.label, channel);
      } catch (err) {
        console.warn(`[webrtc] could not create channel ${spec.label}:`, err?.message);
      }
    }
  }

  /**
   * Poll `getStats` for the numbers that actually decide whether a call feels
   * broken: round-trip time, packet loss and outbound bitrate. The old code
   * reported a hardcoded "good" for everyone, so a peer on a collapsing link
   * looked identical to one on fibre.
   */
  _startStats(peer) {
    if (peer.statsTimer) return;
    peer.statsTimer = setInterval(() => {
      this._sampleStats(peer).catch(() => {
        /* A closing connection throws; the next tick will be skipped anyway. */
      });
    }, 2000);
  }

  _stopStats(peer) {
    if (peer.statsTimer) clearInterval(peer.statsTimer);
    peer.statsTimer = null;
  }

  async _sampleStats(peer) {
    if (peer.pc.connectionState !== 'connected') return;
    const report = await peer.pc.getStats();

    let rtt = 0;
    let bytesSent = 0;
    let packetsLost = 0;
    let packetsReceived = 0;

    report.forEach((stat) => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
        rtt = stat.currentRoundTripTime ?? rtt;
      } else if (stat.type === 'outbound-rtp' && !stat.isRemote) {
        bytesSent += stat.bytesSent || 0;
      } else if (stat.type === 'inbound-rtp') {
        packetsLost += stat.packetsLost || 0;
        packetsReceived += stat.packetsReceived || 0;
      } else if (stat.type === 'remote-inbound-rtp') {
        // The far side's own view of what it received is the honest loss signal.
        if (typeof stat.roundTripTime === 'number') rtt = stat.roundTripTime;
      }
    });

    const now = Date.now();
    const previous = peer.lastStats;
    const elapsed = previous ? (now - previous.at) / 1000 : 0;
    const bitrate =
      previous && elapsed > 0 ? Math.max(0, ((bytesSent - previous.bytesSent) * 8) / elapsed) : 0;

    peer.lastStats = { at: now, bytesSent };

    const total = packetsLost + packetsReceived;
    const packetLoss = total > 0 ? packetsLost / total : 0;
    const quality = scoreConnection({ rtt, packetLoss, bitrate });
    const changed = quality !== peer.quality;
    peer.quality = quality;

    this.onQualityUpdate?.(peer.peerId, { quality, rtt, packetLoss, bitrate, changed });
  }

  /**
   * Point this peer's pre-created senders at the local tracks.
   *
   * `replaceTrack` rather than `addTrack`: the transceivers already exist from
   * `ensurePeer`, so filling them in does not change the SDP and needs no
   * renegotiation. A stream that is missing a kind — mic-only, because the camera
   * was busy — simply leaves that slot empty, and the far side sees a muted
   * track instead of a missing one.
   */
  _attachStream(peer, stream) {
    for (const kind of ['audio', 'video']) {
      const track = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      if (!track) continue;
      const sender = peer.senders.get(kind);
      if (!sender) {
        try {
          peer.senders.set(kind, peer.pc.addTrack(track, stream));
        } catch (err) {
          console.warn(`[webrtc] addTrack(${kind}) failed:`, err?.message);
        }
        continue;
      }
      if (sender.track === track) continue;
      sender.replaceTrack(track).catch((err) => {
        console.warn(`[webrtc] replaceTrack(${kind}) failed:`, err?.message);
      });
    }
  }

  /** Set (or swap) the stream sent to every peer. */
  setLocalStream(stream) {
    this.localStream = stream || null;
    for (const peer of this.peers.values()) {
      if (stream) {
        this._attachStream(peer, stream);
        continue;
      }
      // Leaving a stopped track attached publishes a frozen last frame, so the
      // slots are emptied rather than left dangling.
      for (const sender of peer.senders.values()) {
        sender.replaceTrack(null).catch(() => {
          /* The connection is closing; nothing to publish anyway. */
        });
      }
    }
  }

  /**
   * Swap one track kind across every peer without renegotiating — the screen
   * share / camera-return path. Returns the number of peers updated.
   */
  async replaceTrack(kind, track) {
    const results = await Promise.allSettled(
      [...this.peers.values()].map((peer) => {
        const sender = peer.senders.get(kind);
        if (!sender) {
          // No sender yet (peer joined before we had media): add one, which
          // triggers onnegotiationneeded and settles by itself.
          if (!track) return Promise.resolve();
          const added = peer.pc.addTrack(track, this.localStream || new MediaStream([track]));
          peer.senders.set(kind, added);
          return Promise.resolve();
        }
        return sender.replaceTrack(track);
      })
    );
    return results.filter((r) => r.status === 'fulfilled').length;
  }

  replaceVideoTrack(track) {
    return this.replaceTrack('video', track);
  }

  replaceAudioTrack(track) {
    return this.replaceTrack('audio', track);
  }

  /**
   * The heart of perfect negotiation. Handles both offers and answers, and
   * resolves glare (both sides offering at once) without a deadlock:
   *
   *  - impolite side: ignores the colliding offer and keeps its own
   *  - polite side:   rolls back its own offer and accepts theirs
   *
   * The old implementation returned early on any non-stable signaling state
   * with no rollback and no retry, so a simultaneous offer wedged the pair
   * permanently.
   */
  async handleDescription(remotePeerId, description) {
    if (this.destroyed || !description) return;
    const peer = this.ensurePeer(remotePeerId);
    if (!peer) return;
    const { pc } = peer;

    try {
      const isStable =
        pc.signalingState === 'stable' ||
        (pc.signalingState === 'have-local-offer' && peer.isSettingRemoteAnswerPending);

      const offerCollision = description.type === 'offer' && (peer.makingOffer || !isStable);

      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;

      peer.isSettingRemoteAnswerPending = description.type === 'answer';
      // Passing the description straight to setRemoteDescription while a local
      // offer is outstanding performs an implicit rollback in modern browsers.
      await pc.setRemoteDescription(description);
      peer.isSettingRemoteAnswerPending = false;

      // Candidates that arrived before the remote description could not be
      // applied then; they can now.
      await this._drainPendingCandidates(peer);

      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.onDescription?.(remotePeerId, pc.localDescription);
      }
    } catch (err) {
      peer.isSettingRemoteAnswerPending = false;
      console.warn(`[webrtc] handleDescription(${remotePeerId}) failed:`, err?.message);
    }
  }

  async _drainPendingCandidates(peer) {
    if (!peer.pendingCandidates?.length) return;
    const queued = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch {
        /* A stale candidate from a rolled-back description is expected. */
      }
    }
  }

  /**
   * Candidates can legitimately arrive before the description they belong to,
   * so they are queued rather than dropped. Errors are swallowed while an offer
   * is being ignored — those candidates belong to a branch we discarded.
   */
  async handleCandidate(remotePeerId, candidate) {
    if (this.destroyed) return;
    const peer = this.ensurePeer(remotePeerId);
    if (!peer) return;

    // A null candidate is the end-of-candidates marker; nothing to add.
    if (!candidate) return;

    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!peer.ignoreOffer) {
        console.warn(`[webrtc] addIceCandidate(${remotePeerId}) failed:`, err?.message);
      }
    }
  }

  /**
   * Apply the mesh quality ladder to every outbound video sender. This is what
   * keeps a full room from saturating the uplink: encodings are re-parameterised
   * in place, so there is no renegotiation and no visible interruption.
   */
  async applyQualityLadder(peerCount = this.peers.size) {
    const ladder = qualityLadderFor(peerCount);

    await Promise.allSettled(
      [...this.peers.values()].map(async (peer) => {
        const sender = peer.senders.get('video');
        if (!sender?.getParameters) return;

        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        for (const encoding of params.encodings) {
          encoding.scaleResolutionDownBy = ladder.scaleResolutionDownBy;
          encoding.maxBitrate = ladder.maxBitrate;
          encoding.maxFramerate = ladder.maxFramerate;
        }
        await sender.setParameters(params);
      })
    );

    return ladder;
  }

  /** Send on one peer's channel. Returns false if it is not open yet. */
  send(remotePeerId, label, data) {
    const channel = this.peers.get(remotePeerId)?.channels.get(label);
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(data);
      return true;
    } catch (err) {
      console.warn(`[webrtc] send on ${label} to ${remotePeerId} failed:`, err?.message);
      return false;
    }
  }

  /** Fan a payload out to every connected peer. Returns the delivery count. */
  broadcast(label, data) {
    let delivered = 0;
    for (const peerId of this.peers.keys()) {
      if (this.send(peerId, label, data)) delivered += 1;
    }
    return delivered;
  }

  /** Peers whose reliable `sync` channel is open — the ones a CRDT can talk to. */
  openPeers(label = CHANNELS.sync.label) {
    return [...this.peers.values()]
      .filter((peer) => peer.channels.get(label)?.readyState === 'open')
      .map((peer) => peer.peerId);
  }

  getQuality(remotePeerId) {
    return this.peers.get(remotePeerId)?.quality ?? 'good';
  }

  getRemoteStream(remotePeerId) {
    return this.peers.get(remotePeerId)?.remoteStream ?? null;
  }

  closePeer(remotePeerId) {
    const peer = this.peers.get(remotePeerId);
    if (!peer) return;
    this._stopStats(peer);

    for (const channel of peer.channels.values()) {
      try {
        channel.close();
      } catch {
        /* Already closed. */
      }
    }
    // Drop the handlers before closing so a teardown-time state change does not
    // fire callbacks against a peer the caller has already forgotten.
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.oniceconnectionstatechange = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.ontrack = null;
    try {
      peer.pc.close();
    } catch {
      /* Already closed. */
    }

    this.peers.delete(remotePeerId);
    this.onRemoteStreamEnded?.(remotePeerId);
  }

  destroy() {
    this.destroyed = true;
    for (const peerId of [...this.peers.keys()]) this.closePeer(peerId);
    this.peers.clear();
    this.localStream = null;
  }
}
