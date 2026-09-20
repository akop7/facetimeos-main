import React, { useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Modal,
  NativeModules,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Code2,
  Download,
  ExternalLink,
  FileText,
  Globe,
  Play,
  Timer,
  X,
} from 'lucide-react-native';
import { zipSync, strToU8 } from 'fflate';
import { fromByteArray } from 'base64-js';
import { Button, C, s } from './ui';
import { applyTextDiff, safeWebUrl, timerValue } from './core';
import Whiteboard from './Whiteboard';

export const toolNames = {
  chat: 'Meeting chat',
  people: 'People',
  tools: 'Workspace',
  whiteboard: 'Whiteboard',
  notes: 'Shared notes',
  code: 'Code editor',
  timer: 'Meeting timer',
  browser: 'Shared browser',
  timeline: 'Session timeline',
};
export async function exportSession(engine) {
  const doc = engine.doc;
  const files = {
    'notes.md': strToU8(doc.getText('notes').toString()),
    'code.txt': strToU8(doc.getText('code').toString()),
    'chat.json': strToU8(
      JSON.stringify(doc.getArray('chat').toArray(), null, 2),
    ),
    'whiteboard.json': strToU8(
      JSON.stringify(doc.getArray('whiteboard').toArray(), null, 2),
    ),
    'timeline.json': strToU8(
      JSON.stringify(doc.getArray('timeline').toArray(), null, 2),
    ),
    'session.json': strToU8(
      JSON.stringify(
        {
          roomId: engine.invite.roomId,
          exportedAt: new Date().toISOString(),
          meta: doc.getMap('meta').toJSON(),
        },
        null,
        2,
      ),
    ),
  };
  return NativeModules.FaceTimeMeeting.exportZip(
    `FaceTimeOS-${engine.invite.roomId.slice(0, 8)}.zip`,
    fromByteArray(zipSync(files)),
  );
}

