'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useYMapValue } from '../../hooks/useYjs';

/**
 * A co-browsing surface: everyone in the room looks at the same page, and the
 * trail of pages is part of the room document, so it survives a reload.
 *
 * Four things were wrong with the previous version.
 *
 *  1. `sandbox="allow-scripts allow-same-origin"`. Those two together are the
 *     documented way to *undo* a sandbox — the framed document keeps script
 *     execution and a real origin, which is enough to reach storage and, for
 *     anything served from our own origin, the parent page. It is also simply
 *     not needed to display a page.
 *  2. `onError` on an `<iframe>` does not fire when a site refuses to be framed.
 *     `X-Frame-Options` / `frame-ancestors` blocks are invisible to script: the
 *     browser fires `load` for the error page and tells us nothing. So the
 *     "blocked" banner never appeared, and the widget looked broken instead.
 *  3. The URL was passed in as a prop and mirrored into state from an effect, so
 *     the first paint was always one render stale and nothing was persisted.
 *  4. `javascript:` and `data:` URLs were accepted verbatim from the address bar.
 *
 * Now: the shared trail lives in the CRDT `meta` map, framing is best-effort
 * with an honest explanation when we cannot tell, and known-unframeable URLs are
 * rewritten (YouTube → the embed player, Google → a frameable search) or refused
 * up front rather than showing a blank white rectangle.
 */

const HOME = 'https://en.m.wikipedia.org/wiki/WebRTC';
const DEFAULT_NAV = Object.freeze({ trail: [HOME], index: 0, at: 0, by: null });
const LOAD_GRACE_MS = 7000;

const BOOKMARKS = [
  { name: 'Wikipedia', icon: '📖', url: 'https://en.m.wikipedia.org/wiki/WebRTC' },
  { name: 'MDN', icon: '📚', url: 'https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API' },
  { name: 'DuckDuckGo', icon: '🔍', url: 'https://html.duckduckgo.com/html/?q=webrtc+mesh' },
  { name: 'Can I Use', icon: '✅', url: 'https://caniuse.com/?search=webrtc' },
  { name: 'Excalidraw', icon: '✏️', url: 'https://excalidraw.com/' },
];

/**
 * Hosts that send `X-Frame-Options: DENY|SAMEORIGIN` or a restrictive
 * `frame-ancestors`. This list is a courtesy, not a security boundary: it lets
 * us say "this will not load" before showing an empty frame for seven seconds.
 */
