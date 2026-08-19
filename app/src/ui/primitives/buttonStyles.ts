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
 *               accident and reads as the expected path; a destructive action should
 *               look like a decision. Always paired with a confirm.
 * - `link`      text only, and unsized — it sits inline in prose, where a 34px-tall
 *               control would break the line box.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'border border-ink bg-ink text-text-inverse hover:bg-ink-hover disabled:hover:bg-ink',
  accent:
    'border border-accent-600 bg-accent-500 text-text-inverse hover:bg-accent-600 disabled:hover:bg-accent-500',
  secondary:
    'border border-border-strong bg-surface text-text-primary hover:bg-surface-hover active:bg-surface-active',
  ghost:
    'border border-transparent bg-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active',
  danger:
    'border border-danger/40 bg-surface text-danger hover:border-danger/60 hover:bg-danger-tint',
  link: 'border-0 bg-transparent p-0 text-accent-600 underline-offset-2 hover:text-accent-700 hover:underline',
};

/**
 * Heights come from the spacing scale rather than from padding, so a button, an
 * input and a select on one row line up exactly. Padding then only sets the
 * horizontal rhythm.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-control-sm gap-1.5 rounded-sm px-2.5 text-xs',
  md: 'h-control-md gap-2 rounded-md px-3 text-base',
  lg: 'h-control-lg gap-2 rounded-md px-4 text-base',
  'icon-sm': 'h-control-sm w-control-sm rounded-sm',
  'icon-md': 'h-control-md w-control-md rounded-md',
};

const BASE = 'inline-flex shrink-0 items-center justify-center font-medium transition-colors duration-[var(--dur-fast)]';
const DISABLED = 'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * The button's class string, for the cases that genuinely are not buttons: a
 * router `Link`, an `<a download>`, or a `<label>` fronting a file input.
 *
 * It emits the *same* list the component does, disabled styling included.
 * Splitting them is how a `Link` styled as a disabled button ends up looking
 * enabled — the two must never be able to drift.
 */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  // `link` is unsized on purpose: it has to sit on the text baseline.
  return cn(BASE, variant !== 'link' && SIZE[size], DISABLED, VARIANT[variant], className);
}

export { BASE as BUTTON_BASE, DISABLED as BUTTON_DISABLED, SIZE as BUTTON_SIZE, VARIANT as BUTTON_VARIANT };
