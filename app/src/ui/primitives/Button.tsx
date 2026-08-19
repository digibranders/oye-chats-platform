import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon-sm' | 'icon-md';

/**
 * Variants, and what each one means. The distinction is intent, not decoration:
 * a screen with two filled buttons has told the user nothing about which one to
 * press.
 *
 * - `primary`   ink fill. The one action the screen exists for. At most one per view.
 * - `accent`    blue fill. Reserved for the *progressive* action in a flow that is
 *               moving forward (Continue, Deploy, Start training), so it reads as
 *               momentum rather than as a second primary.
 * - `secondary` outlined. Everything else that is a real action.
 * - `ghost`     no chrome until hover. Toolbar and table-row actions, where a grid
 *               of outlines would out-shout the data.
 * - `danger`    outlined in red, never filled. A filled red button is easy to hit by
 *               accident and reads as the expected path; destructive actions should
 *               look like a decision. Always paired with a confirm.
 * - `link`      text only. Inline in prose, where a control would break the line.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border border-ink bg-ink text-text-inverse hover:bg-ink-hover active:bg-ink ' +
    'disabled:hover:bg-ink',
  accent:
    'border border-accent-600 bg-accent-500 text-text-inverse hover:bg-accent-600 ' +
    'active:bg-accent-600 disabled:hover:bg-accent-500',
  secondary:
    'border border-border-strong bg-surface text-text-primary hover:bg-surface-hover ' +
    'active:bg-surface-active',
  ghost:
    'border border-transparent bg-transparent text-text-secondary hover:bg-surface-hover ' +
    'hover:text-text-primary active:bg-surface-active',
  danger:
    'border border-danger/40 bg-surface text-danger hover:bg-danger-tint ' +
    'hover:border-danger/60 active:bg-danger-tint',
  link:
    'border-0 bg-transparent p-0 text-accent-600 underline-offset-2 hover:underline ' +
    'hover:text-accent-700',
};

/**
 * Heights come from the token layer rather than from padding, so a button, an
 * input and a select placed on one row line up exactly. Padding then only has to
 * set the horizontal rhythm.
 */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-[var(--control-h-sm)] gap-1.5 rounded-sm px-2.5 text-xs',
  md: 'h-[var(--control-h-md)] gap-2 rounded-md px-3 text-base',
  lg: 'h-[var(--control-h-lg)] gap-2 rounded-md px-4 text-base',
  'icon-sm': 'h-[var(--control-h-sm)] w-[var(--control-h-sm)] rounded-sm',
  'icon-md': 'h-[var(--control-h-md)] w-[var(--control-h-md)] rounded-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner in place of `iconLeft` and blocks activation. */
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Stretch to the container. Used in dialog footers and narrow mobile columns. */
  block?: boolean;
}

/**
 * The console's button.
 *
 * Two things it deliberately does not do:
 *
 * It never renders a bare spinner in place of its label. A button whose text
 * vanishes while it works reflows the row it sits in and leaves the user with
 * no idea what they pressed, so the label stays and the icon slot carries the
 * spinner. Callers that want different wording while in flight pass different
 * children.
 *
 * It has no `asChild` polymorphism. Every attempt to make one component be both
 * a `button` and an `a` ends with a link that reports `disabled` (which does
 * nothing to an anchor) or a button inside an anchor. Links that should look
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
  const isIconOnly = size === 'icon-sm' || size === 'icon-md';
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      // `aria-busy` is what tells a screen-reader user the press was received.
      // Without it the only feedback is a spinner they cannot see.
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium',
        'transition-colors duration-[var(--dur-fast)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        SIZES[size],
        VARIANTS[variant],
        block && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" />
      ) : (
        iconLeft
      )}
      {!isIconOnly && children}
      {!isIconOnly && !loading && iconRight}
    </button>
  );
});

/**
 * The button's class string, for the cases that genuinely are not buttons:
 * a `react-router` `Link`, an `<a download>`, or a `<label>` that fronts a file
 * input. Keeping one source for the shape means those never drift.
 */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center font-medium',
    'transition-colors duration-[var(--dur-fast)]',
    SIZES[size],
    VARIANTS[variant],
    className,
  );
}
