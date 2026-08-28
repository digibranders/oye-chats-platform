import { useId, type ReactNode } from 'react';
import { useTranslation } from '../../i18n/useTranslation';
import { cn } from '../lib/cn';
import { FieldContext } from '../primitives/fieldContext';

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
  /**
   * The setting's value must be supplied: `aria-required`, plus " (required)"
   * in the accessible name. No asterisk — see `Field.required`; the console
   * marks the exception, and the exception is "Optional".
   */
  required?: boolean;
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
 *
 * ## It is a `Field`, wearing a row
 *
 * It publishes a `FieldContext`, so the control inside it picks up its `id`, its
 * `aria-describedby` (the description *and* the error), `aria-invalid` and
 * `aria-required` from the row, exactly as one inside a `Field` does. Before
 * this it published nothing: one surface set `aria-invalid` by hand at ten call
 * sites, and the error text was reachable only because it happened to be a
 * `role="status"` live region — announced once, when it appeared, and then
 * unreachable to anyone who arrived at the field afterwards. It keeps the live
 * region as well; the two answer different questions.
 *
 * `disabled` is deliberately **not** published. A locked row's control is very
 * often the one that unlocks it — an Upgrade button, a "request access" link —
 * and disabling the row's contents from the row would disable that too. It
 * dims the row's own type instead, in tokens rather than in opacity: a wash on
 * the wrapper multiplies with each control's own disabled treatment and takes
 * the pair to about 0.36.
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
  required = false,
  disabled = false,
  className,
}: SettingRowProps) {
  const { t } = useTranslation();
  const generatedId = useId();
  // An explicit `htmlFor` wins: the caller has an id it already owns and the
  // row must point at that one, not at a second one it invented.
  const controlId = htmlFor ?? `${generatedId}-control`;
  const labelId = `${generatedId}-label`;
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const Label = htmlFor ? 'label' : 'span';

  return (
    <FieldContext.Provider
      value={{
        id: controlId,
        // Only when the caller wired the row's label to the control. A row
        // heading is not automatically the control's name: "Answering
        // strictness" over a `RadioCards` that names itself, or "Reply-to" over
        // a `TagInput` labelled "Reply-to address", are the row talking about
        // the setting rather than naming the widget. Claiming the name
        // unconditionally renamed one and left the other with no name at all.
        labelId: htmlFor ? labelId : undefined,
        descriptionId,
        errorId,
        invalid: Boolean(error),
        required,
        // See the note on the component: a locked row often holds the control
        // that unlocks it.
        disabled: false,
      }}
    >
    <div
      className={cn(
        'border-t border-border px-cell py-[var(--cell-y)] first:border-t-0',
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
              id={labelId}
              htmlFor={htmlFor}
              className={cn(
                'text-base font-medium',
                disabled ? 'text-text-disabled' : 'text-text-primary',
                htmlFor && !disabled && 'cursor-pointer',
              )}
            >
              {label}
              {required ? <span className="sr-only"> ({t('ds.required') || 'required'})</span> : null}
            </Label>
            {badge}
          </span>
          {description ? (
            <p
              id={descriptionId}
              className={cn('mt-0.5 text-xs', disabled ? 'text-text-disabled' : 'text-text-secondary')}
            >
              {description}
            </p>
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
            // Both an id the control is described by and a live region. The id
            // is what makes the message reachable on arrival; the live region is
            // what announces it when it appears under a control already focused.
            <p
              id={errorId}
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
    </FieldContext.Provider>
  );
}

export interface SettingGroupProps {
  /**
   * `form` (672) is the measure a list of settings is read at, and the default.
   * `full` is for a group whose rows are genuinely a wide table.
   */
  width?: 'form' | 'full';
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
 *
 * **The card is capped at `--container-form` (672).** `SettingRow` caps the
 * label→control *pair* at `--container-pair`, which stops the pair breaking; it
 * does nothing about the box around it, so on a 1945px page the hairline ran a
 * further 1,300px past the control it was underlining and a switch sat at
 * x=1537 with nothing to its right. It is the same argument one level up: a
 * list of settings is a form, and a form has a measure. Two surfaces had
 * already wrapped this in a `Measure` by hand; the cap belongs here so the
 * third does not have to know.
 *
 * The heading is capped with it, so the title, the description and the rows
 * stand on one right edge as well as one left. Pass `width="full"` for the rare
 * group whose rows are genuinely a wide table.
 */
export function SettingGroup({
  width = 'form',
  title,
  titleAs: Title = 'h2',
  description,
  actions,
  id,
  children,
  className,
}: SettingGroupProps) {
  return (
    <section
      id={id}
      className={cn(
        'scroll-mt-gutter lg:scroll-mt-gutter-lg',
        width === 'form' && 'max-w-form',
        className,
      )}
    >
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

/**
 * A band of prose or controls inside a `SettingGroup`, on the group's own
 * gutter.
 *
 * `SettingGroup` is a bordered box whose children are `SettingRow`s, each of
 * which carries the 20px gutter itself. Anything that is *not* a row — an
 * `Alert` explaining the group, a `Well` previewing the result, a paragraph
 * about what the settings do — had no way to stand on that gutter, so eight
 * surfaces hand-wrote `px-cell py-4` inside the group and one of them wrote
 * `p-5`, which is the same defect `CardBody` exists to prevent one level up.
 *
 * It is `CardBody`'s equivalent for a setting group, hairline-separated from
 * the row above it by the same rule the rows use, so a band reads as part of the
 * list rather than as something dropped on top of it.
 */
export function SettingBand({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-t border-border px-cell py-4 first:border-t-0', className)}>
      {children}
    </div>
  );
}
