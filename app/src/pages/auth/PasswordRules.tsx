import { Check, Circle } from 'lucide-react';
import { cn } from '../../ui';
import { passwordChecks } from './authFlow';

export interface PasswordRulesProps {
  value: string;
  /** Ties the list to its field via `aria-describedby`. */
  id?: string;
}

/**
 * What the password has to be, and which parts of it are already true.
 *
 * Rendered from the first paint rather than after the first keystroke. The
 * signup form this replaces only revealed the rules once the user had started
 * typing, so the first attempt was always a guess followed by a correction, and
 * the password reset screen never showed them at all — it failed the submit and
 * put the rules in the error instead.
 *
 * Each row carries its state as a word for assistive tech as well as a glyph,
 * because a tick and an empty circle are the same shape at a glance and colour
 * is never the only signal in this system.
 */
export function PasswordRules({ value, id }: PasswordRulesProps) {
  const checks = passwordChecks(value);

  return (
    <ul id={id} className="mt-0.5 space-y-1">
      {checks.map((check) => (
        <li
          key={check.id}
          className={cn(
            'flex items-center gap-1.5 text-xs',
            check.met ? 'text-success' : 'text-text-secondary',
          )}
        >
          {check.met ? (
            <Check aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
          ) : (
            <Circle aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
          )}
          <span>{check.label}</span>
          <span className="sr-only">{check.met ? ' — done' : ' — not yet'}</span>
        </li>
      ))}
    </ul>
  );
}
