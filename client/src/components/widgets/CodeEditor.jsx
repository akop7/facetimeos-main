'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useYMapValue } from '../../hooks/useYjs';
import { getAwarenessColor } from '../../lib/crdt';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

/**
 * Shared code editor.
 *
 * Three things were wrong with the previous version.
 *
 *  1. The Yjs binding replaced the whole buffer on every keystroke
 *     (`delete(0, length)` + `insert(0, value)`) — the same quadratic,
 *     merge-destroying pattern the notes widget had. Monaco already reports
 *     character-level ranges, so those go straight into `Y.Text` operations now,
 *     and incoming operations become Monaco edits instead of `setValue`, which
 *     was discarding everyone's selection, folding and undo stack on every
 *     remote keypress.
 *  2. The sandbox accepted `message` events from any window with no shared
 *     secret, so anything else on the page could feed fake output into the
 *     console. Results are matched on the source window *and* a per-run nonce.
 *  3. TypeScript claimed to be "transpiled and executed locally" and was in
 *     fact handed to `eval` verbatim, so a single type annotation was a syntax
 *     error. It now goes through Monaco's own TypeScript worker, and if that
 *     worker is unavailable the UI says so instead of pretending.
 */

const ORIGIN_MONACO = 'monaco-local';

export const LANGUAGES = Object.freeze({
  javascript: { label: 'JavaScript', ext: 'js', run: 'js' },
  typescript: { label: 'TypeScript', ext: 'ts', run: 'ts' },
  html: { label: 'HTML', ext: 'html', run: 'html' },
  css: { label: 'CSS', ext: 'css', run: 'css' },
  json: { label: 'JSON', ext: 'json', run: null },
  python: { label: 'Python', ext: 'py', run: null },
  java: { label: 'Java', ext: 'java', run: null },
  cpp: { label: 'C++', ext: 'cpp', run: null },
});

/**
 * Monaco decorations take a class name, never inline styles, so each remote
 * colour needs a real rule. One stylesheet, grown as new peers appear.
 */
const cursorClasses = new Map();

function cursorStyleFor(color) {
  const existing = cursorClasses.get(color);
  if (existing) return existing;

  const key = `c${cursorClasses.size}`;
  const entry = { caret: `ftos-caret-${key}`, selection: `ftos-sel-${key}` };
  cursorClasses.set(color, entry);

  if (typeof document !== 'undefined') {
    let sheet = document.getElementById('ftos-remote-carets');
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.id = 'ftos-remote-carets';
      document.head.appendChild(sheet);
    }
    sheet.appendChild(
      document.createTextNode(
        `.${entry.caret}{border-left:2px solid ${color};margin-left:-1px;}` +
          `.${entry.selection}{background:${color}33;}`
      )
    );
  }
  return entry;
}

/** Embed a string in a `<script>` without letting it close the tag. */
function embed(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

function harness(code, nonce) {
  return `<!DOCTYPE html><html><body><script>
(function () {
  var logs = [];
  var fmt = function () {
    return Array.prototype.map.call(arguments, function (a) {
      if (a === undefined) return 'undefined';
      if (a === null) return 'null';
      if (typeof a === 'object') { try { return JSON.stringify(a, null, 2); } catch (e) { return String(a); } }
      return String(a);
    }).join(' ');
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    console[level] = function () {
      logs.push((level === 'log' ? '' : '[' + level + '] ') + fmt.apply(null, arguments));
    };
  });
  window.onerror = function (message) { logs.push('[error] ' + message); };
  try {
    var result = (0, eval)(${embed(code)});
    if (result !== undefined) logs.push('=> ' + fmt(result));
  } catch (e) {
    logs.push('[' + ((e && e.name) || 'Error') + '] ' + ((e && e.message) || String(e)));
  }
  parent.postMessage({ type: 'ftos-exec', nonce: ${embed(nonce)}, output: logs.join('\\n') }, '*');
})();
<\/script></body></html>`;
}

function runInSandbox(code, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const nonce =
      globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    // No `allow-same-origin`: the frame must not be able to reach back into the
    // app's DOM, storage or cookies.
    iframe.sandbox = 'allow-scripts';
    document.body.appendChild(iframe);

    let settled = false;
    const finish = (output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
      resolve(output);
    };

    const timer = setTimeout(
      () => finish(`[timeout] Stopped after ${Math.round(timeoutMs / 1000)}s — infinite loop?`),
      timeoutMs
    );

    const onMessage = (event) => {
      // A sandbox without `allow-same-origin` has a null origin, so the origin
      // check everyone reaches for is useless here. The source window plus a
      // nonce minted for this single run is what actually identifies the reply.
      if (event.source !== iframe.contentWindow) return;
      if (!event.data || event.data.type !== 'ftos-exec' || event.data.nonce !== nonce) return;
      finish(event.data.output || 'Finished with no output.');
    };

    window.addEventListener('message', onMessage);
    iframe.srcdoc = harness(code, nonce);
  });
}

