/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo } from 'react';

const ThemeContext = createContext();

const STORAGE_KEY = 'admin_theme_mode';

/**
 * ThemeProvider — light-only.
 *
 * Dark mode is intentionally disabled for now. The provider forces the light
 * theme on every mount: it strips any `.dark` class off <html>, pins
 * `color-scheme: light`, and clears any stored dark/system preference so a
 * returning user never lands in dark. The `dark:` utility classes throughout
 * the app are left in place (dormant) so dark mode can be re-enabled later by
 * restoring the previous toggle logic — no markup changes required.
 *
 * The context API (`theme`, `mode`, `setMode`) is preserved so existing
 * consumers keep working; `setMode` is a no-op while light-only.
 */
export function ThemeProvider({ children }) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark');
    root.style.colorScheme = 'light';
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage may be unavailable (private mode) — non-fatal.
    }
  }, []);

  const value = useMemo(
    () => ({ theme: 'light', mode: 'light', setMode: () => {} }),
    []
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
