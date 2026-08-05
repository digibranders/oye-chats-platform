import { createContext, useContext } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export type EventOrOrigin =
  | { x: number; y: number }
  | React.MouseEvent<Element>
  | MouseEvent;

export interface ThemeContextValue {
  /** The user's chosen preference (may be 'system'). */
  theme: Theme;
  /** The concrete theme currently applied to the document. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme, eventOrOrigin?: EventOrOrigin) => void;
  /** Flip between light and dark (resolves 'system' to its concrete value first). */
  toggle: (eventOrOrigin?: EventOrOrigin) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Subscribe to the theme. Must be used within a `<ThemeProvider>`. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
