import { Check } from 'lucide-react';
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
 * because a tick and an unmet marker are close to the same shape at a glance and
 * colour is never the only signal in this system.
 *
 * **The unmet marker is a dot, not an outlined circle.** `Circle` at 14px beside
 * a left-aligned label is a radio button — three of them stacked under a field
 * on the sign-up form read as an unanswered radio group, and the first thing a
 * new customer did with the password rules was try to click one. A dot in the
 * same 14px box says "not yet" without offering to be pressed, and keeps the
 * label column on one edge whichever state a row is in.
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
          <span aria-hidden className="flex h-icon-sm w-icon-sm shrink-0 items-center justify-center">
            {check.met ? (
              <Check className="h-icon-sm w-icon-sm" strokeWidth={2.5} />
            ) : (
              <span className="h-1 w-1 rounded-full bg-text-tertiary" />
            )}
          </span>
          <span>{check.label}</span>
          <span className="sr-only">{check.met ? ' — done' : ' — not yet'}</span>
        </span>
      ))}
    </span>
  );
}
