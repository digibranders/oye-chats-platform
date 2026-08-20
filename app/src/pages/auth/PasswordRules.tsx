import { Check, Circle } from 'lucide-react';
import { cn } from '../../ui';
import { passwordChecks } from './authFlow';

export interface PasswordRulesProps {
  value: string;
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
 *
 * **Spans with list roles, not a `<ul>`.** Both call sites pass this as a
 * `Field`'s `hint`, and `Field` renders its hint inside a `<p>` — where a `<ul>`
 * is not phrasing content, so the parser closes the paragraph before it, the
 * list escapes the hint's styling, and React logs `validateDOMNesting`. ARIA
 * roles give a screen reader the same list semantics from elements that are
 * legal there. The `id` prop is gone with it: `Field` owns the
 * `aria-describedby` wiring, and neither caller ever passed one.
 */
export function PasswordRules({ value }: PasswordRulesProps) {
  const checks = passwordChecks(value);

  return (
    <span role="list" className="mt-0.5 flex flex-col gap-1">
      {checks.map((check) => (
        <span
          role="listitem"
          key={check.id}
          className={cn(
            'flex items-center gap-1.5 text-xs',
            check.met ? 'text-success' : 'text-text-secondary',
          )}
        >
          {check.met ? (
            <Check aria-hidden className="h-icon-sm w-icon-sm shrink-0" strokeWidth={2.5} />
          ) : (
            <Circle aria-hidden className="h-icon-sm w-icon-sm shrink-0 text-text-tertiary" />
          )}
          <span>{check.label}</span>
          <span className="sr-only">{check.met ? ' — done' : ' — not yet'}</span>
        </span>
      ))}
    </span>
  );
}
