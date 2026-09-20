import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from '../../client/src/context/AuthContext.jsx';
import { ThemeProvider } from '../../client/src/context/ThemeContext.jsx';
import AuthModal from '../../client/src/components/ui/AuthModal.jsx';
import ThemeSwitcher from '../../client/src/components/ui/ThemeSwitcher.jsx';
import Room from '../../client/src/app/room/[roomId]/page.js';
import { roomApi, rememberName, rememberedName, saveHostToken } from '../../client/src/lib/room-api.js';
import { useRoute, useRouter } from './navigation.jsx';
import urls from '../electron/urls.cjs';
import './style.css';

const native = window.faceTimeWindows;
function Icon({ type, size = 24 }) {
  const shapes = {
    video: <><rect x="3" y="5" width="12" height="14" rx="3" /><path d="m15 9 6-3v12l-6-3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    link: <><path d="m10 13 4-4m-7 6-1 1a4 4 0 0 0 6 6l4-4a4 4 0 0 0 0-6M8 12a4 4 0 0 1 0-6l4-4a4 4 0 0 1 6 6l-1 1" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    screen: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[type] || shapes.video}</svg>;
}
function readRecent() { try { return JSON.parse(localStorage.getItem('ftos.windows.recent') || '[]').slice(0, 6); } catch { return []; } }
function addRecent(path, title) {
  try {
    // Never retain invite tokens in the recent-meetings list.
    const clean = path.split('?')[0];
    localStorage.setItem('ftos.windows.recent', JSON.stringify([{ path: clean, title, at: Date.now() }, ...readRecent().filter(r => r.path !== clean)].slice(0, 6)));
  } catch { /* A full disk should not block a meeting. */ }
}
function Home() {
  const { user, loading, displayName, logout } = useAuth();
  const router = useRouter();
  const [name, setName] = useState(rememberedName);
  const [invite, setInvite] = useState('');
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(true);
  const [version, setVersion] = useState('2.0.0');
  const [recent, setRecent] = useState(readRecent);
  useEffect(() => { native.getVersion().then(setVersion); }, []);
  useEffect(() => {
    let active = true;
    roomApi.health().then(value => { if (active) setHealth(value); }).catch(() => {}).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);
  async function checkConnection() {
    setChecking(true); setError('');
    try { setHealth(await roomApi.health()); } catch { setHealth(null); setError('The meeting server is unavailable. If Render is waking up, wait a minute and retry.'); }
    finally { setChecking(false); }
  }
  async function createMeeting() {
    if (!user) { setModal(true); return; }
    setBusy(true); setError('');
    try {
      const person = (displayName || name || 'My').trim(); rememberName(person);
      const title = `${person}'s room`;
      const result = await roomApi.createRoom(title);
      saveHostToken(result.roomId, result.hostToken);
      const path = `/room/${result.roomId}`;
      addRecent(path, title); router.push(path);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function joinMeeting(event) {
    event.preventDefault(); setError('');
    let route = urls.roomPath(invite.trim());
    if (!route && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invite.trim())) route = `/room/${invite.trim()}`;
    if (!route) { setError('Paste a FaceTimeOS invite link or the full room ID.'); return; }
    rememberName(displayName || name.trim()); addRecent(route, 'Joined meeting'); router.push(route);
  }
  return <div className="desktop-home">
    <aside className="desktop-sidebar">
      <a className="desktop-brand" href="/" onClick={e => e.preventDefault()}><span className="brand-symbol"><Icon type="video" /></span><span>FaceTimeOS<small>FOR WINDOWS</small></span></a>
      <div className="desktop-nav"><div className="selected"><Icon type="video" size={19} /> Meetings</div></div>
      <div className="sidebar-note"><span className="tiny-label">ONE SHARED SPACE</span><p>Good conversations.<br />Work that stays together.</p><span>Video, chat, notes and a whiteboard. Ready when you are.</span></div>
      <div className="sidebar-bottom"><button onClick={() => native.openWebsite()}>Open web app <span>↗</span></button><button onClick={() => native.openReleases()}>Downloads & updates <span>↗</span></button><small>FaceTimeOS {version}</small></div>
    </aside>
    <main className="desktop-content">
      <header className="desktop-top"><span>YOUR WORKSPACE</span><div><ThemeSwitcher />{user ? <button className="account-chip" onClick={() => logout().catch(e => setError(e.message))} title="Sign out"><span>{(displayName || user.email || '?')[0].toUpperCase()}</span>{displayName || user.email}<small>Sign out</small></button> : <button className="desktop-secondary" disabled={loading} onClick={() => setModal(true)}>Sign in</button>}</div></header>
      <section className="desktop-welcome"><span className="tiny-label">LET’S CONNECT</span><h1>{user ? `Welcome${displayName ? `, ${displayName.split(' ')[0]}` : ' back'}.` : 'A place to meet.\nA space to make progress.'}</h1><p>Start a conversation or pick up where you left off.</p></section>
      <div className="desktop-actions">
        <section className="meeting-action"><span className="action-icon"><Icon type="video" size={28} /></span><h2>Start a meeting</h2><p>A fresh room for your next conversation. Invite anyone with a link.</p>{!displayName && <label className="desktop-label">Your name<input value={name} onChange={e => setName(e.target.value)} maxLength={40} placeholder="How should we call you?" /></label>}<button className="desktop-primary" onClick={createMeeting} disabled={busy || loading}><Icon type="plus" size={18} />{busy ? 'Creating your room…' : 'New meeting'}</button></section>
        <section className="meeting-action"><span className="action-icon neutral"><Icon type="link" size={28} /></span><h2>Join a meeting</h2><p>Got an invite? Paste the room link or meeting ID below.</p><form onSubmit={joinMeeting}><label className="desktop-label">Meeting link or ID<input value={invite} onChange={e => setInvite(e.target.value)} placeholder="Paste an invitation link" required autoComplete="off" /></label><button className="desktop-secondary" type="submit">Join meeting <Icon type="arrow" size={18} /></button></form></section>
      </div>
      {error && <div className="desktop-error" role="alert">{error}</div>}
      <section className="desktop-recents"><div className="section-heading"><h2>Recent meetings</h2>{recent.length > 0 && <button onClick={() => { localStorage.removeItem('ftos.windows.recent'); setRecent([]); }}>Clear history</button>}</div>{recent.length ? recent.map(r => <button className="recent-row" key={r.path} onClick={() => router.push(r.path)}><span className="recent-icon"><Icon type="clock" size={19} /></span><span>{r.title}<small>{new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {r.path.split('/')[2].slice(0, 8)}</small></span><Icon type="arrow" size={18} /></button>) : <div className="recent-empty"><Icon type="clock" size={22} /><div>No meetings yet<small>Your recent rooms will appear here. Saved work stays with the room.</small></div></div>}</section>
      <footer className="desktop-status"><div><i className={checking ? 'pending' : health ? 'online' : 'offline'} /><span>{checking ? 'Connecting to Render… first connection can take a minute.' : health ? 'Meeting server connected' : 'Meeting server is unavailable'}</span></div><button disabled={checking} onClick={checkConnection}>{checking ? 'Checking…' : 'Check connection'}</button>{health && <small>TURN {health.turn ? 'configured' : 'not configured'} · {health.storage === 'firestore' ? 'Firestore enabled' : 'Cloud saving needs server setup'}</small>}</footer>
    </main>
    <AuthModal isOpen={modal} onClose={() => { setModal(false); native.cancelSignIn(); }} reason="Sign in to start a meeting" />
  </div>;
}
function CapturePicker() {
  const [sources, setSources] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { native.captureSources().then(setSources).catch(() => setError('Could not list screens. Cancel and try again.')); }, []);
  return <main className="capture-picker"><header><span className="tiny-label">SCREEN SHARING</span><h1>Choose what to share</h1><p>Only the screen or window you select will be visible to the room. Your microphone stays unchanged.</p></header><div className="capture-sources">{sources.map(s => <button key={s.id} className={selected === s.id ? 'chosen' : ''} aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}><img src={s.thumbnail} alt="" /><span>{s.name}</span></button>)}</div>{error && <p role="alert">{error}</p>}<footer><button className="desktop-secondary" onClick={() => native.selectCapture(null)}>Cancel</button><button className="desktop-primary" disabled={!selected} onClick={() => native.selectCapture(selected)}><Icon type="screen" size={18} />Share selected</button></footer></main>;
}
function App() {
  const route = useRoute(); const router = useRouter();
  const inRoom = route.startsWith('/room/');
  useEffect(() => { const unsubscribe = native.onRoomLink(path => router.push(path)); native.ready(); return unsubscribe; }, [router]);
  useEffect(() => { native.setInRoom(inRoom); }, [inRoom]);
  return inRoom ? <Room key={route.split('?')[0]} /> : <Home />;
}
class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? <main className="desktop-crash"><h1>Let’s reopen your workspace.</h1><p>The app ran into an unexpected problem. Your cloud-saved work is not removed.</p><button className="desktop-primary" onClick={() => { window.location.href = '/'; }}>Return home</button><details><summary>Technical details</summary><pre>{String(this.state.error.message)}</pre></details></main> : this.props.children; }
}
createRoot(document.getElementById('root')).render(<ErrorBoundary><ThemeProvider>{window.location.pathname === '/share-picker' ? <CapturePicker /> : <AuthProvider><App /></AuthProvider>}</ThemeProvider></ErrorBoundary>);
