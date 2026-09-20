import {
  AppState,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import { mediaDevices, MediaStream } from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import { io } from 'socket.io-client';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { PeerConnectionManager } from '../../client/src/lib/webrtc';
import {
  handleFrame,
  encodeSyncRequest,
  encodeUpdate,
  encodeAwareness,
} from '../../client/src/lib/yjs-transport';
import { API } from './config';
import { api, bytes } from './core';

export class RoomEngine {
  constructor(invite, user, notify) {
    this.invite = invite;
    this.user = user;
    this.notify = notify;
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.state = {
      status: 'Connecting',
      peers: [],
      streams: {},
      room: {},
      role: 'viewer',
      tools: {},
      audio: false,
      video: false,
      screen: false,
      waiting: [],
      error: '',
      revision: 0,
      connected: false,
    };
    this.closed = false;
    this.joined = false;
    this.storageReady = false;
    this.doc.on('update', (update, origin) => {
      if (
        !['server', 'peer'].includes(origin) &&
        this.joined &&
        this.canEdit()
      ) {
        this.socket.emit('doc-update', { update });
        this.rtc.broadcast('sync', encodeUpdate(update));
      }
      this.patch({ revision: this.state.revision + 1 });
    });
  }
  patch(value) {
    if (!this.closed) {
      Object.assign(this.state, value);
      this.notify({ ...this.state });
    }
  }
  canEdit(tool) {
    return (
      this.joined &&
      this.storageReady &&
      this.state.connected &&
      this.state.role !== 'viewer' &&
      (!tool || this.state.role === 'host' || this.state.tools[tool])
    );
  }
  async requestPermission(name) {
    return (
      (await PermissionsAndroid.request(name)) ===
      PermissionsAndroid.RESULTS.GRANTED
    );
  }
  async begin(options = { audio: true, video: true }) {
    try {
      const { roomId, inviteToken } = this.invite;
      const saved = JSON.parse(
        (await NativeModules.FaceTimeMeeting.loadSession(roomId)) || 'null',
      );
      this.session = await api(`/rooms/${roomId}/session`, {
        inviteToken: inviteToken || saved?.hostToken,
        resumeToken: saved?.sessionToken,
        displayName:
          this.user.displayName ||
          this.user.email?.split('@')[0] ||
          'Participant',
      });
      if (this.closed) return;
      this.patch({ peerId: this.session.peerId, role: this.session.role });
      this.saved = {
        hostToken: inviteToken || saved?.hostToken,
        sessionToken: this.session.sessionToken,
      };
      await this.persistSession();
      const ice = await api('/ice');
      if (this.closed) return;
      this.rtc = new PeerConnectionManager({
        localPeerId: this.session.peerId,
        iceServers: ice.iceServers,
      });
      this.stream = new MediaStream();
      this.rtc.setLocalStream(this.stream);
      await this.capture(options);
      if (this.closed) {
        this.stream?.getTracks().forEach(t => t.stop());
        return;
      }
      this.socket = io(API, {
        autoConnect: false,
        transports: ['websocket', 'polling'],
        reconnection: true,
        timeout: 25000,
      });
      this.wire();
      this.rtc.onDescription = (to, description) =>
        this.socket.emit(
          description.type === 'offer' ? 'sdp-offer' : 'sdp-answer',
          { to, [description.type]: description },
        );
      this.rtc.onIceCandidate = (to, candidate) =>
        this.socket.emit('ice-candidate', { to, candidate });
      this.rtc.onRemoteStream = (id, stream) =>
        this.patch({ streams: { ...this.state.streams, [id]: stream } });
      this.rtc.onRemoteStreamEnded = id => {
        const streams = { ...this.state.streams };
        delete streams[id];
        this.patch({ streams });
      };
      this.rtc.onConnectionStateChange = (id, quality) =>
        this.patch({
          connections: { ...this.state.connections, [id]: quality },
        });
      this.rtc.onQualityUpdate = (id, quality) =>
        this.patch({
          quality: { ...this.state.quality, [id]: quality.quality },
        });
      this.rtc.onChannelOpen = (id, channel) => {
        if (channel === 'sync') {
          this.rtc.send(id, channel, encodeSyncRequest(this.doc));
          this.rtc.send(id, channel, encodeAwareness(this.awareness));
        }
        this.announce();
      };
      this.rtc.onChannelMessage = (id, label, data) => {
        try {
          if (label === 'sync') {
            const { reply } = handleFrame({
              doc: this.doc,
              awareness: this.awareness,
              data,
              origin: 'peer',
            });
            if (reply) this.rtc.send(id, label, reply);
          } else {
            const event = JSON.parse(data);
            this.ephemeral({
              from: id,
              type: event.kind || event.type,
              data: event.data,
            });
          }
        } catch {
          /* Untrusted malformed frames do not tear down a meeting. */
        }
      };
      this.appState = AppState.addEventListener('change', state => {
        if (state === 'background' && this.state.video && !this.state.screen)
          this.setVideo(false).catch(() => {});
      });
      this.socket.connect();
    } catch (error) {
      this.patch({ status: 'Could not join', error: error.message });
      this.cleanupMedia();
    }
  }
  async persistSession() {
    await NativeModules.FaceTimeMeeting.saveSession(
      this.invite.roomId,
      JSON.stringify(this.saved),
    );
  }
  wire() {
    const s = this.socket;
    s.on('connect', async () => {
      this.patch({ status: 'Joining', error: '' });
      try {
        const result = await s.timeout(25000).emitWithAck('join-room', {
          sessionToken: this.session.sessionToken,
        });
        if (!result.ok) throw new Error(result.error || 'Could not join');
        if (result.status === 'waiting') {
          this.patch({ status: 'Waiting for host', connected: false });
          return;
        }
        this.acceptJoin(result);
      } catch (error) {
        this.patch({ error: error.message, status: 'Could not join' });
      }
    });
    s.on('disconnect', () => {
      this.joined = false;
      this.storageReady = false;
      this.patch({ status: 'Reconnecting', connected: false });
    });
    s.on('connect_error', () =>
      this.patch({
        status: 'Reconnecting',
        error: 'Connection interrupted. Retrying automatically…',
      }),
    );
    s.on('doc-snapshot', ({ updates }) => {
      try {
        for (const update of updates)
          Y.applyUpdate(this.doc, bytes(update), 'server');
        this.storageReady = true;
        this.patch({ revision: this.state.revision + 1 });
      } catch {
        this.storageReady = false;
        this.patch({
          error:
            'Saved work could not be read. Leave and rejoin before editing.',
        });
      }
    });
    s.on('doc-update', ({ update }) => {
      try {
        Y.applyUpdate(this.doc, bytes(update), 'server');
      } catch {
        this.patch({ error: 'A shared update could not be read.' });
      }
    });
    s.on('doc-compact-request', () => {
      if (this.canEdit())
        s.emit('doc-compact', { snapshot: Y.encodeStateAsUpdate(this.doc) });
    });
    s.on('room-peers', ({ peers }) => this.updatePeers(peers));
    s.on('peer-joined', ({ peer }) => {
      this.updatePeers([
        ...this.state.peers.filter(p => p.peerId !== peer.peerId),
        peer,
      ]);
      this.announce();
    });
    s.on('peer-left', ({ peerId }) => {
      this.updatePeers(this.state.peers.filter(p => p.peerId !== peerId));
      this.rtc.closePeer(peerId);
    });
    s.on('peer-updated', ({ peerId, patch }) =>
      this.updatePeers(
        this.state.peers.map(p =>
          p.peerId === peerId ? { ...p, ...patch } : p,
        ),
      ),
    );
    s.on('room-state', room => this.patch({ room }));
    s.on('role-changed', event => {
      this.session.sessionToken = event.sessionToken;
      this.saved.sessionToken = event.sessionToken;
      this.persistSession().catch(() =>
        this.patch({
          error: 'Your role changed, but could not be saved on this device.',
        }),
      );
      this.patch({ role: event.role });
    });
    s.on('sdp-offer', ({ from, offer }) =>
      this.rtc.handleDescription(from, offer),
    );
    s.on('sdp-answer', ({ from, answer }) =>
      this.rtc.handleDescription(from, answer),
    );
    s.on('ice-candidate', ({ from, candidate }) =>
      this.rtc.handleCandidate(from, candidate),
    );
    s.on('ephemeral', event => this.ephemeral(event));
    s.on('tool-access', ({ tools }) => this.patch({ tools }));
    s.on('waiting-room', ({ waiting }) => this.patch({ waiting }));
    s.on('waiting-approved', result => this.acceptJoin(result));
    s.on('access-request', event =>
      this.patch({
        accessRequests: [
          ...(this.state.accessRequests || []).filter(
            r => r.peerId !== event.peerId || r.tool !== event.tool,
          ),
          event,
        ],
      }),
    );
    s.on('error-notice', event => {
      this.patch({ error: event.message });
      if (event.code === 'superseded')
        this.end('This session was opened on another device.');
    });
    s.on('moderated', ({ kind }) => {
      if (kind === 'audio') this.setAudio(false);
      else this.setVideo(false).catch(() => {});
    });
    for (const event of ['kicked', 'room-ended', 'waiting-denied'])
      s.on(event, () =>
        this.end(
          event === 'kicked'
            ? 'The host removed you.'
            : event === 'waiting-denied'
            ? 'The host declined your request.'
            : 'The host ended this meeting.',
        ),
      );
    s.on('artifacts-cleared', () =>
      this.end(
        'The host cleared saved work. Rejoin to start a fresh workspace.',
      ),
    );
  }
  acceptJoin(result) {
    this.joined = true;
    this.patch({
      role: result.role || this.session.role,
      tools: result.tools || {},
      room: result.room || {},
      status: 'Live',
      connected: true,
      error: '',
      waiting: result.waiting || [],
    });
    this.updatePeers(result.peers || this.state.peers);
    this.announce();
    this.awareness.setLocalState({
      peerId: this.session.peerId,
      name: this.session.displayName,
      color: '#3868ef',
      role: this.state.role,
    });
    const meta = this.doc.getMap('meta');
    const key = `joined:${this.session.peerId}`;
    if (this.canEdit() && !meta.get(key)) {
      meta.set(key, true);
      this.log('joined', `${this.session.displayName} joined`);
    }
  }
  updatePeers(peers) {
    const self = peers.find(p => p.peerId === this.session?.peerId);
    this.patch({
      peers,
      ...(self ? { role: self.role, tools: self.tools || {} } : {}),
    });
    for (const peer of peers)
      if (peer.peerId !== this.session?.peerId) {
        const exists = this.rtc?.peers.has(peer.peerId);
        const connection = this.rtc?.ensurePeer(peer.peerId);
        if (!exists && this.screenStream)
          connection?.senders
            .get('video')
            ?.replaceTrack(this.screenStream.getVideoTracks()[0])
            .catch(() => {});
      }
    for (const id of this.rtc?.peers.keys() || [])
      if (!peers.some(p => p.peerId === id)) this.rtc.closePeer(id);
    this.rtc?.applyQualityLadder(peers.length).catch(() => {});
  }
  async capture(options) {
    const audio =
      Boolean(options.audio) &&
      (await this.requestPermission(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ));
    const video =
      Boolean(options.video) &&
      (await this.requestPermission(PermissionsAndroid.PERMISSIONS.CAMERA));
    if (Platform.Version >= 33 && (audio || video))
      await this.requestPermission(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
    if (this.closed) return;
    if (audio || video) {
      await NativeModules.FaceTimeMeeting.startMeeting(audio, video);
      const media = await mediaDevices.getUserMedia({
        audio,
        video: video
          ? { facingMode: 'user', width: 960, height: 540, frameRate: 24 }
          : false,
      });
      if (this.closed) {
        media.getTracks().forEach(t => t.stop());
        return;
      }
      media.getTracks().forEach(t => this.stream.addTrack(t));
    }
    InCallManager.start({ media: 'audio' });
    InCallManager.setForceSpeakerphoneOn(true);
    InCallManager.setKeepScreenOn(true);
    this.patch({
      localStream: this.stream,
      audio,
      video,
      speaker: true,
      mediaReady: true,
    });
    this.rtc?.setLocalStream(this.stream);
  }
  async setAudio(enabled) {
    try {
      let track = this.stream?.getAudioTracks()[0];
      if (enabled && !track) {
        if (
          !(await this.requestPermission(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          ))
        )
          throw new Error('Microphone permission is required.');
        await NativeModules.FaceTimeMeeting.startMeeting(
          true,
          Boolean(this.state.video),
        );
        const media = await mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        track = media.getAudioTracks()[0];
        if (this.closed) {
          track.stop();
          return;
        }
        this.stream.addTrack(track);
        await this.rtc.replaceAudioTrack(track);
      }
      if (track) track.enabled = enabled;
      this.patch({ audio: enabled });
      this.announce();
    } catch (error) {
      this.patch({ error: error.message });
    }
  }
  async setVideo(enabled) {
    if (this.closed || !this.stream) return;
    if (this.state.screen) await this.stopScreen();
    for (const track of this.stream?.getVideoTracks() || []) {
      this.stream.removeTrack(track);
      track.stop();
    }
    if (enabled) {
      if (
        !(await this.requestPermission(PermissionsAndroid.PERMISSIONS.CAMERA))
      )
        throw new Error('Camera permission is required.');
      await NativeModules.FaceTimeMeeting.startMeeting(
        Boolean(this.stream.getAudioTracks().length),
        true,
      );
      const media = await mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: 960, height: 540, frameRate: 24 },
      });
      const track = media.getVideoTracks()[0];
      if (this.closed) {
        track.stop();
        return;
      }
      this.stream.addTrack(track);
      await this.rtc.replaceVideoTrack(track);
    } else await this.rtc?.replaceVideoTrack(null);
    this.patch({ video: enabled, localStream: this.stream });
    this.announce();
  }
  async shareScreen() {
    if (this.state.screen) return this.stopScreen();
    // Android shows its own capture consent every time; never cache that grant.
    const capture = await mediaDevices.getDisplayMedia({
      video: { frameRate: 15 },
      audio: false,
    });
    if (this.closed) {
      capture.getTracks().forEach(t => t.stop());
      return;
    }
    this.screenStream = capture;
    const track = capture.getVideoTracks()[0];
    track.onended = () => this.stopScreen().catch(() => {});
    await this.rtc.replaceVideoTrack(track);
    this.patch({ screen: true });
    this.announce();
    this.log('share', `${this.session.displayName} shared their screen`);
  }
  async stopScreen() {
    const previous = this.screenStream;
    this.screenStream = null;
    previous?.getTracks().forEach(t => {
      t.onended = null;
      t.stop();
    });
    await this.rtc?.replaceVideoTrack(this.stream?.getVideoTracks()[0] || null);
    this.patch({ screen: false });
    this.announce();
  }
  switchCamera() {
    this.stream?.getVideoTracks()[0]?._switchCamera();
  }
  async speaker(enabled) {
    if (!enabled && Platform.Version >= 31)
      await this.requestPermission(
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      );
    InCallManager.setForceSpeakerphoneOn(enabled ? true : null);
    this.patch({ speaker: enabled });
  }
  announce() {
    if (this.joined)
      this.sendEphemeral('MEDIA_STATE', {
        audio: this.state.audio,
        video: this.state.video,
        screen: this.state.screen,
      });
  }
  sendEphemeral(type, data) {
    if (this.joined) this.socket.emit('ephemeral', { type, data });
  }
  ephemeral({ from, type, data }) {
    if (type === 'MEDIA_STATE')
      this.patch({ media: { ...this.state.media, [from]: data } });
    if (type === 'REACTION')
      this.patch({
        reaction: {
          id: Date.now(),
          name: data?.name || 'Participant',
          emoji: String(data?.emoji || '').slice(0, 8),
        },
      });
    if (type === 'PRESENTER_VIEW' && this.state.room.followHost)
      this.patch({ presenter: data?.pinnedId });
  }
  async command(event, value) {
    if (!this.state.connected)
      throw new Error('Reconnect before using meeting controls.');
    const result = await this.socket.timeout(15000).emitWithAck(event, value);
    if (!result.ok)
      throw new Error(result.error || 'The host did not allow that action.');
    return result;
  }
  log(kind, text) {
    if (!this.canEdit()) return;
    const timeline = this.doc.getArray('timeline');
    timeline.push([
      {
        id: `${Date.now()}-${Math.random()}`,
        kind,
        text,
        at: Date.now(),
        by: this.session.peerId,
        byName: this.session.displayName,
      },
    ]);
    if (timeline.length > 2000) timeline.delete(0, timeline.length - 2000);
  }
  sendChat(text) {
    if (!this.canEdit() || !text.trim()) return;
    const chat = this.doc.getArray('chat');
    chat.push([
      {
        id: `${Date.now()}-${Math.random()}`,
        at: Date.now(),
        from: this.session.peerId,
        name: this.session.displayName,
        text: text.trim().slice(0, 2000),
      },
    ]);
    if (chat.length > 1000) chat.delete(0, chat.length - 1000);
  }
  end(message) {
    this.patch({ ended: message, status: 'Meeting ended', connected: false });
    this.dispose();
  }
  cleanupMedia() {
    this.screenStream?.getTracks().forEach(t => {
      t.onended = null;
      t.stop();
    });
    this.stream?.getTracks().forEach(t => t.stop());
    this.rtc?.destroy();
    InCallManager.stop();
    InCallManager.setKeepScreenOn(false);
    NativeModules.FaceTimeMeeting.stopMeeting();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.socket?.emit('leave-room');
    this.socket?.disconnect();
    this.appState?.remove();
    this.cleanupMedia();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
