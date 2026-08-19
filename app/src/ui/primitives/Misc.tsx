import { type ReactNode } from 'react';
import * as RadixSeparator from '@radix-ui/react-separator';
import { cn } from '../lib/cn';

/** A hairline rule. Decorative by default, so it is not announced as a divider. */
export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  return (
    <RadixSeparator.Root
      orientation={orientation}
      decorative
      className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
    />
  );
}

/**
 * A keyboard key.
 *
 * Takes the key as written for the current platform — the caller resolves ⌘ vs
 * Ctrl. The old shell hardcoded `⌘K` and showed it to Windows and Linux users,
 * where that key does not exist.
 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border',
        'bg-surface-sunken px-1 font-mono text-2xs font-medium text-text-secondary',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** True when the user is on a Mac, so shortcut hints name the right key. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** The platform's command-key glyph, for shortcut hints. */
export function modifierKey(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl';
}

/**
 * The console's mono eyebrow: a small uppercase label above a title or figure.
 *
 * A named component rather than a repeated class string, because it appears on
 * every card header, every stat tile and every column head, and it is the single
 * strongest signal that all these surfaces belong to one product.
 */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('font-mono text-2xs uppercase tracking-[0.08em] text-text-tertiary', className)}>
      {children}
    </p>
  );
}
