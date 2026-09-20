'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Room chat, backed by the shared document.
 *
 * The old panel took `messages` from React state in the room page, each entry
 * carrying a pre-rendered `timestamp` string and an `isLocal` boolean baked in
 * by the sender. Three problems: a late joiner saw nothing that was said before
 * they arrived, a reload wiped the conversation, and `isLocal` was decided by
 * whoever constructed the message rather than by who is reading it — so a
 * relayed message could render as your own.
 *
 * Now the transcript is a `Y.Array` in the room document: ordered, persisted,
 * available to a late joiner in full, and part of the exported bundle. `isLocal`
 * is derived here from `from === localPeerId`, and the time is formatted at
 * render from the stored epoch, so it is correct in every reader's timezone.
 */

const QUICK = ['👍', '❤️', '😂', '🎉', '🔥', '👏'];

function timeOf(at) {
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Group consecutive messages from one person so the name is not repeated. */
function groupMessages(messages) {
  const groups = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    const sameSender = last && last.from === message.from;
    const closeInTime = last && Math.abs((message.at || 0) - (last.at || 0)) < 120_000;
    if (sameSender && closeInTime) {
      last.items.push(message);
      last.at = message.at;
    } else {
      groups.push({ from: message.from, name: message.name, at: message.at, items: [message] });
    }
  }
  return groups;
}

export default function ChatPanel({
  isOpen,
  onClose,
  messages = [],
  localPeerId,
  readOnly = false,
  typingNames = [],
  onSend,
  onTyping,
}) {
  const [draft, setDraft] = useState('');
  const endRef = useRef(null);
  const inputRef = useRef(null);

  const groups = useMemo(() => groupMessages(messages), [messages]);

  /* Scroll to the newest message. This is a DOM side effect, not a state write,
     so it belongs in an effect. */
  useEffect(() => {
    if (!isOpen) return;
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [isOpen, messages.length]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const send = useCallback(
    (event) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text || readOnly) return;
      onSend?.(text);
      setDraft('');
    },
    [draft, readOnly, onSend]
  );

  const change = useCallback(
    (event) => {
      setDraft(event.target.value);
      onTyping?.();
    },
    [onTyping]
  );

  if (!isOpen) return null;

  return (
    <div
      className="room-side-panel room-drawer ftos-fade flex flex-col overflow-hidden"
      style={{
        background: 'var(--surface-panel)',
        borderColor: 'var(--surface-border)',
        backdropFilter: 'blur(20px)',
      }}
    >
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ background: 'var(--surface-raised)', borderColor: 'var(--surface-border)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-[-0.01em] text-[var(--on-surface)]">Chat</span>
          <span className="text-xs text-[var(--on-surface-muted)]">
            {messages.length} {messages.length === 1 ? 'message' : 'messages'}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-[var(--on-surface-muted)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--on-surface)]"
          aria-label="Close chat"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div className="custom-scrollbar flex-1 space-y-4 overflow-y-auto p-4">
        {groups.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center text-[var(--on-surface-muted)]">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-60" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <p className="text-sm font-medium text-[var(--on-surface)]">No messages yet</p>
            <p className="mt-1 max-w-[15rem] text-[13px] leading-5 text-[var(--on-surface-muted)]">
              Messages stay with the room for anyone who joins later.
            </p>
          </div>
        ) : (
          groups.map((group) => {
            const isLocal = group.from === localPeerId;
            return (
              <div
                key={`${group.from}-${group.items[0].id}`}
                className={`flex flex-col ${isLocal ? 'items-end' : 'items-start'}`}
              >
                <div className="mb-1 flex items-center gap-1.5 px-1 text-xs text-[var(--on-surface-muted)]">
                  <span className="font-semibold text-stone-700 dark:text-white/80">
                    {isLocal ? 'You' : group.name || 'Participant'}
                  </span>
                  <span>·</span>
                  <span>{timeOf(group.at)}</span>
                </div>
                <div className={`flex w-full flex-col gap-1 ${isLocal ? 'items-end' : 'items-start'}`}>
                  {group.items.map((message) => (
                    <div
                      key={message.id}
                      className={`max-w-[88%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[13px] leading-5 ${
                        isLocal
                          ? 'rounded-tr-sm bg-[var(--accent-primary,#3b82f6)] text-white'
                          : 'rounded-tl-sm border border-[var(--surface-border)] bg-[var(--surface-raised)] text-[var(--on-surface)]'
                      }`}
                    >
                      {message.text}
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      {typingNames.length > 0 && (
        <div className="px-4 pb-1 text-[11px] italic text-[var(--on-surface-muted)]">
          {typingNames.slice(0, 2).join(', ')}
          {typingNames.length > 2 ? ` and ${typingNames.length - 2} more` : ''}
          {typingNames.length === 1 ? ' is typing…' : ' are typing…'}
        </div>
      )}

      {!readOnly && (
        <div
          className="flex items-center justify-around border-t bg-[var(--bg-muted)] px-3 py-1"
          style={{ borderColor: 'var(--surface-border)' }}
        >
          {QUICK.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => setDraft((prev) => prev + emoji)}
              className="rounded p-1 text-sm transition-transform hover:scale-125 hover:bg-[var(--bg-muted)]"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={send}
        className="flex items-center gap-2 border-t p-3"
        style={{ borderColor: 'var(--surface-border)', background: 'var(--surface-raised)' }}
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={change}
          maxLength={2000}
          disabled={readOnly}
          placeholder={readOnly ? 'View-only access' : 'Message the room…'}
          className="field-input flex-1 !border-[var(--surface-border)] !bg-[var(--bg-input)] !py-2 text-[13px] text-[var(--on-surface)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!draft.trim() || readOnly}
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent-primary)] text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Send"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
    </div>
  );
}
