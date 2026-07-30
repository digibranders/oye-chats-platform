/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

const ThemeContext = createContext();

const STORAGE_KEY = 'admin_theme_mode';
const MODES = ['light', 'dark', 'system'];

/** Read the persisted mode synchronously so the first render matches the DOM.
 *  Default is 'light' - a returning user only gets dark/system if they chose it. */
function readStoredMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (MODES.includes(stored)) return stored;
  } catch {
    // localStorage unavailable (private mode / SSR) - fall through to default.
  }
  return 'light';
}

function systemPrefersDark() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Apply the resolved theme to <html> - the `.dark` class drives Tailwind's
 *  dark variant, and color-scheme fixes native form controls / scrollbars. */
function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/**
 * ThemeProvider - light / dark / system with persistence.
 *
 * `mode` is the user's choice ('light' | 'dark' | 'system'); `theme` is the
 * concrete resolved value ('light' | 'dark') after applying the system
 * preference. When `mode === 'system'` the provider live-follows OS changes.
 */
export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(readStoredMode);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // Track the OS preference in its own state (updated from the event handler,
  // never synchronously inside an effect) so `theme` can be derived in render.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Derived, not stored - no setState-in-effect churn.
  const theme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  // Sync the external DOM (html class + color-scheme) with the resolved theme.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Persist the user's chosen mode.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // non-fatal
    }
  }, [mode]);

  const setMode = useCallback((next) => {
    setModeState(MODES.includes(next) ? next : 'system');
  }, []);

  /** Cycle light → dark → system for a single-button toggle. */
  const cycleMode = useCallback(() => {
    setModeState((prev) => {
      const idx = MODES.indexOf(prev);
      return MODES[(idx + 1) % MODES.length];
    });
  }, []);

  const value = useMemo(
    () => ({ theme, mode, setMode, cycleMode }),
    [theme, mode, setMode, cycleMode]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
