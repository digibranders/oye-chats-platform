import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

const CONTROL_WIDTHS = {
  sm: 'w-40',
  md: 'w-64',
  auto: '',
} as const;

export interface SettingRowProps {
  /** The setting's name. Sentence case, one to four words. Never a sentence. */
  label: string;
  /**
   * One short clause, and only when the label cannot carry the meaning.
   *
   * "Seconds an operator has to accept" is a label doing a description's job;
   * "Accept timeout" with "Then it returns to the queue." underneath is the
   * same setting in half the height and twice the clarity.
   */
  description?: ReactNode;
  /**
   * Wires the label to a control that owns an id — `Input`, `Select`,
   * `Combobox`. Omit for `Switch`, `Checkbox` and buttons, which name
   * themselves; a second `label` pointing at a switch gives it two names.
   */
  htmlFor?: string;
  /** A plan lock, a status word, a computed value. Sits after the label. */
  badge?: ReactNode;
  /** The control. Right-aligned, vertically centred on the row. */
  children: ReactNode;
  /** Caps the control column so a stack of rows lines up. Default `md` (16rem). */
  controlWidth?: 'sm' | 'md' | 'auto';
  /** Full-width control under the label — a `Textarea`, a `TagInput`, a day grid. */
  stacked?: boolean;
  /** What is wrong with the current value, in the user's terms. */
  error?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * One setting: a name on the left, its control on the right, a hairline under it.
 *
 * The console had no such primitive, so every single setting was wrapped in the
 * heaviest container the system owns — a `Card`, a `CardHeader` and a
 * `CardBody`, about 130px of chrome before the control. Four numeric fields in
 * the queue settings occupied 620px of page for four integers. Three surfaces
 * had already re-invented the row inline (the plan row, the switch's own
 * labelled form, the department list item), which is exactly the duplication
 * `CLAUDE.md` non-negotiable #1 exists to stop.
 *
 * **The pair is capped at `--container-pair` (640).** This is the defect the
 * component exists to kill: a `justify-between` row inside a 1440px card put a
 * switch 1,540px from the label naming it, and past roughly 640px the eye stops
 * binding the two ends of a row — the middle reads as a hole. The cap is on the
 * *pair*, not on the row, so the hairline still runs the full width of the card
 * and the rows still read as a list. The pair is left-anchored, never centred.
 *
 * The row height comes from `--row-h`, so a settings page rendered inside
 * `Page density="dense"` compresses without a single value being re-decided.
 * It carries the card's own 20px horizontal gutter, so a `SettingGroup` dropped
 * into a `CardBody flush` lines up with the `CardHeader` above it.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  badge,
  children,
  controlWidth = 'md',
  stacked = false,
  error,
  disabled = false,
  className,
}: SettingRowProps) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div
      className={cn(
        'border-t border-border px-cell py-[var(--cell-y)] first:border-t-0',
        disabled && 'opacity-60',
        className,
      )}
    >
      <div
        className={cn(
          'flex w-full max-w-pair flex-wrap items-center justify-between gap-x-6 gap-y-2',
          'min-h-[var(--row-h)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <Label
              htmlFor={htmlFor}
              className={cn(
                'text-base font-medium text-text-primary',
                htmlFor && !disabled && 'cursor-pointer',
              )}
            >
              {label}
            </Label>
            {badge}
          </span>
          {description ? (
            <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
          ) : null}
        </div>
        <div
          className={cn(
            'flex flex-col gap-1.5',
            stacked ? 'w-full basis-full' : cn('max-w-full shrink-0', CONTROL_WIDTHS[controlWidth]),
          )}
        >
          <div className={cn('flex items-center', stacked ? 'justify-start' : 'justify-end')}>
            {children}
          </div>
          {error ? (
            <p
              role="status"
              aria-live="polite"
              className={cn('text-xs text-danger', stacked ? 'text-left' : 'text-right')}
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface SettingGroupProps {
  title?: string;
  titleAs?: 'h2' | 'h3';
  /** One clause about the group, when the title cannot carry it. */
  description?: ReactNode;
  actions?: ReactNode;
  /** An id, so a `SidebarLayout` nav can link straight to it. */
  id?: string;
  children: ReactNode;
  className?: string;
}

/**
 * A named list of settings.
 *
 * A plain heading over one hairline box — deliberately **not** a `Card` with a
 * `CardHeader`. A card header charges an eyebrow, a title and a description for
 * a group whose five rows already name themselves, and stacking a `Section`
 * heading, a card heading and a field label gives the reader three registers of
 * text to reach one input.
 *
 * Five settings cost about 26px of heading plus 220px of rows here. As five
 * cards they cost about 750px, which is the settings pages as they stand.
 */
export function SettingGroup({
  title,
  titleAs: Title = 'h2',
  description,
  actions,
  id,
  children,
  className,
}: SettingGroupProps) {
  return (
    <section id={id} className={cn('scroll-mt-gutter lg:scroll-mt-gutter-lg', className)}>
      {title ? (
        <div className="mb-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <Title className="text-lg font-semibold text-text-primary">{title}</Title>
            {description ? (
              <p className="mt-1 max-w-reading text-xs text-text-tertiary">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="rounded-lg border border-border bg-surface">{children}</div>
    </section>
  );
}
