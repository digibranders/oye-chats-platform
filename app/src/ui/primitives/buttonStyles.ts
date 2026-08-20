import { cn } from '../lib/cn';
import { CONTROL_SIZE, HIT_AREA, controlClass, type ControlSize } from './controlStyles';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'link';
export type ButtonSize = ControlSize | 'icon-xs' | 'icon-sm' | 'icon-md';

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
 *
 * Two things every variant now states rather than implies.
 *
 * **The danger border is solid.** It was `border-danger/40`, which renders
 * the danger tone at 40% over white at roughly 1.6:1 — under the 3:1 SC 1.4.11
 * asks of a boundary that is the only thing telling you a control is there, and beside a
 * `secondary` button it read as a *disabled* washed-pink ghost. That is the
 * opposite of "a destructive action should look like a decision", and it is the
 * same banned pattern as an opacity modifier on a text token, one level up.
 *
 * **Every variant has a pressed state.** `primary`, `accent` and `danger` had
 * none, so a dialog footer darkened under the cursor on Cancel and did nothing
 * at all on Save.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: cn(
    'border border-ink bg-ink text-text-inverse hover:bg-ink-hover active:bg-ink',
    'disabled:border-border disabled:bg-neutral-tint disabled:text-text-disabled',
  ),
  accent: cn(
    'border border-accent-600 bg-accent-500 text-text-inverse hover:bg-accent-600 active:bg-accent-700',
    'disabled:border-border disabled:bg-neutral-tint disabled:text-text-disabled',
  ),
  secondary: cn(
    'border border-border-strong bg-surface text-text-primary hover:bg-surface-hover active:bg-surface-active',
    'disabled:border-border disabled:bg-surface-sunken disabled:text-text-disabled',
  ),
  ghost: cn(
    'border border-transparent bg-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active',
    'disabled:border-transparent disabled:bg-transparent disabled:text-text-disabled',
  ),
  danger: cn(
    'border border-danger bg-surface text-danger hover:bg-danger-tint active:bg-danger-tint',
    'disabled:border-border disabled:bg-surface-sunken disabled:text-text-disabled',
  ),
  link: cn(
    'border-0 bg-transparent p-0 text-accent-600 underline-offset-2 hover:text-accent-700 hover:underline',
    'disabled:text-text-disabled disabled:no-underline',
  ),
};

/**
 * Heights, padding, radius and text all come from one table
 * (`controlStyles.ts`), so a button, an input and a select on one row line up
 * exactly — at every size, not only at `md`.
 *
 * `icon-xs` is 24px, the correct size in a dense list row and the size eleven
 * places across `features/` and `superadmin/` had hand-rolled because the
 * system's smallest was 28. It carries `HIT_AREA` so a 24px control still clears
 * the 24px target with slop for touch.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: controlClass('sm', CONTROL_SIZE.sm.gap),
  md: controlClass('md', CONTROL_SIZE.md.gap),
  lg: controlClass('lg', CONTROL_SIZE.lg.gap),
  'icon-xs': cn('h-6 w-6 rounded-xs', HIT_AREA),
  'icon-sm': 'h-control-sm w-control-sm rounded-sm',
  'icon-md': 'h-control-md w-control-md rounded-md',
};

/**
 * The glyph a button of each size carries.
 *
 * Exported unscoped as well as scoped, because a `buttonClass` call site that
 * renders its icon outside the button's own subtree cannot rely on the
 * descendant selector below.
 */
export const BUTTON_ICON: Record<ButtonSize, string> = {
  sm: CONTROL_SIZE.sm.icon,
  md: CONTROL_SIZE.md.icon,
  lg: CONTROL_SIZE.lg.icon,
  'icon-xs': CONTROL_SIZE.sm.icon,
  'icon-sm': CONTROL_SIZE.sm.icon,
  'icon-md': CONTROL_SIZE.md.icon,
};

/**
 * The same sizes, scoped to whatever glyph the button is handed.
 *
 * An icon's size is derived from the control that holds it, never chosen at the
 * call site: a 28px `sm` button with a 12px label was getting a 16px glyph,
 * because all 64 `buttonClass` call sites picked their own and every one of them
 * picked `h-4 w-4`. `Button` applies this so a caller never has to know;
 * `buttonClass` consumers can add it themselves.
 */
export const BUTTON_ICON_SLOT: Record<ButtonSize, string> = {
  sm: '[&_svg]:h-icon-sm [&_svg]:w-icon-sm',
  md: '[&_svg]:h-icon-md [&_svg]:w-icon-md',
  lg: '[&_svg]:h-icon-md [&_svg]:w-icon-md',
  'icon-xs': '[&_svg]:h-icon-sm [&_svg]:w-icon-sm',
  'icon-sm': '[&_svg]:h-icon-sm [&_svg]:w-icon-sm',
  'icon-md': '[&_svg]:h-icon-md [&_svg]:w-icon-md',
};

const BASE = 'inline-flex shrink-0 items-center justify-center font-medium transition-colors duration-[var(--dur-fast)]';
const DISABLED = 'disabled:cursor-not-allowed';

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
