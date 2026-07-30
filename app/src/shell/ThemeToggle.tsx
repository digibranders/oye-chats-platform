import { AnimatePresence, motion } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import { cn, useTheme } from '../design-system';

/**
 * ThemeToggle - animated light ⇄ dark switch (ported from the pre-redesign
 * `layouts/TopBar.jsx`, remapped to the new `useTheme()` hook and `--ds-*`
 * tokens). Two states only - "system" lives in Settings › Appearance;
 * toggling from "system" resolves to the opposite of whatever it currently
 * renders as.
 */
export function ThemeToggle() {
  const { resolvedTheme, toggle } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggle}
      className={cn(
        'relative inline-flex h-7 w-[52px] shrink-0 items-center rounded-full p-1 transition-colors duration-300',
        'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
        isDark ? 'bg-[var(--ds-bg-sunken)]' : 'bg-amber-100',
      )}
    >
      {/* Faint destination hint on the far side of the track */}
      <Sun
        size={12}
        aria-hidden="true"
        className={cn(
          'absolute left-1.5 transition-opacity duration-300',
          isDark ? 'text-[var(--ds-text-subtle)] opacity-70' : 'opacity-0',
        )}
      />
      <Moon
        size={12}
        aria-hidden="true"
        className={cn(
          'absolute right-1.5 transition-opacity duration-300',
          isDark ? 'opacity-0' : 'text-amber-400 opacity-70',
        )}
      />
      {/* Sliding thumb with a morphing icon */}
      <motion.span
        initial={false}
        animate={{ x: isDark ? 24 : 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-[var(--ds-shadow-sm)]"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={isDark ? 'moon' : 'sun'}
            initial={{ rotate: -90, opacity: 0, scale: 0.5 }}
            animate={{ rotate: 0, opacity: 1, scale: 1 }}
            exit={{ rotate: 90, opacity: 0, scale: 0.5 }}
            transition={{ duration: 0.18 }}
            className="flex items-center justify-center"
          >
            {isDark ? (
              <Moon size={12} aria-hidden="true" className="text-indigo-500" />
            ) : (
              <Sun size={12} aria-hidden="true" className="text-amber-500" />
            )}
          </motion.span>
        </AnimatePresence>
      </motion.span>
    </button>
  );
}
