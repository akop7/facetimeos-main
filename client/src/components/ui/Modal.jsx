'use client';

import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

/**
 * A portalled dialog.
 *
 * The `mounted` flag this used to carry was set from inside the same effect that
 * bound the Escape key — a `set-state-in-effect` error, and a cascading render on
 * every open. What it was really asking is "has this component hydrated yet?",
 * because `createPortal(…, document.body)` cannot run on the server and rendering
 * the portal on the very first client render would not match the server's markup.
 *
 * `useSyncExternalStore` answers that question directly: `false` in the server
 * snapshot, `true` once React is running on the client, and no state to write.
 */

/* Never changes after hydration, so the store has nothing to notify. */
const subscribeNever = () => () => {};

export default function Modal({ isOpen, onClose, title, children, labelledBy }) {
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  );

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const panelRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current?.();
      }
    };

    window.addEventListener('keydown', handleKey);
    // Restore whatever was there rather than hard-coding 'unset': nested dialogs
    // and the room's own overlays also lock scrolling.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus in, or the dialog is unreachable by keyboard and screen readers
    // keep reading the page behind it.
    const previouslyFocused = document.activeElement;
    const target =
      panelRef.current?.querySelector(
        'input, textarea, select, button:not([data-modal-close]), [href], [tabindex]:not([tabindex="-1"])'
      ) || panelRef.current;
    target?.focus?.();

    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [isOpen]);

  const stop = useCallback((event) => event.stopPropagation(), []);

  if (!hydrated || !isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={labelledBy ? undefined : title}
      aria-labelledby={labelledBy}
    >
      <div
        className="dialog-backdrop absolute inset-0 transition-opacity"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={stop}
        className="dialog-surface ftos-fade relative w-full max-w-md overflow-hidden"
        style={{
          background: 'var(--bg-secondary)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div
          className="flex items-center justify-between p-5"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          {/* Was `text-white`, which was invisible on the light theme. */}
          <h3 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h3>
          <button
            type="button"
            data-modal-close
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            style={{ color: 'var(--text-secondary)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}
