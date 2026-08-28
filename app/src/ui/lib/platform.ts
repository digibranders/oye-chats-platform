
import { t as translateNow } from '../../i18n/i18n';/**
 * Platform detection, for shortcut hints only.
 *
 * The shell it replaces hardcoded `⌘K` and showed it to Windows and Linux users,
 * naming a key their keyboard does not have.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** The platform's command-key glyph. */
export function modifierKey(): string {
  return isMacPlatform() ? '⌘' : translateNow('ds.ctrl') || 'Ctrl';
}
