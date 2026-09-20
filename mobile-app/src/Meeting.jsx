import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';
import {
  Camera,
  CameraOff,
  Hand,
  LayoutGrid,
  LockKeyhole,
  MessageCircle,
  Mic,
  MicOff,
  Minus,
  MonitorUp,
  MoreHorizontal,
  PhoneOff,
  Pin,
  Send,
  Share2,
  SwitchCamera,
  Users,
  Volume2,
  X,
} from 'lucide-react-native';
import { RoomEngine } from './RoomEngine';
import { api } from './core';
import { WEB } from './config';
import { Button, C, Empty, s } from './ui';
import Tools, { exportSession, toolNames } from './Tools';

function Control({ icon: Icon, label, onPress, active, danger, disabled }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        m.control,
        active && { backgroundColor: '#244582' },
        danger && { backgroundColor: C.red },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Icon color="white" size={21} />
      <Text style={m.controlLabel}>{label}</Text>
    </Pressable>
  );
}
function Tile({ peer, stream, local, media, pinned, onPress, quality }) {
  const visible =
    stream && (local ? media?.video : media?.video !== false || media?.screen);
  return (
    <Pressable
      onPress={onPress}
      style={[m.tile, pinned && { minHeight: 320, flexBasis: '100%' }]}
      accessibilityLabel={`${
        peer.displayName || 'Participant'
      } video. Tap to pin.`}
    >
      {visible ? (
        <RTCView
          streamURL={stream.toURL()}
          style={StyleSheet.absoluteFill}
          objectFit={media?.screen ? 'contain' : 'cover'}
          mirror={local && !media?.screen}
        />
      ) : (
        <View style={m.avatar}>
          <Text style={{ fontSize: 35, color: '#dce7ff' }}>
            {(peer.displayName || '?')[0].toUpperCase()}
          </Text>
        </View>
      )}
      <View style={m.tileName}>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={m.name}>
            {peer.displayName || 'Participant'}
            {local ? ' (You)' : ''}
          </Text>
          <Text style={{ color: '#adc0df', fontSize: 10, marginTop: 2 }}>
            {peer.role?.toUpperCase()}
            {media?.screen ? ' · SHARING SCREEN' : ''}
            {quality === 'poor' ? ' · WEAK CONNECTION' : ''}
          </Text>
        </View>
        {media?.audio === false && <MicOff color="white" size={15} />}
        {peer.handRaised && <Hand color="#f0c668" size={16} />}
        {pinned && <Pin color="white" size={14} />}
      </View>
    </Pressable>
  );
}

