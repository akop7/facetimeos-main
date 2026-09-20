'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useTheme } from '../../context/ThemeContext';

export default function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const options = [
    { value: 'light', label: 'Light', icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
    )},
    { value: 'dark', label: 'Dark', icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
    )},
    { value: 'system', label: 'System', icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
    )}
  ];

  const current = options.find(o => o.value === theme);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent transition-colors hover:border-[var(--border-subtle)] hover:bg-[var(--bg-muted)]"
        style={{ color: 'var(--text-secondary)', background: isOpen ? 'var(--bg-input)' : 'transparent' }}
        title={`Theme: ${current?.label}`}
        aria-label={`Theme: ${current?.label}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        {current?.icon}
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 min-w-[150px] overflow-hidden rounded-lg py-1.5 animate-scale-in"
          style={{
            background: 'var(--surface-panel)',
            border: '1px solid var(--surface-border)',
            boxShadow: '0 18px 44px rgba(0,0,0,0.22)',
          }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              role="menuitemradio"
              aria-checked={theme === opt.value}
              onClick={() => { setTheme(opt.value); setIsOpen(false); }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium transition-colors"
              style={{
                color: theme === opt.value ? 'var(--accent-primary)' : 'var(--text-secondary)',
                // `--bg-card` is a 3% white overlay in dark mode, so the selected
                // row had no fill and the menu looked like nothing was chosen.
                background: theme === opt.value ? 'var(--surface-raised)' : 'transparent',
              }}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