const REFUSES_FRAMING = [
  'google.com', 'github.com', 'stackoverflow.com', 'x.com', 'twitter.com',
  'facebook.com', 'instagram.com', 'linkedin.com', 'reddit.com', 'amazon.com',
  'netflix.com', 'medium.com', 'notion.so', 'figma.com', 'chatgpt.com',
  'claude.ai', 'gitlab.com', 'youtube.com', 'accounts.google.com', 'mail.google.com',
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function refusesFraming(url) {
  const host = hostOf(url);
  if (!host) return false;
  return REFUSES_FRAMING.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function searchUrl(query) {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

/** The YouTube id out of any of the three shapes people paste. */
function youtubeId(parsed) {
  const host = parsed.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') return parsed.pathname.slice(1).split('/')[0];
  if (host.endsWith('youtube.com')) {
    if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || '';
    const shorts = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
    if (shorts) return shorts[1];
  }
  return '';
}

/**
 * Turn whatever was typed into something we can actually put in a frame.
 * Returns `null` for anything that is not http(s) — an address bar that happily
 * runs `javascript:` in the room's own page is a cross-site-scripting hole with
 * a text cursor in it.
 */
function normalize(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https?:/i.test(raw)) return null;

  const looksLikeHost = !/\s/.test(raw) && /^[\w-]+(\.[\w-]+)+([/:?#]|$)/.test(raw);
  if (!hasScheme && !looksLikeHost) return { url: searchUrl(raw), rewritten: 'search' };

  let parsed;
  try {
    parsed = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { url: searchUrl(raw), rewritten: 'search' };
  }
  if (!/^https?:$/i.test(parsed.protocol)) return null;

  const video = youtubeId(parsed);
  if (video) {
    return {
      url: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video)}`,
      rewritten: 'youtube',
    };
  }

  const host = parsed.hostname.replace(/^www\./, '');
  if (host.endsWith('google.com') && parsed.pathname === '/search') {
    return { url: searchUrl(parsed.searchParams.get('q') || ''), rewritten: 'google' };
  }
  if (host === 'en.wikipedia.org') {
    return { url: `https://en.m.wikipedia.org${parsed.pathname}${parsed.search}`, rewritten: 'mobile' };
  }

  return { url: parsed.toString(), rewritten: null };
}

/** Never trust the document: another peer (or an old build) may have written junk. */
function sanitizeNav(value) {
  if (!value || typeof value !== 'object') return DEFAULT_NAV;
  const trail = Array.isArray(value.trail)
    ? value.trail.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(-40)
    : [];
  if (trail.length === 0) return DEFAULT_NAV;
  const index = Number.isInteger(value.index) ? Math.min(Math.max(value.index, 0), trail.length - 1) : trail.length - 1;
  return { trail, index, at: value.at || 0, by: typeof value.by === 'string' ? value.by : null };
}

export default function WebBrowser({
  meta,
  displayName,
  readOnly = false,
  onActivity,
}) {
  const [storedNav, writeNav] = useYMapValue(meta, 'browserNav', DEFAULT_NAV);
  // Solo/offline fallback: with no shared document the widget still works, it
  // just is not shared. Keeping the two shapes identical means the rest of the
  // component never needs to know which one it is looking at.
  const [localNav, setLocalNav] = useState(DEFAULT_NAV);
  const nav = useMemo(() => sanitizeNav(meta ? storedNav : localNav), [meta, storedNav, localNav]);
  const publishNav = meta ? writeNav : setLocalNav;

  const currentUrl = nav.trail[nav.index];
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState('page');
  const [results, setResults] = useState({ query: '', items: [], loading: false });
  const [frame, setFrame] = useState({ url: null, state: 'idle' });
  const [reloadKey, setReloadKey] = useState(0);
  const [dismissedWarning, setDismissedWarning] = useState('');

  const frameRef = useRef(null);
  const knownBlocked = refusesFraming(currentUrl);
  // Derived rather than stored: a stale `state` for a previous URL must read as
  // "loading" for the new one, and deriving it avoids a setState-in-effect.
  const frameState = knownBlocked ? 'refused' : frame.url === currentUrl ? frame.state : 'loading';
  const showBlock = frameState === 'refused' || (frameState === 'stalled' && dismissedWarning !== currentUrl);

  /* A frame that never loads gets a real explanation instead of white space.
     There is no event for a framing refusal, so a grace period is the only
     signal available — hence the wording of the panel: "probably". */
  useEffect(() => {
    if (frameState !== 'loading') return undefined;
    const url = currentUrl;
    const timer = setTimeout(() => setFrame({ url, state: 'stalled' }), LOAD_GRACE_MS);
    return () => clearTimeout(timer);
  }, [currentUrl, frameState]);

  const navigate = useCallback(
    (input) => {
      if (readOnly) return;
      const target = normalize(input);
      if (!target) {
        setResults({ query: input, items: [], loading: false });
        setView('results');
        return;
      }
      if (target.url === currentUrl) return;

      const trail = [...nav.trail.slice(0, nav.index + 1), target.url].slice(-40);
      publishNav({
        trail,
        index: trail.length - 1,
        at: Date.now(),
        by: displayName || null,
      });
      setDraft('');
      setEditing(false);
      setView('page');
      onActivity?.();
    },
    [readOnly, currentUrl, nav, publishNav, displayName, onActivity]
  );

  const step = useCallback(
    (delta) => {
      if (readOnly) return;
      const index = nav.index + delta;
      if (index < 0 || index >= nav.trail.length) return;
      publishNav({ ...nav, index, at: Date.now(), by: displayName || null });
      setDraft('');
      setEditing(false);
      setView('page');
    },
    [readOnly, nav, publishNav, displayName]
  );

  const reload = useCallback(() => {
    // Re-keying the iframe is the only way to force a reload of a cross-origin
    // document: `contentWindow.location.reload()` throws for another origin.
    setFrame({ url: null, state: 'idle' });
    setDismissedWarning('');
    setReloadKey((n) => n + 1);
  }, []);

  /**
   * The escape hatch for everything that refuses to be framed. Wikipedia's
   * opensearch endpoint is one of the few genuinely CORS-open search APIs, so
   * this is a real result list rather than a link that pretends to be one.
   */
  const search = useCallback(async (query) => {
    const q = String(query || '').trim();
    if (!q) return;
    setView('results');
    setResults({ query: q, items: [], loading: true });

    const fallback = [
      {
        title: `Search the web for “${q}”`,
        snippet: 'Opens a frameable DuckDuckGo results page inside the room.',
        link: searchUrl(q),
      },
    ];

    try {
      const res = await fetch(
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}` +
          '&limit=8&namespace=0&format=json&origin=*'
      );
      if (!res.ok) throw new Error(`wikipedia ${res.status}`);
      const data = await res.json();
      const [, titles = [], snippets = [], links = []] = Array.isArray(data) ? data : [];
      const items = titles.map((title, i) => ({
        title,
        snippet: snippets[i] || `Reference article: ${title}`,
        link: links[i] || `https://en.m.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      }));
      setResults({ query: q, items: [...items, ...fallback], loading: false });
    } catch {
      setResults({ query: q, items: fallback, loading: false });
    }
  }, []);

  const submit = useCallback(
    (event) => {
      event.preventDefault();
      if (readOnly) return;
      const value = draft.trim();
      if (!value) return;
      const target = normalize(value);
      if (!target) {
        setResults({
          query: value,
          items: [{ title: 'Only http and https addresses can be opened', snippet: `“${value}” was not loaded.`, link: null }],
          loading: false,
        });
        setView('results');
        return;
      }
      if (target.rewritten === 'search') {
        // A plain phrase goes to the result list, which always works, rather
        // than to a frame that may refuse us.
        search(value);
        return;
      }
      navigate(value);
    },
    [draft, readOnly, navigate, search]
  );

  const canBack = nav.index > 0;
  const canForward = nav.index < nav.trail.length - 1;
  const host = hostOf(currentUrl);

  return (
    <div className="flex h-full w-full select-none flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0f0f17] font-sans text-white">
      <div className="flex items-center gap-2 border-b border-white/10 bg-[#181824] px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={!canBack || readOnly}
            className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10 disabled:opacity-30"
            title="Back"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={!canForward || readOnly}
            className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10 disabled:opacity-30"
            title="Forward"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={reload}
            className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10"
            title="Reload"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>

        <form onSubmit={submit} className="relative flex flex-1 items-center">
          <span className="absolute left-3 text-[11px] text-white/60">{frameState === 'loading' ? '⏳' : '🔒'}</span>
          <input
            type="text"
            value={editing ? draft : currentUrl}
            onChange={(event) => {
              setDraft(event.target.value);
              setEditing(true);
            }}
            onFocus={() => {
              setDraft(currentUrl);
              setEditing(true);
            }}
            onBlur={() => setEditing(false)}
            readOnly={readOnly}
            spellCheck={false}
            placeholder="Search, or enter an address"
            className="w-full rounded-xl border border-white/10 bg-black/50 py-1.5 pl-8 pr-24 text-xs text-white placeholder-white/40 transition-colors focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={readOnly || !draft.trim()}
            className="absolute right-1 rounded-lg bg-blue-600 px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
          >
            Go
          </button>
        </form>

        <div className="flex items-center rounded-lg border border-white/10 bg-black/30 p-0.5 text-[10px]">
          <button
            type="button"
            onClick={() => setView('page')}
            className={`rounded-md px-2 py-1 font-semibold transition-colors ${
              view === 'page' ? 'bg-blue-600 text-white' : 'text-white/60 hover:text-white'
            }`}
          >
            Page
          </button>
          <button
            type="button"
            onClick={() => (results.items.length ? setView('results') : search(draft || host || 'webrtc'))}
            className={`rounded-md px-2 py-1 font-semibold transition-colors ${
              view === 'results' ? 'bg-blue-600 text-white' : 'text-white/60 hover:text-white'
            }`}
          >
            Results
          </button>
        </div>
      </div>

      <div className="custom-scrollbar flex items-center gap-2 overflow-x-auto border-b border-white/5 bg-[#12121c] px-3 py-1.5">
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-white/60">Bookmarks</span>
        {BOOKMARKS.map((bookmark) => (
          <button
            key={bookmark.name}
            type="button"
            onClick={() => navigate(bookmark.url)}
            disabled={readOnly}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-white/5 bg-white/5 px-2.5 py-1 text-[11px] text-white/80 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40"
          >
            <span>{bookmark.icon}</span>
            <span>{bookmark.name}</span>
          </button>
        ))}
      </div>

      <div className="relative flex-1 overflow-hidden bg-[#0a0a0f]">
        {view === 'results' ? (
          <div className="custom-scrollbar h-full w-full space-y-3 overflow-y-auto p-4">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="text-xs font-semibold text-blue-400">
                {results.loading ? 'Searching…' : `Results for “${results.query || '—'}”`}
              </span>
              <span className="text-[10px] text-white/60">Opening one shares it with the room</span>
            </div>

            {results.loading ? (
              <div className="flex flex-col items-center justify-center space-y-2 py-12">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                <span className="text-xs text-white/50">Fetching…</span>
              </div>
            ) : results.items.length === 0 ? (
              <p className="py-12 text-center text-xs text-white/60">
                Type a phrase in the address bar to search, or an address to open it for everyone.
              </p>
            ) : (
              results.items.map((item) => (
                <div
                  key={item.link || item.title}
                  className="space-y-1 rounded-xl border border-white/5 bg-white/5 p-3.5 transition-all hover:border-blue-500/30"
                >
                  {item.link ? (
                    <a
                      href={item.link}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(item.link);
                      }}
                      className="block text-sm font-bold text-blue-400 hover:underline"
                    >
                      {item.title}
                    </a>
                  ) : (
                    <p className="text-sm font-bold text-amber-300">{item.title}</p>
                  )}
                  <p className="text-xs leading-relaxed text-white/70">{item.snippet}</p>
                  {item.link && <span className="block truncate text-[10px] text-white/60">{item.link}</span>}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="relative h-full w-full bg-white">
            {frameState !== 'refused' && (
              <iframe
                // Re-mounting on navigation keeps the framed page out of the
                // room tab's own session history, so the browser Back button
                // still leaves the call instead of stepping through the frame.
                key={`${currentUrl}#${reloadKey}`}
                ref={frameRef}
                src={currentUrl}
                className="h-full w-full border-none"
                // No `allow-same-origin`: with it, the sandbox is decorative.
                // No `allow-popups` or top-navigation either — a framed page has
                // no business opening windows or moving the room out from under
                // the call. Some heavy embeds degrade without storage access;
                // that is the trade we are making on purpose.
                sandbox="allow-scripts allow-forms"
                referrerPolicy="no-referrer"
                title="Shared browser"
                onLoad={() => setFrame({ url: currentUrl, state: 'loaded' })}
              />
            )}

            {showBlock && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center space-y-3 bg-[#0f0f17] p-6 text-center">
                <span className="text-3xl">🛡️</span>
                <h4 className="text-sm font-bold text-white">
                  {frameState === 'refused' ? `${host} does not allow embedding` : `${host} is not loading`}
                </h4>
                <p className="max-w-sm text-xs leading-relaxed text-white/60">
                  {frameState === 'refused'
                    ? 'This site sends a header that forbids being shown inside another page. No browser can override that, so there is nothing to load here.'
                    : 'Nothing arrived within a few seconds. Either the site is slow or it is refusing to be framed — a refusal is invisible to scripts, so we cannot tell which.'}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => search(host.replace(/^www\./, '') || 'webrtc')}
                    className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
                  >
                    Search instead
                  </button>
                  <a
                    href={currentUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded-xl bg-white/10 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/20"
                  >
                    Open in a new tab
                  </a>
                  {frameState === 'stalled' && (
                    <button
                      type="button"
                      onClick={() => setDismissedWarning(currentUrl)}
                      className="rounded-xl px-3 py-2 text-xs font-semibold text-white/60 transition-colors hover:text-white"
                    >
                      Keep waiting
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-[#181824] px-3 py-1.5 text-[10px] text-white/50">
        <span className="truncate">
          {meta ? 'Shared with the room · saved in this room’s history' : 'Not shared — no room document'}
          {nav.by ? ` · opened by ${nav.by}` : ''}
        </span>
        <span className="shrink-0">
          {nav.index + 1}/{nav.trail.length}
          {readOnly && <span className="ml-2 font-semibold text-amber-400">View only</span>}
        </span>
      </div>
    </div>
  );
}
