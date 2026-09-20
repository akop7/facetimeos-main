'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { applyTextDiff } from '../../hooks/useYjs';

/**
 * Shared notes.
 *
 * The old version replaced the entire document on every keystroke
 * (`delete(0, length)` then `insert(0, value)`). Three consequences, all bad:
 * every character produced an update the size of the whole document, the work
 * was quadratic in document length, and — because a wholesale replace is not a
 * character-level edit — two people typing at once silently clobbered each
 * other instead of merging. `applyTextDiff` sends only what changed.
 *
 * It also assigned `textareaRef.current.value` alongside React's `value` prop,
 * fighting its own controlled input. The `Y.Text` is now the single source of
 * truth, read through `useSyncExternalStore`, with the caret remapped on remote
 * edits so it does not jump to the end when someone types above you.
 */
export default function LiveNotes({ yText, readOnly = false, onActivity }) {
  const textareaRef = useRef(null);
  const [remoteEdits, setRemoteEdits] = useState(0);
  // Only used when there is no shared document (widget opened outside a room):
  // a controlled textarea bound to a store that never changes would look frozen.
  const [offlineValue, setOfflineValue] = useState('');

  const subscribe = useCallback(
    (onStoreChange) => {
      if (!yText) return () => {};
      yText.observe(onStoreChange);
      return () => yText.unobserve(onStoreChange);
    },
    [yText]
  );

  const shared = useSyncExternalStore(
    subscribe,
    () => (yText ? yText.toString() : ''),
    () => ''
  );

  const value = yText ? shared : offlineValue;

  useEffect(() => {
    if (!yText) return undefined;

    const observer = (event, transaction) => {
      if (transaction.local) return;
      setRemoteEdits((n) => n + 1);

      const el = textareaRef.current;
      if (!el) return;

      // Shift the caret by however much text was inserted or deleted *before*
      // it. Without this, a colleague typing in an earlier paragraph drags your
      // cursor to the end of the document mid-sentence.
      const caret = el.selectionStart ?? 0;
      const caretEnd = el.selectionEnd ?? caret;
      let delta = 0;
      let position = 0;
      for (const op of event.delta || []) {
        if (op.retain) {
          position += op.retain;
        } else if (typeof op.insert === 'string') {
          if (position <= caret) delta += op.insert.length;
          position += op.insert.length;
        } else if (op.delete) {
          if (position < caret) delta -= Math.min(op.delete, caret - position);
        }
      }

      const length = yText.length;
      const clamp = (n) => Math.max(0, Math.min(length, n));
      requestAnimationFrame(() => {
        try {
          el.setSelectionRange(clamp(caret + delta), clamp(caretEnd + delta));
        } catch {
          /* the element may have been unmounted */
        }
      });
    };

    yText.observe(observer);
    return () => yText.unobserve(observer);
  }, [yText]);

  const handleChange = useCallback(
    (event) => {
      const next = event.target.value;
      if (readOnly) return;
      if (!yText) {
        setOfflineValue(next);
        return;
      }
      applyTextDiff(yText, next);
      onActivity?.();
    },
    [yText, readOnly, onActivity]
  );

  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  return (
    /* Notes are prose, so unlike the code editor this widget follows the theme
       instead of being permanently dark. It used to pair `--bg-primary` (which is
       #fafaf9 in light mode) with `text-white/90`, i.e. white on white. */
    <div className="flex flex-col h-full w-full bg-[var(--surface-panel)] text-[var(--on-surface)] overflow-hidden">
      <div className="px-3 py-2 bg-[var(--surface-raised)] border-b border-[var(--surface-border)] flex items-center justify-between shrink-0">
        <span className="text-[var(--on-surface-muted)] text-xs">
          {words} {words === 1 ? 'word' : 'words'}
          {readOnly && <span> · view only</span>}
        </span>
        <span className="text-[var(--on-surface-muted)] text-xs flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${yText ? 'bg-green-500' : 'bg-amber-500'}`}
            aria-hidden="true"
          />
          {yText ? 'Saved with the room' : 'Not shared'}
        </span>
      </div>

      <div className="flex-1 overflow-hidden min-h-0 p-4">
        <label className="sr-only" htmlFor="live-notes">
          Shared meeting notes
        </label>
        <textarea
          id="live-notes"
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          placeholder={
            readOnly
              ? 'The host has not granted you edit access.'
              : 'Take notes together. Everything here is stored with the room and restored next time.'
          }
          className="w-full h-full bg-transparent text-[var(--on-surface)] resize-none outline-none font-sans text-sm leading-relaxed placeholder-[var(--on-surface-muted)] custom-scrollbar"
          spellCheck="false"
          readOnly={readOnly}
          aria-readonly={readOnly}
        />
      </div>

      <div className="px-3 py-1.5 text-[11px] text-[var(--on-surface-muted)] border-t border-[var(--surface-border)] shrink-0">
        {remoteEdits > 0 ? `${remoteEdits} incoming edits merged` : 'No remote edits yet'}
      </div>
    </div>
  );
}
