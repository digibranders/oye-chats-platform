import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { buttonClass } from './buttonStyles';
import type { ButtonSize, ButtonVariant } from './buttonStyles';

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
 * Two things it deliberately does not do:
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
      className={buttonClass(variant, size, block ? `w-full ${className ?? ''}` : className)}
      {...props}
    >
      {/* Children always render, including at icon sizes — an icon button passes
          its glyph as children, and an earlier version dropped it, which left
          every close and pagination button in the system blank. */}
      {loading ? <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" /> : iconLeft}
      {children}
      {!loading && iconRight}
    </button>
  );
});

