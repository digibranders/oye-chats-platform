import { cn } from '../lib/cn';

export type ControlSize = 'sm' | 'md' | 'lg';

export interface ControlGeometry {
  /** The height token. Never a padding-derived height — see below. */
  height: string;
  /** Horizontal text inset. Also the inset an affix stands on. */
  padding: string;
  radius: string;
  text: string;
  /** The glyph size a control of this height carries. */
  icon: string;
  /** Gap between a control's own glyph and its label. */
  gap: string;
  /** Where a leading/trailing affix sits, measured from the control's edge. */
  affixInset: { leading: string; trailing: string };
  /** What the text has to give up so it cannot run under an affix. */
  affixPad: { leading: string; trailing: string };
}

/**
 * One geometry per control size, consumed by every control that can sit in a
 * toolbar row: `Button`, `Input`, `Textarea`, `Select`, `Combobox`, `TagInput`,
 * `SearchField`, `SegmentedControl` and `ColorInput`.
 *
 * It exists because control *heights* were spacing tokens and radius, padding,
 * glyph size and hit area were not. That asymmetry is what let a 28px `sm`
 * button ship with a 6px corner between two 8px `sm` inputs, a `lg` button's
 * label sit 2px further in than the `lg` input beside it, and a `sm` segmented
 * control compute to 30px — a height no other control in the system has. All
 * three were invisible in review because nothing rendered the three sizes side
 * by side.
 *
 * **Radius is a function of the control's size, not of its type.** DESIGN.md §4
 * reads it off the type — *"6 input and small button · 8 button and select"* —
 * and that rule cannot be satisfied: a 34px Save button beside a 34px input
 * would differ by 2px on every toolbar in the console. §4 should read *"6 small
 * control · 8 medium and large control"*, which is what this table implements
 * and what the app already ships at `md`.
 *
 * The horizontal insets are base-4 (10 / 12 / 16); `px-3.5` (14), which `Input`
 * and `Select` used at `lg`, is not on the scale at all.
 *
 * Leading and trailing padding differ on purpose, and only there: a leading
 * affix is a glyph (14–16px) and a trailing affix is usually a 24px control, so
 * the text has to give up more room on the right. Both affixes are *inset* by
 * the same value — the control's own text inset — so the glyph, the text and the
 * trailing button's box all stand on one column.
 */
export const CONTROL_SIZE: Record<ControlSize, ControlGeometry> = {
  sm: {
    height: 'h-control-sm',
    padding: 'px-2.5',
    radius: 'rounded-sm',
    text: 'text-xs',
    icon: 'h-icon-sm w-icon-sm',
    gap: 'gap-1.5',
    affixInset: { leading: 'left-2.5', trailing: 'right-2.5' },
    // 10 inset + 14 glyph + 8 clearance = 32 · 10 + 24 button + 6 = 40
    affixPad: { leading: 'pl-8', trailing: 'pr-10' },
  },
  md: {
    height: 'h-control-md',
    padding: 'px-3',
    radius: 'rounded-md',
    text: 'text-base',
    icon: 'h-icon-md w-icon-md',
    gap: 'gap-2',
    affixInset: { leading: 'left-3', trailing: 'right-3' },
    // 12 + 16 + 8 = 36 · 12 + 24 + 8 = 44
    affixPad: { leading: 'pl-9', trailing: 'pr-11' },
  },
  lg: {
    height: 'h-control-lg',
    padding: 'px-4',
    radius: 'rounded-md',
    text: 'text-base',
    icon: 'h-icon-md w-icon-md',
    gap: 'gap-2',
    affixInset: { leading: 'left-4', trailing: 'right-4' },
    // 16 + 16 + 8 = 40 · 16 + 24 + 8 = 48
    affixPad: { leading: 'pl-10', trailing: 'pr-12' },
  },
};

/**
 * Height, padding, radius and text for one control size.
 *
 * A toolbar that composes `controlClass('sm')` through every one of its children
 * cannot drift, because there is one table above and no second opinion.
 */
export function controlClass(size: ControlSize, className?: string): string {
  const geometry = CONTROL_SIZE[size];
  return cn(geometry.height, geometry.padding, geometry.radius, geometry.text, className);
}

/**
 * Disabled, stated in tokens rather than in opacity.
 *
 * `disabled:opacity-50` is the pattern the token file bans for text, applied one
 * level up: it takes `--color-text-inverse` on ink from 17.89 to about 4.2 and
 * `--color-danger` on white from 7.19 to about 2.6. It also compounds — a
 * disabled checkbox dimmed by its box *and* by its label wrapper rendered at
 * 0.36 effective opacity and was very nearly invisible. `--color-text-disabled`
 * exists for exactly this, and it is WCAG-exempt at a stated value rather than
 * at whatever a multiplication happens to produce.
 */
export const DISABLED_CONTROL = cn(
  'disabled:cursor-not-allowed',
  'disabled:border-border disabled:bg-surface-sunken disabled:text-text-disabled',
);

/**
 * The same, for a filled control whose disabled state must stay filled — an ink
 * or accent button, where dropping to a sunken surface would read as an outline
 * variant rather than as a disabled primary.
 */
export const DISABLED_FILLED = cn(
  'disabled:cursor-not-allowed',
  'disabled:border-border disabled:bg-neutral-tint disabled:text-text-disabled',
);

/**
 * Extends a small control's target to 24px without changing its layout.
 *
 * `app/CLAUDE.md` #4 and WCAG 2.2 SC 2.5.8 both ask for 24 × 24, and four
 * controls shipped under it: a 16px checkbox used as the table's row selector,
 * a 16px chip-remove, an 18px search clear and a 20px switch. Growing the
 * *visual* box would have made the checkbox column look like a form; a
 * pseudo-element grows only the hit box, and hit-testing attributes it to the
 * element that owns it.
 *
 * It is invisible in review, so `controls.test.tsx` asserts it is present.
 */
export const HIT_AREA = 'relative before:absolute before:-inset-1 before:content-[""]';

/**
 * The one focus ring, for a composite control whose real focusable child is a
 * bare `input` — a tag list, a drop zone.
 *
 * `outline-none` on that child sets `outline-style: none` at normal specificity
 * and so beats the zero-specificity global rule in `tokens.css`, which is how
 * `TagInput` shipped with no focus indicator at all. The ring is drawn on the
 * box the user sees instead.
 */
export const FOCUS_RING = cn(
  'has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-accent-500',
  'has-[input:focus-visible]:outline-offset-2',
);

/*
 * There is deliberately no bare `outline` beside `outline-2`. Tailwind v4's
 * width utility sets the style as well, and tailwind-merge treats the two as one
 * group — so writing both silently dropped the one that mattered and the ring
 * still did not paint. `controls.test.tsx` caught it; the same applies to the
 * `peer-focus-visible:` set in `FileDrop`.
 */