function Chat({ engine, state }) {
  const [draft, setDraft] = useState('');
  const list = useRef(null);
  const messages = engine.doc
    .getArray('chat')
    .toArray()
    .filter(value => typeof value?.text === 'string');
  return (
    <KeyboardAvoidingView style={{ flex: 1 }}>
      <ScrollView
        ref={list}
        onContentSizeChange={() =>
          list.current?.scrollToEnd({ animated: true })
        }
        contentContainerStyle={{ gap: 16, paddingBottom: 18 }}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length ? (
          messages.map((message, index) => (
            <View
              key={message.id || index}
              style={{
                alignItems:
                  message.from === state.peerId ? 'flex-end' : 'flex-start',
              }}
            >
              <Text style={[s.small, { marginBottom: 6 }]}>
                {message.name || 'Participant'} ·{' '}
                {new Date(message.at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Text>
              <View
                style={{
                  maxWidth: '90%',
                  padding: 13,
                  borderRadius: 15,
                  backgroundColor:
                    message.from === state.peerId ? C.blue : '#eaf0f7',
                }}
              >
                <Text
                  selectable
                  style={{
                    color: message.from === state.peerId ? 'white' : C.ink,
                    lineHeight: 21,
                  }}
                >
                  {message.text}
                </Text>
              </View>
            </View>
          ))
        ) : (
          <Empty
            icon={MessageCircle}
            title="Start the conversation"
            text="Messages stay with this room across devices."
          />
        )}
      </ScrollView>
      <View style={s.row}>
        <TextInput
          style={[s.input, { flex: 1, maxHeight: 100 }]}
          placeholder={
            engine.canEdit() ? 'Message the room…' : 'Chat is view-only'
          }
          placeholderTextColor={C.muted}
          editable={engine.canEdit()}
          value={draft}
          onChangeText={value => {
            setDraft(value);
          }}
          multiline
          maxLength={2000}
        />
        <Pressable
          accessibilityLabel="Send message"
          disabled={!draft.trim() || !engine.canEdit()}
          style={[
            s.button,
            {
              minHeight: 50,
              opacity: draft.trim() && engine.canEdit() ? 1 : 0.4,
            },
          ]}
          onPress={() => {
            engine.sendChat(draft);
            setDraft('');
          }}
        >
          <Send size={20} color="white" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function People({ engine, state, act }) {
  const host = state.role === 'host';
  const peers = [
    {
      peerId: state.peerId,
      displayName: engine.session?.displayName,
      role: state.role,
    },
    ...state.peers.filter(p => p.peerId !== state.peerId),
  ];
  // Android Alert displays at most three actions. Use inline controls instead for host lists.
  return (
    <ScrollView contentContainerStyle={{ gap: 14 }}>
      {host && (
        <Button
          secondary
          icon={LockKeyhole}
          onPress={() =>
            act(() =>
              engine.command('moderate', {
                action: 'set-locked',
                value: !state.room.locked,
              }),
            )
          }
        >
          {state.room.locked ? 'Unlock meeting' : 'Lock meeting'}
        </Button>
      )}
      {host &&
        state.waiting.map(person => (
          <View key={person.peerId} style={s.card}>
            <Text style={s.h3}>{person.displayName} wants to join</Text>
            <View style={s.row}>
              <Button
                style={{ flex: 1 }}
                onPress={() =>
                  act(() =>
                    engine.command('admit', {
                      peerId: person.peerId,
                      admit: true,
                    }),
                  )
                }
              >
                Admit
              </Button>
              <Button
                secondary
                style={{ flex: 1 }}
                onPress={() =>
                  act(() =>
                    engine.command('admit', {
                      peerId: person.peerId,
                      admit: false,
                    }),
                  )
                }
              >
                Decline
              </Button>
            </View>
          </View>
        ))}
      {host &&
        (state.accessRequests || []).map(person => (
          <View style={s.card} key={`${person.peerId}-${person.tool}`}>
            <Text style={s.h3}>
              {person.displayName} requested {person.tool}
            </Text>
            <Button
              onPress={() =>
                act(async () => {
                  await engine.command('moderate', {
                    action: 'grant-tool',
                    targetPeerId: person.peerId,
                    value: person.tool,
                  });
                  engine.patch({
                    accessRequests: state.accessRequests.filter(
                      p => p !== person,
                    ),
                  });
                })
              }
            >
              Allow access
            </Button>
          </View>
        ))}
      {peers.map(person => (
        <View key={person.peerId} style={[s.card, { padding: 17 }]}>
          <View style={s.between}>
            <View style={{ flex: 1 }}>
              <Text style={s.h3}>
                {person.displayName || 'You'}
                {person.peerId === state.peerId ? ' (You)' : ''}
              </Text>
              <Text style={s.small}>
                {person.role} {person.handRaised ? '· Hand raised' : ''}
              </Text>
            </View>
            <Users size={20} color={C.muted} />
          </View>
          {host && person.peerId !== state.peerId && (
            <View style={{ gap: 8 }}>
              <View style={s.row}>
                <Button
                  secondary
                  style={{ flex: 1 }}
                  onPress={() =>
                    act(() =>
                      engine.command('moderate', {
                        action: 'mute-audio',
                        targetPeerId: person.peerId,
                      }),
                    )
                  }
                >
                  Mute
                </Button>
                <Button
                  secondary
                  style={{ flex: 1 }}
                  onPress={() =>
                    act(() =>
                      engine.command('moderate', {
                        action:
                          person.role === 'viewer'
                            ? 'grant-edit'
                            : 'revoke-edit',
                        targetPeerId: person.peerId,
                      }),
                    )
                  }
                >
                  {person.role === 'viewer' ? 'Make editor' : 'View only'}
                </Button>
              </View>
              <View style={s.row}>
                {['whiteboard', 'code'].map(tool => (
                  <Button
                    key={tool}
                    secondary
                    style={{ flex: 1 }}
                    onPress={() =>
                      act(() =>
                        engine.command('moderate', {
                          action: person.tools?.[tool]
                            ? 'revoke-tool'
                            : 'grant-tool',
                          targetPeerId: person.peerId,
                          value: tool,
                        }),
                      )
                    }
                  >
                    {person.tools?.[tool] ? 'Revoke' : 'Allow'} {tool}
                  </Button>
                ))}
              </View>
              <View style={s.row}>
                <Button
                  secondary
                  style={{ flex: 1 }}
                  onPress={() =>
                    Alert.alert(
                      'Transfer host?',
                      'This participant will control the meeting.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Transfer',
                          onPress: () =>
                            act(() =>
                              engine.command('moderate', {
                                action: 'make-host',
                                targetPeerId: person.peerId,
                              }),
                            ),
                        },
                      ],
                    )
                  }
                >
                  Transfer host
                </Button>
                <Button
                  danger
                  style={{ flex: 1 }}
                  onPress={() =>
                    Alert.alert('Remove participant?', person.displayName, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () =>
                          act(() =>
                            engine.command('moderate', {
                              action: 'kick',
                              targetPeerId: person.peerId,
                            }),
                          ),
                      },
                    ])
                  }
                >
                  Remove
                </Button>
              </View>
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

function Timeline({ engine, act }) {
  const [draft, setDraft] = useState(''),
    [decisions, setDecisions] = useState(false);
  const events = engine.doc
    .getArray('timeline')
    .toArray()
    .filter(e => e && (!decisions || e.kind === 'decision'));
  return (
    <View style={{ flex: 1, gap: 12 }}>
      <Pressable style={s.chip} onPress={() => setDecisions(!decisions)}>
        <Text style={s.small}>
          {decisions ? 'Show all events' : 'Show decisions only'}
        </Text>
      </Pressable>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {events.map((e, index) => (
          <View key={e.id || index} style={[s.card, { padding: 16 }]}>
            <Text style={s.h3}>{e.text}</Text>
            <Text style={s.small}>
              {e.byName || e.name || 'Participant'} ·{' '}
              {new Date(e.at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Text>
          </View>
        ))}
      </ScrollView>
      <TextInput
        style={s.input}
        value={draft}
        onChangeText={setDraft}
        placeholder="Mark a decision…"
        placeholderTextColor={C.muted}
        editable={engine.canEdit()}
        maxLength={2000}
      />
      <Button
        disabled={!draft.trim() || !engine.canEdit()}
        onPress={() => {
          engine.log('decision', draft.trim());
          setDraft('');
        }}
      >
        Save decision
      </Button>
      <Button secondary onPress={() => act(() => exportSession(engine))}>
        Export session
      </Button>
    </View>
  );
}

export default function Meeting({ invite, user, onLeave }) {
  const engineRef = useRef(null);
  const [state, setState] = useState({
    status: 'Connecting',
    peers: [],
    streams: {},
    room: {},
    tools: {},
    waiting: [],
  });
  const [sheet, setSheet] = useState(null),
    [minimized, setMinimized] = useState([]),
    [pinned, setPinned] = useState(null),
    [actionBusy, setActionBusy] = useState(false);
  useEffect(() => {
    let roomEngine;
    try {
      roomEngine = new RoomEngine(invite, user, setState);
      engineRef.current = roomEngine;
      roomEngine.begin(invite.options);
    } catch (error) {
      setState(current => ({
        ...current,
        status: 'Could not start meeting',
        error: error.message,
        connected: false,
      }));
    }
    return () => {
      roomEngine?.dispose();
      engineRef.current = null;
    };
  }, [invite, user]);
  const engine = engineRef.current;
  const askLeave = () =>
    Alert.alert(
      'Leave this meeting?',
      'Your cloud-saved work stays with the room.',
      [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: onLeave },
      ],
    );
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      askLeave();
      return true;
    });
    return () => sub.remove();
  });
  useEffect(() => {
    if (state.ended)
      Alert.alert(
        'Meeting ended',
        state.ended,
        [{ text: 'Return home', onPress: onLeave }],
        { cancelable: false },
      );
  }, [state.ended, onLeave]);
  useEffect(() => {
    if (!state.reaction) return;
    const timer = setTimeout(
      () => engineRef.current?.patch({ reaction: null }),
      4000,
    );
    return () => clearTimeout(timer);
  }, [state.reaction]);
  async function act(fn) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await fn();
    } catch (e) {
      engine?.patch({ error: e.message });
    } finally {
      setActionBusy(false);
    }
  }
  async function share() {
    const result = await api(`/rooms/${invite.roomId}/invites`, {
      sessionToken: engine.session.sessionToken,
      role: 'editor',
    });
    await Share.share({
      message: `Join my FaceTimeOS meeting:\n${WEB}/room/${
        invite.roomId
      }?t=${encodeURIComponent(result.inviteToken)}`,
    });
  }
  function select(name) {
    setSheet(name);
    setMinimized(list => list.filter(v => v !== name));
    const type = {
      whiteboard: 'WHITEBOARD',
      code: 'CODE_EDITOR',
      notes: 'NOTES',
      browser: 'WEB_BROWSER',
      timer: 'MEETING_TIMER',
    }[name];
    if (type && engine?.canEdit()) {
      const windows = engine.doc.getMap('windows');
      if (![...windows.values()].some(v => v.type === type))
        windows.set(`mobile-${Date.now()}`, {
          type,
          createdAt: Date.now(),
          createdBy: state.peerId,
          position: { x: 0.05, y: 0.05, w: 0.55, h: 0.62 },
          isMinimized: false,
          z: windows.size + 1,
        });
    }
  }
  function minimize() {
    setMinimized(list => [...new Set([...list, sheet])]);
    setSheet(null);
  }
  const remote = state.peers.filter(peer => peer.peerId !== state.peerId);
  const tiles = [
    {
      peerId: state.peerId || 'self',
      displayName: engine?.session?.displayName || user.displayName || 'You',
      role: state.role,
      local: true,
    },
    ...remote,
  ];
  const selected = pinned || state.presenter;
  if (selected)
    tiles.sort(
      (a, b) => Number(b.peerId === selected) - Number(a.peerId === selected),
    );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.dark }}>
      <StatusBar barStyle="light-content" backgroundColor={C.dark} />
      <View style={m.header}>
        <View style={{ flex: 1 }}>
          <Text
            style={{ color: 'white', fontSize: 16, fontWeight: '700' }}
            numberOfLines={1}
          >
            {state.room.title || invite.title || 'Your meeting'}
          </Text>
          <View style={[s.row, { marginTop: 5, gap: 6 }]}>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: state.connected ? C.green : '#f0bd60',
              }}
            />
            <Text style={{ fontSize: 11, color: '#99abc5' }}>
              {state.status} · {remote.length + 1} here
              {state.role === 'host' ? ' · Host' : ''}
            </Text>
          </View>
        </View>
        {state.role === 'host' && (
          <Pressable
            accessibilityLabel="Share invitation"
            style={m.iconButton}
            onPress={() => act(share)}
          >
            <Share2 color="white" size={19} />
          </Pressable>
        )}
      </View>
      {state.error ? (
        <Pressable
          style={{
            backgroundColor: '#44212d',
            padding: 12,
            marginHorizontal: 12,
            borderRadius: 12,
          }}
          onPress={() => engine?.patch({ error: '' })}
        >
          <Text style={{ color: '#ffc1c7', fontSize: 12 }}>
            {state.error} · Tap to dismiss
          </Text>
        </Pressable>
      ) : null}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, gap: 12 }}
      >
        {tiles.map(peer => (
          <Tile
            key={peer.peerId}
            peer={peer}
            stream={peer.local ? state.localStream : state.streams[peer.peerId]}
            local={peer.local}
            media={
              peer.local
                ? { video: state.video, audio: state.audio }
                : state.media?.[peer.peerId]
            }
            pinned={peer.peerId === selected || tiles.length === 1}
            onPress={() =>
              setPinned(pinned === peer.peerId ? null : peer.peerId)
            }
            quality={state.quality?.[peer.peerId]}
          />
        ))}
        {remote.length === 0 && state.connected && (
          <View style={{ paddingHorizontal: 20, gap: 7 }}>
            <Text
              style={{ color: 'white', fontWeight: '600', textAlign: 'center' }}
            >
              A little room for your people.
            </Text>
            <Text
              style={{ color: '#99abc5', textAlign: 'center', fontSize: 13 }}
            >
              Share an invitation to bring someone in.
            </Text>
          </View>
        )}
      </ScrollView>
      {state.reaction && (
        <Text style={{ color: 'white', textAlign: 'center', padding: 10 }}>
          {state.reaction.emoji} {state.reaction.name}
        </Text>
      )}
      {state.screen && (
        <Pressable
          style={{ backgroundColor: '#174d41', padding: 12 }}
          onPress={() => act(() => engine.stopScreen())}
        >
          <Text
            style={{ color: 'white', textAlign: 'center', fontWeight: '700' }}
          >
            You’re sharing your screen · Tap to stop
          </Text>
        </Pressable>
      )}
      {minimized.length > 0 && (
        <ScrollView
          horizontal
          style={{ flexGrow: 0 }}
          contentContainerStyle={{
            paddingHorizontal: 12,
            gap: 8,
            paddingVertical: 8,
          }}
        >
          {minimized.map(name => (
            <Pressable key={name} style={m.pill} onPress={() => select(name)}>
              <Text style={{ color: '#bad0f8', fontSize: 11 }}>
                {toolNames[name]} ↑
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View style={m.dock}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            gap: 5,
          }}
        >
          <Control
            icon={state.audio ? Mic : MicOff}
            label={state.audio ? 'Mute' : 'Unmute'}
            active={state.audio}
            disabled={!state.mediaReady || actionBusy}
            onPress={() => act(() => engine.setAudio(!state.audio))}
          />
          <Control
            icon={state.video ? Camera : CameraOff}
            label={state.video ? 'Camera off' : 'Camera on'}
            active={state.video}
            disabled={!state.mediaReady || actionBusy}
            onPress={() => act(() => engine.setVideo(!state.video))}
          />
          <Control
            icon={MonitorUp}
            label={state.screen ? 'Stop share' : 'Share screen'}
            active={state.screen}
            disabled={!state.connected || actionBusy}
            onPress={() => act(() => engine.shareScreen())}
          />
          <Control icon={PhoneOff} label="Leave" danger onPress={askLeave} />
        </View>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-around',
            paddingTop: 9,
          }}
        >
          {[
            ['chat', MessageCircle, 'Chat'],
            ['people', Users, `People ${remote.length + 1}`],
            ['tools', LayoutGrid, 'Tools'],
            ['timeline', MoreHorizontal, 'Session'],
          ].map(([key, Icon, label]) => (
            <Pressable
              key={key}
              style={m.tab}
              disabled={!state.connected}
              onPress={() => select(key)}
            >
              <Icon color="#a6b7d1" size={19} />
              <Text style={{ color: '#a6b7d1', fontSize: 10 }}>{label}</Text>
            </Pressable>
          ))}
          <Pressable
            style={m.tab}
            disabled={!state.mediaReady}
            onPress={() => select('settings')}
          >
            <MoreHorizontal color="#a6b7d1" size={19} />
            <Text style={{ color: '#a6b7d1', fontSize: 10 }}>More</Text>
          </Pressable>
        </View>
      </View>
      <Modal
        visible={Boolean(sheet)}
        animationType="slide"
        onRequestClose={minimize}
      >
        <SafeAreaView style={s.page}>
          <View
            style={[
              s.between,
              { padding: 18, borderBottomWidth: 1, borderBottomColor: C.line },
            ]}
          >
            <Text style={s.h2}>{toolNames[sheet] || 'Meeting controls'}</Text>
            <View style={s.row}>
              <Pressable
                accessibilityLabel="Minimize panel"
                style={s.chip}
                onPress={minimize}
              >
                <Minus size={20} color={C.ink} />
              </Pressable>
              <Pressable
                accessibilityLabel="Close panel"
                style={s.chip}
                onPress={() => setSheet(null)}
              >
                <X size={20} color={C.ink} />
              </Pressable>
            </View>
          </View>
          <View style={{ flex: 1, padding: 18 }}>
            {engine?.session && sheet === 'chat' && (
              <Chat engine={engine} state={state} />
            )}
            {engine?.session && sheet === 'people' && (
              <People engine={engine} state={state} act={act} />
            )}
            {engine?.session && sheet === 'timeline' && (
              <Timeline engine={engine} act={act} />
            )}
            {engine?.session &&
              [
                'tools',
                'whiteboard',
                'notes',
                'code',
                'timer',
                'browser',
              ].includes(sheet) && (
                <>
                  {['whiteboard', 'code'].includes(sheet) &&
                    !engine.canEdit(sheet) && (
                      <Button
                        secondary
                        onPress={() =>
                          act(async () => {
                            await engine.command('request-access', {
                              tool: sheet,
                            });
                            Alert.alert(
                              'Request sent',
                              'The host can allow editing from People.',
                            );
                          })
                        }
                        style={{ marginBottom: 12 }}
                      >
                        Ask host for access
                      </Button>
                    )}
                  <Tools
                    name={sheet}
                    engine={engine}
                    revision={state.revision}
                    onSelect={select}
                    onError={error => engine.patch({ error })}
                  />
                </>
              )}
            {sheet === 'settings' && (
              <ScrollView contentContainerStyle={{ gap: 14 }}>
                <Button
                  secondary
                  icon={SwitchCamera}
                  disabled={!state.video}
                  onPress={() => engine.switchCamera()}
                >
                  Switch camera
                </Button>
                <Button
                  secondary
                  icon={Volume2}
                  onPress={() => act(() => engine.speaker(!state.speaker))}
                >
                  {state.speaker
                    ? 'Use earpiece / connected headset'
                    : 'Use speaker'}
                </Button>
                <Button
                  secondary
                  icon={Hand}
                  onPress={() => {
                    const raised = !state.raised;
                    engine.socket?.emit('hand', { raised });
                    engine.patch({ raised });
                  }}
                >
                  {state.raised ? 'Lower hand' : 'Raise hand'}
                </Button>
                <Text style={s.h3}>Reactions</Text>
                <View style={[s.row, { flexWrap: 'wrap' }]}>
                  {['👍', '❤️', '😂', '🎉', '🔥', '👏'].map(emoji => (
                    <Pressable
                      key={emoji}
                      style={s.chip}
                      onPress={() => {
                        engine.sendEphemeral('REACTION', {
                          emoji,
                          name: engine.session.displayName,
                        });
                        engine.patch({
                          reaction: { id: Date.now(), emoji, name: 'You' },
                        });
                      }}
                    >
                      <Text style={{ fontSize: 24 }}>{emoji}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={s.sub}>
                  Camera pauses when this app goes into the background. Screen
                  sharing includes the existing microphone, not device/system
                  audio.
                </Text>
                {state.role === 'host' && (
                  <Button
                    danger
                    onPress={() =>
                      Alert.alert(
                        'End for everyone?',
                        'Everyone will leave this meeting. Saved work remains.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'End meeting',
                            style: 'destructive',
                            onPress: () =>
                              act(() =>
                                engine.command('moderate', {
                                  action: 'end-room',
                                }),
                              ),
                          },
                        ],
                      )
                    }
                  >
                    End meeting for everyone
                  </Button>
                )}
              </ScrollView>
            )}
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
const m = StyleSheet.create({
  header: { padding: 18, flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconButton: { padding: 13, borderRadius: 14, backgroundColor: '#1c2a43' },
  tile: {
    height: 230,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#1d2b45',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatar: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: '#304872',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileName: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    borderRadius: 11,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#0a1422c9',
  },
  name: { fontSize: 12, fontWeight: '600', color: 'white' },
  dock: {
    paddingHorizontal: 13,
    paddingTop: 12,
    paddingBottom: 7,
    borderTopWidth: 1,
    borderColor: '#1a2940',
  },
  control: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#1d2c45',
  },
  controlLabel: { color: 'white', fontSize: 9, fontWeight: '600' },
  tab: { padding: 7, alignItems: 'center', gap: 4 },
  pill: { backgroundColor: '#1d2c45', borderRadius: 11, padding: 10 },
});