function NativeEditor({ engine, code }) {
  const text = engine.doc.getText(code ? 'code' : 'notes');
  const meta = engine.doc.getMap('meta');
  const [run, setRun] = useState(null);
  const language = meta.get('codeLanguage') || 'javascript';
  useEffect(() => {
    if (!run || language !== 'javascript') return;
    const timeout = setTimeout(() => setRun(null), 10000);
    return () => clearTimeout(timeout);
  }, [run, language]);
  const allowed = engine.canEdit(code ? 'code' : undefined);
  function execute() {
    const source = text.toString();
    if (source.length > 200000) {
      Alert.alert('Code is too large', 'Use a smaller example on mobile.');
      return;
    }
    if (language === 'json') {
      try {
        Alert.alert(
          'Valid JSON',
          JSON.stringify(JSON.parse(source), null, 2).slice(0, 2000),
        );
      } catch (e) {
        Alert.alert('JSON error', e.message);
      }
      return;
    }
    if (!['javascript', 'html', 'css'].includes(language)) {
      Alert.alert(
        'Editing supported',
        'This language can be edited collaboratively. Run it in a suitable development environment.',
      );
      return;
    }
    const embed = value => JSON.stringify(value).replace(/</g, '\\u003c');
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
    const body =
      language === 'html'
        ? source
        : language === 'css'
        ? `<style>${source.replace(
            /<\/style/gi,
            '',
          )}</style><main><h1>CSS preview</h1><p>Your shared stylesheet.</p><button>Example button</button></main>`
        : `<pre id="output"></pre><script>const out=document.getElementById('output'); const write=(...args)=>out.textContent+=args.map(v=>{try{return typeof v==='string'?v:JSON.stringify(v)}catch{return String(v)}}).join(' ')+'\\n'; ['log','error','warn','info'].forEach(k=>console[k]=write);try{const value=(0,eval)(${embed(
            source,
          )});if(value!==undefined)write(value)}catch(e){write(e.name+': '+e.message)}<\/script>`;
    setRun(
      `<!doctype html><html><head>${csp}<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:15px system-ui;padding:16px;color:#17233b}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`,
    );
  }
  return (
    <View style={{ flex: 1, gap: 12 }}>
      {code && (
        <ScrollView
          horizontal
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 7 }}
        >
          {[
            'javascript',
            'typescript',
            'html',
            'css',
            'json',
            'python',
            'java',
            'cpp',
          ].map(value => (
            <Pressable
              disabled={!allowed}
              key={value}
              style={[
                s.chip,
                language === value && { backgroundColor: '#dce7ff' },
              ]}
              onPress={() => meta.set('codeLanguage', value)}
            >
              <Text style={s.small}>{value}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <Text style={s.small}>
        {allowed
          ? 'Shared live with everyone in the meeting.'
          : 'View only. Editing is controlled by the host.'}
      </Text>
      <TextInput
        accessibilityLabel={code ? 'Shared code' : 'Shared notes'}
        style={[
          s.input,
          {
            flex: 1,
            textAlignVertical: 'top',
            fontFamily: code ? 'monospace' : undefined,
            lineHeight: 23,
          },
        ]}
        multiline
        editable={allowed}
        value={text.toString()}
        onChangeText={value => {
          if (engine.canEdit(code ? 'code' : undefined))
            applyTextDiff(text, value);
        }}
        autoCorrect={!code}
        autoCapitalize={code ? 'none' : 'sentences'}
        placeholder={
          code
            ? '// Build something together…'
            : 'Capture ideas, next steps and decisions…'
        }
        placeholderTextColor={C.muted}
        maxLength={200000}
      />
      {code && (
        <Button icon={Play} secondary onPress={execute}>
          {language === 'json' ? 'Validate JSON' : 'Run / preview'}
        </Button>
      )}
      <Modal
        visible={run !== null}
        onRequestClose={() => setRun(null)}
        animationType="slide"
      >
        <SafeAreaView style={s.page}>
          <View style={[s.between, { padding: 18 }]}>
            <Text style={s.h2}>Local preview</Text>
            <Pressable
              onPress={() => setRun(null)}
              accessibilityLabel="Close code preview"
            >
              <X color={C.ink} />
            </Pressable>
          </View>
          <Text style={[s.small, { paddingHorizontal: 18, paddingBottom: 12 }]}>
            Isolated preview · no access to your account or meeting
          </Text>
          {run && (
            <WebView
              source={{ html: run, baseUrl: 'https://preview.invalid/' }}
              originWhitelist={['https://preview.invalid', 'about:blank']}
              onShouldStartLoadWithRequest={r =>
                r.url === 'about:blank' || r.url === 'https://preview.invalid/'
              }
              allowFileAccess={false}
              allowUniversalAccessFromFileURLs={false}
              mixedContentMode="never"
              sharedCookiesEnabled={false}
              thirdPartyCookiesEnabled={false}
              incognito
              javaScriptCanOpenWindowsAutomatically={false}
              setSupportMultipleWindows
              onOpenWindow={() => {}}
            />
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

function Clock({ engine }) {
  const meta = engine.doc.getMap('meta');
  const timer = meta.get('timer') || {
    mode: 'countdown',
    anchor: null,
    base: 300000,
    duration: 300000,
  };
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const value = timerValue(timer, now),
    secs = Math.floor(Math.abs(value) / 1000);
  const commit = patch => {
    if (engine.canEdit())
      meta.set('timer', { ...timer, ...patch, by: engine.session.displayName });
  };
  return (
    <View style={{ gap: 25, paddingVertical: 20 }}>
      <Text style={[s.eyebrow, { textAlign: 'center' }]}>
        {timer.mode === 'countdown' ? 'SHARED COUNTDOWN' : 'SHARED STOPWATCH'}
      </Text>
      <Text
        style={{
          textAlign: 'center',
          fontSize: 64,
          fontWeight: '300',
          color: value < 0 ? C.red : C.ink,
          fontVariant: ['tabular-nums'],
        }}
      >
        {value < 0 ? '+' : ''}
        {String(Math.floor(secs / 60)).padStart(2, '0')}:
        {String(secs % 60).padStart(2, '0')}
      </Text>
      <View style={[s.row, { justifyContent: 'center' }]}>
        {[5, 10, 15, 25].map(n => (
          <Pressable
            key={n}
            style={s.chip}
            onPress={() =>
              commit({
                mode: 'countdown',
                base: n * 60000,
                duration: n * 60000,
                anchor: null,
              })
            }
          >
            <Text style={s.small}>{n} min</Text>
          </Pressable>
        ))}
      </View>
      <Button
        disabled={!engine.canEdit()}
        onPress={() =>
          commit({
            anchor: timer.anchor === null ? Date.now() : null,
            base: timerValue(timer),
          })
        }
      >
        {timer.anchor === null ? 'Start timer' : 'Pause timer'}
      </Button>
      <View style={s.row}>
        <Button
          secondary
          style={{ flex: 1 }}
          disabled={!engine.canEdit()}
          onPress={() =>
            commit({
              anchor: null,
              base: timer.mode === 'countdown' ? timer.duration : 0,
            })
          }
        >
          Reset
        </Button>
        <Button
          secondary
          style={{ flex: 1 }}
          disabled={!engine.canEdit()}
          onPress={() =>
            commit({
              mode: timer.mode === 'countdown' ? 'stopwatch' : 'countdown',
              anchor: null,
              base: timer.mode === 'countdown' ? 0 : timer.duration,
            })
          }
        >
          {timer.mode === 'countdown' ? 'Stopwatch' : 'Countdown'}
        </Button>
      </View>
      <Text style={[s.sub, { textAlign: 'center' }]}>
        One clock, synced across all devices.
      </Text>
    </View>
  );
}

function SharedBrowser({ engine }) {
  const meta = engine.doc.getMap('meta');
  const nav = meta.get('browserNav') || {
    trail: ['https://en.m.wikipedia.org/wiki/WebRTC'],
    index: 0,
  };
  const url = safeWebUrl(nav.trail?.[nav.index]);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState(false);
  function navigate() {
    const next = safeWebUrl(draft);
    if (!next) {
      Alert.alert('HTTPS link required', 'Enter a full https:// address.');
      return;
    }
    if (engine.canEdit()) {
      const trail = [...nav.trail.slice(0, nav.index + 1), next].slice(-50);
      meta.set('browserNav', {
        trail,
        index: trail.length - 1,
        at: Date.now(),
        by: engine.session.displayName,
      });
      setDraft('');
    }
  }
  return (
    <View style={{ flex: 1, gap: 14 }}>
      <Text style={s.sub}>
        The address is shared with everyone. Browser content opens in a
        separate, unprivileged view.
      </Text>
      <TextInput
        style={s.input}
        placeholder="https://example.com"
        placeholderTextColor={C.muted}
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Button disabled={!engine.canEdit()} onPress={navigate}>
        Share this page
      </Button>
      <View style={s.card}>
        <Globe size={30} color={C.blue} />
        <Text selectable style={s.h3}>
          {url || 'This shared address cannot be opened safely.'}
        </Text>
        {url && (
          <>
            <Button secondary onPress={() => setView(true)}>
              View page
            </Button>
            <Pressable onPress={() => Linking.openURL(url)}>
              <Text style={s.link}>Open in browser ↗</Text>
            </Pressable>
          </>
        )}
      </View>
      <Modal visible={view} onRequestClose={() => setView(false)}>
        <SafeAreaView style={s.page}>
          <View style={[s.between, { padding: 18 }]}>
            <Text style={s.h3}>Shared page</Text>
            <Pressable
              accessibilityLabel="Close shared page"
              onPress={() => setView(false)}
            >
              <X color={C.ink} />
            </Pressable>
          </View>
          {url && (
            <WebView
              source={{ uri: url }}
              originWhitelist={['https://*']}
              onShouldStartLoadWithRequest={r => Boolean(safeWebUrl(r.url))}
              allowFileAccess={false}
              allowUniversalAccessFromFileURLs={false}
              mixedContentMode="never"
              sharedCookiesEnabled={false}
              thirdPartyCookiesEnabled={false}
              incognito
              javaScriptCanOpenWindowsAutomatically={false}
              setSupportMultipleWindows
              onOpenWindow={() => {}}
              mediaPlaybackRequiresUserAction
              allowsInlineMediaPlayback={false}
            />
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

export default function Tools({ name, engine, revision, onSelect, onError }) {
  if (name === 'whiteboard')
    return <Whiteboard engine={engine} revision={revision} />;
  if (name === 'notes' || name === 'code')
    return <NativeEditor engine={engine} code={name === 'code'} />;
  if (name === 'timer') return <Clock engine={engine} />;
  if (name === 'browser') return <SharedBrowser engine={engine} />;
  return (
    <ScrollView contentContainerStyle={{ gap: 12 }}>
      {[
        ['whiteboard', 'Draw, sketch, undo and redo together', FileText],
        ['notes', 'Keep ideas and next steps in one place', FileText],
        ['code', 'A shared buffer for every device', Code2],
        ['timer', 'Stay on time with a shared clock', Timer],
        ['browser', 'Explore the same page together', Globe],
      ].map(([key, description, Icon]) => (
        <Pressable
          key={key}
          style={[s.card, s.row, { padding: 18 }]}
          onPress={() => onSelect(key)}
        >
          <View style={s.badge}>
            <Icon color={C.blue} size={22} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.h3}>{toolNames[key]}</Text>
            <Text style={s.small}>{description}</Text>
          </View>
          <ExternalLink color={C.muted} size={17} />
        </Pressable>
      ))}
      <Button
        secondary
        icon={Download}
        onPress={() => exportSession(engine).catch(e => onError(e.message))}
      >
        Export session as ZIP
      </Button>
    </ScrollView>
  );
}
