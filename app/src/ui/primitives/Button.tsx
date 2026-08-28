import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { buttonClass, BUTTON_ICON_SLOT } from './buttonStyles';
import type { ButtonSize, ButtonVariant } from './buttonStyles';
import { Spinner } from './Spinner';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner in the leading slot and blocks activation. */
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Stretch to the container. Dialog footers and narrow mobile columns. */
  block?: boolean;
}

/**
 * The console's button.
 *
 * Three things it deliberately does not do:
 *
 * It never replaces its label with a spinner. A button whose text vanishes while
 * it works reflows the row it sits in and leaves the user unsure what they
 * pressed, so the label stays and the leading slot carries the spinner. Callers
 * that want different wording in flight pass different children.
 *
 * It has no `asChild` polymorphism. Every attempt to make one component be both
 * a `button` and an `a` ends with a link reporting `disabled` (which does
 * nothing to an anchor) or a button nested inside one. Links that should look
 * like buttons use `buttonClass()` on a real `Link`.
 *
 * It does not let the caller size its glyph. The icon is derived from the
 * button's own height — a 28px `sm` button with a 12px label used to get
 * whatever the call site guessed, which was `h-4 w-4` in all 64 of them, so the
 * icon out-weighed the label on every small button in the app.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    iconLeft,
    iconRight,
    block = false,
    className,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      // `aria-busy` is what tells a screen-reader user the press was received.
      // Without it the only feedback is a spinner they cannot see.
      aria-busy={loading || undefined}
      // `cn` rather than string concatenation: fusing `w-full` and the caller's
      // own width into one token stops tailwind-merge from de-conflicting them.
      className={buttonClass(
        variant,
        size,
        cn(variant !== 'link' && BUTTON_ICON_SLOT[size], block && 'w-full', className),
      )}
      {...props}
    >
      {/* Children always render, including at icon sizes — an icon button passes
          its glyph as children, and an earlier version dropped it, which left
          every close and pagination button in the system blank. */}
      {/* `Spinner`, not a second hardcoded `Loader2`: the system has one
          indeterminate wait, and `Button` was quietly reimplementing it at a
          fixed 16px so the two could drift. `text-current` puts it in the
          button's own ink; the size comes from the button. */}
      {loading ? <Spinner size="md" label={null} className="text-current" /> : iconLeft}
      {children}
      {!loading && iconRight}
    </button>
  );
});