/**
 * Real transpilation, using the TypeScript worker Monaco already runs for
 * diagnostics. Returns null when the worker is unavailable — the caller reports
 * that rather than silently running TypeScript as JavaScript.
 */
async function transpileTypeScript(monaco, model) {
  const getWorker = monaco?.languages?.typescript?.getTypeScriptWorker;
  if (!getWorker || !model) return null;
  try {
    const worker = await getWorker();
    const client = await worker(model.uri);
    const emitted = await client.getEmitOutput(model.uri.toString());
    const file = emitted?.outputFiles?.find((f) => /\.jsx?$/.test(f.name)) || emitted?.outputFiles?.[0];
    return typeof file?.text === 'string' ? file.text : null;
  } catch {
    return null;
  }
}

const CSS_PREVIEW = (css) =>
  `<!DOCTYPE html><html><head><style>${css}</style></head><body>` +
  `<h1>Heading</h1><p>Paragraph text with a <a href="#">link</a>.</p>` +
  `<button>Button</button><div class="demo box card">Element with class "demo box card"</div>` +
  `</body></html>`;

export default function CodeEditor({
  yText,
  awareness,
  meta,
  peerId,
  displayName,
  readOnly = false,
  onActivity,
}) {
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorationsRef = useRef([]);
  const collectionRef = useRef(null);
  const applyingRemoteRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [isExecuting, setIsExecuting] = useState(false);
  const [dismissedAt, setDismissedAt] = useState(0);
  const [collaborators, setCollaborators] = useState([]);
  const [localRun, setLocalRun] = useState(null);
  const [localLanguage, setLocalLanguage] = useState('javascript');

  const [metaLanguage, writeMetaLanguage] = useYMapValue(meta, 'codeLanguage', 'javascript');
  const [metaRun, writeMetaRun] = useYMapValue(meta, 'codeRun', null);

  // Language and output live in the shared meta map when there is one, so
  // "switch to Python" and "here is what it printed" are things the whole room
  // sees. No other meeting tool shows you your colleague's console. Falls back
  // to local state when the widget is rendered outside a room.
  const requested = meta ? metaLanguage : localLanguage;
  const language = LANGUAGES[requested] ? requested : 'javascript';
  const run = meta ? metaRun : localRun;
  const publishRun = meta ? writeMetaRun : setLocalRun;
  const setLanguage = meta ? writeMetaLanguage : setLocalLanguage;

  // Derived rather than an effect: the console reopens on its own whenever a new
  // run lands (including someone else's), and stays shut once you dismiss that
  // particular run.
  const showOutput = Boolean(run?.at) && run.at > dismissedAt;

  const handleMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    collectionRef.current = editor.createDecorationsCollection?.([]) || null;
    setReady(true);
  }, []);

  // ---- Character-level binding, both directions -------------------------------
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!ready || !editor || !monaco || !yText) return undefined;

    const initial = yText.toString();
    const model = editor.getModel();
    if (model && model.getValue() !== initial) {
      // The only wholesale replace left, and only once, when binding.
      applyingRemoteRef.current = true;
      model.setValue(initial);
      applyingRemoteRef.current = false;
    }

    const observer = (event, transaction) => {
      if (transaction.origin === ORIGIN_MONACO) return;
      const target = editor.getModel();
      if (!target) return;

      applyingRemoteRef.current = true;
      let index = 0;
      for (const op of event.delta || []) {
        if (op.retain) {
          index += op.retain;
        } else if (typeof op.insert === 'string') {
          const at = target.getPositionAt(index);
          target.applyEdits([
            {
              range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column),
              text: op.insert,
              forceMoveMarkers: true,
            },
          ]);
          index += op.insert.length;
        } else if (op.delete) {
          const from = target.getPositionAt(index);
          const to = target.getPositionAt(index + op.delete);
          target.applyEdits([
            { range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: '' },
          ]);
        }
      }
      applyingRemoteRef.current = false;
    };
    yText.observe(observer);

    const contentListener = editor.onDidChangeModelContent((event) => {
      if (applyingRemoteRef.current || readOnly) return;
      if (event.isFlush) return; // a setValue from elsewhere; not a user edit
      yText.doc?.transact(() => {
        // Highest offset first: every change is expressed in pre-edit
        // coordinates, so applying a low one would shift the rest.
        [...event.changes]
          .sort((a, b) => b.rangeOffset - a.rangeOffset)
          .forEach((change) => {
            if (change.rangeLength > 0) yText.delete(change.rangeOffset, change.rangeLength);
            if (change.text) yText.insert(change.rangeOffset, change.text);
          });
      }, ORIGIN_MONACO);
      onActivity?.();
    });

    return () => {
      yText.unobserve(observer);
      contentListener.dispose();
    };
  }, [ready, yText, readOnly, onActivity]);

  // ---- Publish my caret ---------------------------------------------------------
  useEffect(() => {
    const editor = editorRef.current;
    if (!ready || !editor || !awareness) return undefined;

    const publish = () => {
      const model = editor.getModel();
      const selection = editor.getSelection();
      if (!model || !selection) return;
      const start = model.getOffsetAt(selection.getStartPosition());
      const end = model.getOffsetAt(selection.getEndPosition());
      awareness.setLocalStateField('cursor', {
        widget: 'code',
        index: start,
        length: end - start,
        at: Date.now(),
      });
    };

    const moved = editor.onDidChangeCursorSelection(publish);
    const blurred = editor.onDidBlurEditorWidget(() => awareness.setLocalStateField('cursor', null));
    publish();
    return () => {
      moved.dispose();
      blurred.dispose();
    };
  }, [ready, awareness]);

  // ---- Draw everyone else's carets ---------------------------------------------
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!ready || !editor || !monaco || !awareness) return undefined;

    const paint = () => {
      const model = editor.getModel();
      if (!model) return;
      const max = model.getValueLength();
      const clamp = (n) => Math.max(0, Math.min(max, n));
      const decorations = [];
      const people = [];

      awareness.getStates().forEach((state, clientId) => {
        if (!state) return;
        const id = state.peerId || String(clientId);
        if (peerId && id === peerId) return;
        const color = state.color || getAwarenessColor(id);
        const name = state.name || 'Guest';
        const cursor = state.cursor;
        const here = cursor?.widget === 'code';
        people.push({ id, name, color, here });
        if (!here || typeof cursor.index !== 'number') return;

        const css = cursorStyleFor(color);
        const from = model.getPositionAt(clamp(cursor.index));
        const to = model.getPositionAt(clamp(cursor.index + (cursor.length || 0)));
        if (cursor.length) {
          decorations.push({
            range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
            options: { className: css.selection, hoverMessage: { value: `${name}'s selection` } },
          });
        }
        decorations.push({
          range: new monaco.Range(to.lineNumber, to.column, to.lineNumber, to.column),
          options: { className: css.caret, hoverMessage: { value: name } },
        });
      });

      if (collectionRef.current) collectionRef.current.set(decorations);
      else decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
      setCollaborators(people);
    };

    paint();
    awareness.on('change', paint);
    // Remote text edits move every offset after them, so repaint on content too.
    const contentSub = editor.onDidChangeModelContent(paint);

    return () => {
      awareness.off('change', paint);
      contentSub.dispose();
      if (collectionRef.current) collectionRef.current.clear();
      else decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    };
  }, [ready, awareness, peerId]);

  const handleSave = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const blob = new Blob([editor.getValue()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `facetimeos-shared.${LANGUAGES[language].ext}`;
    link.click();
    // Revoking in the same tick can cancel the download in Firefox.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [language]);

  const handleRun = useCallback(async () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor) return;

    const source = editor.getValue();
    const mode = LANGUAGES[language].run;
    const stamp = { by: displayName || 'Someone', at: Date.now(), language };

    if (!mode) {
      publishRun({
        ...stamp,
        output:
          `${LANGUAGES[language].label} has no interpreter in a browser tab, so nothing was run.\n` +
          `Save the file and run it locally — the editor itself stays shared either way.`,
      });
      return;
    }

    if (mode === 'html' || mode === 'css') {
      publishRun({ ...stamp, html: mode === 'css' ? CSS_PREVIEW(source) : source });
      return;
    }

    setIsExecuting(true);
    publishRun({ ...stamp, output: 'Running…' });
    try {
      let js = source;
      if (mode === 'ts') {
        js = await transpileTypeScript(monaco, editor.getModel());
        if (js == null) {
          publishRun({
            ...stamp,
            output:
              "Monaco's TypeScript worker did not respond, so nothing was executed.\n" +
              'This code was deliberately not passed to the JavaScript sandbox: type annotations are not valid JS.',
          });
          return;
        }
      }
      publishRun({ ...stamp, output: await runInSandbox(js) });
    } catch (error) {
      publishRun({ ...stamp, output: `[${error?.name || 'Error'}] ${error?.message || error}` });
    } finally {
      setIsExecuting(false);
    }
  }, [language, displayName, publishRun]);

  const clock = (at) =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="flex flex-col h-full w-full bg-[#1e1e1e] text-white overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[#252526] border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            disabled={readOnly}
            aria-label="Language"
            className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs outline-none focus:border-indigo-500 transition-colors cursor-pointer disabled:opacity-50"
          >
            {Object.entries(LANGUAGES).map(([value, info]) => (
              <option key={value} value={value} className="bg-[#1e1e1e]">
                {info.label}
              </option>
            ))}
          </select>

          {collaborators.length > 0 && (
            <div className="flex items-center -space-x-1.5" aria-label="Collaborators">
              {collaborators.slice(0, 5).map((person) => (
                <span
                  key={person.id}
                  title={person.here ? `${person.name} — editing` : person.name}
                  className={`w-5 h-5 rounded-full grid place-items-center text-[9px] font-bold text-black/80 ring-2 ring-[#252526] ${
                    person.here ? '' : 'opacity-40'
                  }`}
                  style={{ background: person.color }}
                >
                  {person.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden sm:flex items-center gap-1 border-r border-white/10 pr-2">
            <button
              type="button"
              onClick={() => setFontSize((s) => Math.max(9, s - 1))}
              className="px-2 py-1 hover:bg-white/10 rounded text-xs"
              aria-label="Smaller font"
            >
              A−
            </button>
            <span className="text-[10px] text-white/60 tabular-nums">{fontSize}px</span>
            <button
              type="button"
              onClick={() => setFontSize((s) => Math.min(28, s + 1))}
              className="px-2 py-1 hover:bg-white/10 rounded text-xs"
              aria-label="Larger font"
            >
              A+
            </button>
          </div>

          <button
            type="button"
            onClick={handleSave}
            className="px-2.5 py-1 hover:bg-white/10 rounded text-xs text-white/80 transition-colors flex items-center gap-1"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
            </svg>
            Save
          </button>

          <button
            type="button"
            onClick={handleRun}
            disabled={isExecuting || !ready}
            title="Runs here and shows the result to everyone in the room"
            className="px-2.5 py-1 bg-green-600/80 hover:bg-green-600 rounded text-xs text-white transition-colors flex items-center gap-1 disabled:opacity-50"
          >
            {isExecuting ? 'Running…' : '▶ Run'}
          </button>
        </div>
      </div>

      <div className={`w-full relative min-h-0 ${showOutput ? 'flex-[3]' : 'flex-1'}`}>
        <MonacoEditor
          height="100%"
          language={language}
          theme="vs-dark"
          onMount={handleMount}
          loading={
            <div className="flex items-center justify-center h-full text-white/60 text-sm">
              Loading editor…
            </div>
          }
          options={{
            fontSize,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            minimap: { enabled: false },
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 12 },
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            renderLineHighlight: 'gutter',
            bracketPairColorization: { enabled: true },
            readOnly,
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          }}
        />
        {readOnly && (
          <div className="absolute top-2 right-3 px-2 py-0.5 rounded bg-black/60 text-[10px] text-white/60 pointer-events-none">
            view only
          </div>
        )}
      </div>

      {showOutput && (
        <div className="flex-[2] flex flex-col border-t border-white/10 bg-[#1e1e1e] min-h-[110px]">
          <div className="flex items-center justify-between px-3 py-1.5 bg-[#2d2d2d] border-b border-white/5 shrink-0">
            <span className="text-[11px] font-mono text-white/60 uppercase tracking-wider">
              Output
            </span>
            <div className="flex items-center gap-3">
              {run?.at && (
                <span className="text-[10px] text-white/35">
                  {run.by} · {clock(run.at)}
                </span>
              )}
              <button
                type="button"
                onClick={() => setDismissedAt(run?.at || Date.now())}
                className="text-white/60 hover:text-white/90 text-sm leading-none"
                aria-label="Hide output"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-3 min-h-0 custom-scrollbar">
            {run?.html ? (
              <iframe
                srcDoc={run.html}
                className="w-full h-full bg-white rounded-sm border-none"
                sandbox="allow-scripts"
                title="Preview"
              />
            ) : (
              <pre className="font-mono text-xs text-white/90 whitespace-pre-wrap break-words">
                {run?.output || 'Nothing has been run yet.'}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
