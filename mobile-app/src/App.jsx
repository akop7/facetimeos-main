import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getAuth,
  onAuthStateChanged,
  signInWithCredential,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut,
} from '@react-native-firebase/auth';
import {
  GoogleSignin,
  isSuccessResponse,
} from '@react-native-google-signin/google-signin';
import {
  ArrowRight,
  Camera,
  Clock3,
  Link2,
  LogOut,
  Mic,
  Plus,
  ShieldCheck,
  Video,
  X,
} from 'lucide-react-native';
import { api, parseInvite } from './core';
import { GOOGLE_WEB_CLIENT_ID, RELEASES, VERSION } from './config';
import { Button, C, Empty, Field, s } from './ui';
import Meeting from './Meeting';

GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });
const auth = getAuth();

function AuthForm({ onClose }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [name, setName] = useState('');
  const [signup, setSignup] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(google = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (google) {
        await GoogleSignin.hasPlayServices({
          showPlayServicesUpdateDialog: true,
        });
        const result = await GoogleSignin.signIn();
        if (!isSuccessResponse(result)) return;
        if (!result.data.idToken)
          throw new Error('Google did not return a sign-in token.');
        await signInWithCredential(
          auth,
          GoogleAuthProvider.credential(result.data.idToken),
        );
      } else if (signup) {
        if (!name.trim()) throw new Error('Enter your name.');
        const result = await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        );
        await updateProfile(result.user, { displayName: name.trim() });
      } else await signInWithEmailAndPassword(auth, email.trim(), password);
      onClose();
    } catch (e) {
      setError(
        String(e.code) === '10' || /DEVELOPER_ERROR/.test(e.message)
          ? 'Google login setup is incomplete: add this release signing fingerprint in Firebase, then retry.'
          : e.message.replace(/\[auth\/[^\]]+\]\s*/, ''),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={s.page}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={s.content}
        >
          <View style={s.between}>
            <Text style={s.eyebrow}>YOUR FACETIMEOS ACCOUNT</Text>
            <Pressable
              accessibilityLabel="Close sign in"
              onPress={onClose}
              style={s.chip}
            >
              <X color={C.ink} size={20} />
            </Pressable>
          </View>
          <Text style={s.h1}>
            {signup ? 'Make yourself\nat home.' : 'Good to see\nyou again.'}
          </Text>
          <Text style={s.sub}>
            One account for your phone, desktop and the web.
          </Text>
          <Button secondary onPress={() => submit(true)} loading={busy}>
            Continue with Google
          </Button>
          <View style={s.divider} />
          {signup && (
            <Field
              label="Your name"
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              maxLength={40}
            />
          )}
          <Field
            label="Email address"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoComplete="email"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete={signup ? 'new-password' : 'current-password'}
          />
          {error ? (
            <View style={s.error}>
              <Text style={s.errorText}>{error}</Text>
            </View>
          ) : null}
          <Button loading={busy} onPress={() => submit()}>
            {signup ? 'Create account' : 'Sign in'}
          </Button>
          <Pressable
            onPress={() => {
              setSignup(!signup);
              setError('');
            }}
          >
            <Text style={[s.link, { textAlign: 'center' }]}>
              {signup
                ? 'Already have an account? Sign in'
                : 'New here? Create an account'}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Home() {
  const [user, setUser] = useState(null),
    [authReady, setAuthReady] = useState(false),
    [authOpen, setAuthOpen] = useState(false);
  const [invite, setInvite] = useState(''),
    [health, setHealth] = useState(null),
    [checking, setChecking] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [recent, setRecent] = useState([]);
  const [prejoin, setPrejoin] = useState(null),
    [active, setActive] = useState(null),
    [audio, setAudio] = useState(true),
    [video, setVideo] = useState(true);
  useEffect(
    () =>
      onAuthStateChanged(auth, value => {
        setUser(value);
        setAuthReady(true);
      }),
    [],
  );
  useEffect(() => {
    checkHealth();
    AsyncStorage.getItem('recent-meetings').then(raw => {
      try {
        setRecent(JSON.parse(raw || '[]'));
      } catch {
        /* Invalid history is disposable. */
      }
    });
  }, []);
  useEffect(() => {
    const receive = url => {
      const parsed = parseInvite(url);
      if (parsed) setInvite(url);
    };
    Linking.getInitialURL().then(url => url && receive(url));
    const sub = Linking.addEventListener('url', e => receive(e.url));
    return () => sub.remove();
  }, []);
  async function checkHealth() {
    setChecking(true);
    try {
      setHealth(await api('/health'));
    } catch {
      setHealth(null);
    } finally {
      setChecking(false);
    }
  }
  async function start(create) {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      let target;
      if (create) {
        const title = `${
          user.displayName || user.email?.split('@')[0] || 'My'
        }'s room`;
        const room = await api('/rooms', { title });
        target = { roomId: room.roomId, inviteToken: room.hostToken, title };
        await NativeModules.FaceTimeMeeting.saveSession(
          room.roomId,
          JSON.stringify({ hostToken: room.hostToken }),
        );
      } else {
        target = parseInvite(invite);
        if (!target)
          throw new Error('Paste a valid FaceTimeOS meeting link or room ID.');
      }
      setPrejoin(target);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function joinNow() {
    const list = [
      {
        roomId: prejoin.roomId,
        title: prejoin.title || 'Joined meeting',
        at: Date.now(),
      },
      ...recent.filter(r => r.roomId !== prejoin.roomId),
    ].slice(0, 6);
    setRecent(list);
    AsyncStorage.setItem('recent-meetings', JSON.stringify(list)).catch(
      () => {},
    );
    setActive({ ...prejoin, options: { audio, video } });
    setPrejoin(null);
  }
  async function logout() {
    await signOut(auth);
    await GoogleSignin.signOut().catch(() => {});
    await NativeModules.FaceTimeMeeting.clearSessions();
    await AsyncStorage.removeItem('recent-meetings');
    setRecent([]);
  }
  if (active && user)
    return (
      <Meeting invite={active} user={user} onLeave={() => setActive(null)} />
    );
  return (
    <SafeAreaView style={s.page}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.between}>
          <View style={s.row}>
            <View style={s.badge}>
              <Video color={C.blue} size={24} />
            </View>
            <Text style={s.brand}>FaceTimeOS</Text>
          </View>
          {user ? (
            <Pressable
              accessibilityLabel="Sign out"
              style={s.chip}
              onPress={() =>
                Alert.alert(
                  'Sign out?',
                  'Your saved room work stays in the cloud. Device meeting history and host sessions will be cleared.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Sign out',
                      onPress: () => logout().catch(e => setError(e.message)),
                    },
                  ],
                )
              }
            >
              <LogOut color={C.muted} size={19} />
            </Pressable>
          ) : (
            <Pressable disabled={!authReady} onPress={() => setAuthOpen(true)}>
              <Text style={s.link}>Sign in</Text>
            </Pressable>
          )}
        </View>
        <View style={{ gap: 10, marginTop: 20 }}>
          <Text style={s.eyebrow}>YOUR MEETINGS, TOGETHER</Text>
          <Text style={s.h1}>
            {user
              ? `Hello, ${
                  user.displayName?.split(' ')[0] || 'there'
                }.\nLet’s connect.`
              : 'A good place\nto come together.'}
          </Text>
          <Text style={s.sub}>
            Face-to-face conversations. A shared space to get things done.
          </Text>
        </View>
        <View
          style={[s.card, { backgroundColor: C.navy, borderColor: C.navy }]}
        >
          <View style={s.between}>
            <Video color="#9eb6ff" size={30} />
            <Text style={[s.eyebrow, { color: '#8c9ab4' }]}>
              READY WHEN YOU ARE
            </Text>
          </View>
          <Text style={[s.h2, { color: C.white }]}>Start a conversation</Text>
          <Text style={[s.sub, { color: '#aebbd1' }]}>
            Bring your people, your ideas and your next big question.
          </Text>
          <Button icon={Plus} loading={busy} onPress={() => start(true)}>
            New meeting
          </Button>
        </View>
        <View style={s.card}>
          <View style={s.row}>
            <Link2 color={C.blue} size={21} />
            <Text style={s.h2}>Have an invitation?</Text>
          </View>
          <Field
            label="Meeting link or ID"
            value={invite}
            onChangeText={setInvite}
            placeholder="Paste your meeting link"
            autoCorrect={false}
          />
          <Button
            secondary
            icon={ArrowRight}
            disabled={busy}
            onPress={() => start(false)}
          >
            Join meeting
          </Button>
        </View>
        {error ? (
          <View style={s.error}>
            <Text style={s.errorText}>{error}</Text>
          </View>
        ) : null}
        <View style={s.between}>
          <Text style={s.h2}>Recent meetings</Text>
          {recent.length > 0 && (
            <Pressable
              onPress={() => {
                setRecent([]);
                AsyncStorage.removeItem('recent-meetings');
              }}
            >
              <Text style={s.link}>Clear</Text>
            </Pressable>
          )}
        </View>
        {recent.length ? (
          recent.map(r => (
            <Pressable
              key={r.roomId}
              style={[s.card, s.row, { padding: 17 }]}
              onPress={() => {
                setInvite(r.roomId);
                if (user) setPrejoin(r);
                else setAuthOpen(true);
              }}
            >
              <Clock3 size={22} color={C.muted} />
              <View style={{ flex: 1 }}>
                <Text style={s.h3}>{r.title}</Text>
                <Text style={s.small}>
                  {new Date(r.at).toLocaleDateString()} · {r.roomId.slice(0, 8)}
                </Text>
              </View>
              <ArrowRight color={C.muted} size={18} />
            </Pressable>
          ))
        ) : (
          <Empty
            icon={Clock3}
            title="Your next conversation starts here"
            text="Meetings you join will appear here."
          />
        )}
        <View style={s.divider} />
        <View style={s.row}>
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: health ? C.green : '#d99b46',
            }}
          />
          <Text style={[s.small, { flex: 1 }]}>
            {checking
              ? 'Connecting… Render may take a minute to wake.'
              : health
              ? `Connected · ${
                  health.storage === 'firestore'
                    ? 'Cloud saving on'
                    : 'Cloud saving needs setup'
                }`
              : 'Server unavailable'}
          </Text>
          <Pressable disabled={checking} onPress={checkHealth}>
            <Text style={s.link}>Retry</Text>
          </Pressable>
        </View>
        <View style={s.between}>
          <Text style={s.small}>Android · {VERSION}</Text>
          <Pressable onPress={() => Linking.openURL(RELEASES)}>
            <Text style={s.link}>Downloads & updates ↗</Text>
          </Pressable>
        </View>
      </ScrollView>
      <Modal
        visible={authOpen}
        animationType="slide"
        onRequestClose={() => setAuthOpen(false)}
      >
        <AuthForm onClose={() => setAuthOpen(false)} />
      </Modal>
      <Modal
        visible={Boolean(prejoin)}
        transparent
        animationType="slide"
        onRequestClose={() => setPrejoin(null)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'flex-end',
            backgroundColor: '#0008',
          }}
        >
          <SafeAreaView
            edges={['bottom']}
            style={{
              backgroundColor: C.white,
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
            }}
          >
            <View style={s.content}>
              <View style={s.between}>
                <Text style={s.h2}>Ready to join?</Text>
                <Pressable
                  accessibilityLabel="Close preview"
                  onPress={() => setPrejoin(null)}
                >
                  <X color={C.muted} />
                </Pressable>
              </View>
              <View
                style={{
                  height: 140,
                  borderRadius: 20,
                  backgroundColor: C.navy,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                }}
              >
                <View
                  style={{
                    backgroundColor: '#2b4065',
                    width: 66,
                    height: 66,
                    borderRadius: 33,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text
                    style={{ fontSize: 26, color: 'white', fontWeight: '700' }}
                  >
                    {(user?.displayName || user?.email || 'Y')[0].toUpperCase()}
                  </Text>
                </View>
                <Text style={{ color: '#bdc9df' }}>
                  {user?.displayName || user?.email}
                </Text>
              </View>
              <Text style={s.sub}>
                Your camera and microphone start only after you join and allow
                access.
              </Text>
              <View style={s.between}>
                <View style={s.row}>
                  <Mic color={C.ink} size={20} />
                  <Text style={s.h3}>Microphone</Text>
                </View>
                <Switch
                  value={audio}
                  onValueChange={setAudio}
                  trackColor={{ true: C.blue }}
                />
              </View>
              <View style={s.between}>
                <View style={s.row}>
                  <Camera color={C.ink} size={20} />
                  <Text style={s.h3}>Camera</Text>
                </View>
                <Switch
                  value={video}
                  onValueChange={setVideo}
                  trackColor={{ true: C.blue }}
                />
              </View>
              <Button icon={Video} onPress={joinNow}>
                Join meeting
              </Button>
              <View style={s.row}>
                <ShieldCheck size={15} color={C.muted} />
                <Text style={s.small}>Same room. On every device.</Text>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

class Boundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <SafeAreaView style={[s.page, s.content]}>
        <Text style={s.h1}>Let’s start fresh.</Text>
        <Text style={s.sub}>
          Close and reopen FaceTimeOS. Cloud-saved work is unaffected.
        </Text>
      </SafeAreaView>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  return (
    <SafeAreaProvider>
      <Boundary>
        <Home />
      </Boundary>
    </SafeAreaProvider>
  );
}
