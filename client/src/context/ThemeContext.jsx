'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';

/**
 * Theme, without mirroring external state into React state.
 *
 * The old provider read `localStorage` in an effect and pushed the result into
 * state, and derived `resolvedTheme` by calling `setResolvedTheme` from inside a
 * second effect. Both are cascading renders (the React Compiler lint rejects the
 * first outright), and the visible symptom was a flash of the wrong theme on
 * every page load: the first paint used the default, then an effect corrected it.
 *
 * Both inputs — the saved preference and the OS setting — are external stores, so
 * they are read with `useSyncExternalStore`. `resolvedTheme` is then plain
 * derivation, and the only effect left is the one that writes to
 * `document.documentElement`, which is a real external system.
 */

const STORAGE_KEY = 'facetimeos-theme';
const VALID = new Set(['light', 'dark', 'system']);

const ThemeContext = createContext({
  theme: 'system',
  resolvedTheme: 'dark',
  setTheme: () => {},
});

/* --------------------------- the saved preference -------------------------- */

const prefListeners = new Set();

function readPreference() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return VALID.has(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

function subscribePreference(onChange) {
  prefListeners.add(onChange);
  // 'storage' only fires in *other* tabs, which is exactly what we want it for;
  // this tab notifies itself through the listener set when it writes.
  const onStorage = (event) => {
    if (event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    prefListeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/* ----------------------------- the OS setting ------------------------------ */

function subscribeSystem(onChange) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function readSystem() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }) {
  // The server snapshot is the app's dark default; React re-renders with the
  // real value after hydration instead of us mismatching the markup.
  const theme = useSyncExternalStore(subscribePreference, readPreference, () => 'system');
  const systemTheme = useSyncExternalStore(subscribeSystem, readSystem, () => 'dark');

  const resolvedTheme = theme === 'system' ? systemTheme : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolvedTheme);
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.classList.toggle('light', resolvedTheme === 'light');
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setTheme = useCallback((next) => {
    if (!VALID.has(next)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Private mode: the choice applies now but is not remembered. */
    }
    for (const listener of prefListeners) listener();
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
