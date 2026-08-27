import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { getLocale } from '../../i18n/i18n';
import { CONTROL_BASE } from './Input';
import { CONTROL_SIZE, controlClass, type ControlSize } from './controlStyles';
import { PANEL_BASE, PANEL_POSITIONER } from '../overlays/panelStyles';
import { useFieldControlProps, useFieldNamesControl } from './fieldContext';

/**
 * A calendar day, as the three numbers it actually is.
 *
 * Not a `Date`. `new Date('2026-08-01')` parses as UTC midnight, so
 * formatting it in any timezone behind UTC prints 31 July — the exact
 * off-by-one this whole file exists to avoid. Every local-time `Date` this
 * component constructs uses `new Date(year, month, day)`, the one constructor
 * that means "this calendar day, wherever the browser is," and every value in
 * and out is the `YYYY-MM-DD` string a `<input type="date">` would have used,
 * so a date picked here slots into existing form state unchanged.
 */
interface Ymd {
  year: number;
  /** 0-11, matching `Date`'s own month index. */
  month: number;
  day: number;
}

function parseIso(iso: string | null | undefined): Ymd | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const probe = new Date(year, month, day);
  // Rejects `2026-02-30`: `Date` normalises it to March 2, so the round trip
  // no longer matches the day it was asked for.
  if (probe.getFullYear() !== year || probe.getMonth() !== month || probe.getDate() !== day) return null;
  return { year, month, day };
}

function toIso({ year, month, day }: Ymd): string {
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function todayYmd(): Ymd {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

function compareYmd(a: Ymd, b: Ymd): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function addDays(ymd: Ymd, delta: number): Ymd {
  const next = new Date(ymd.year, ymd.month, ymd.day + delta);
  return { year: next.getFullYear(), month: next.getMonth(), day: next.getDate() };
}

/** The 1st of the month `delta` away. For the Previous/Next-month nav
 * buttons, whose whole job is picking which month the grid shows — the day
 * component is irrelevant there, only year/month feed the grid. */
function addMonths(ymd: Ymd, delta: number): Ymd {
  const next = new Date(ymd.year, ymd.month + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth(), day: 1 };
}

/** The same day-of-month, `delta` months away, clamped into a shorter target
 * month (31 Jan + 1 month lands on 28/29 Feb, not 3 March). For PageUp/PageDown,
 * which move the ACTIVE DAY a month at a time and must keep it, matching every
 * other WAI-ARIA date-picker's PageUp/PageDown contract — `addMonths` cannot
 * serve this: it always resets to the 1st, so an active day of 15 would
 * silently become 1 the moment either key was pressed. */
function stepMonth(ymd: Ymd, delta: number): Ymd {
  const base = new Date(ymd.year, ymd.month + delta, 1);
  const day = Math.min(ymd.day, daysInMonth(base.getFullYear(), base.getMonth()));
  return { year: base.getFullYear(), month: base.getMonth(), day };
}

function clampYmd(ymd: Ymd, min: Ymd | null, max: Ymd | null): Ymd {
  if (min && compareYmd(ymd, min) < 0) return min;
  if (max && compareYmd(ymd, max) > 0) return max;
  return ymd;
}

const WEEKDAY_COUNT = 7;

/** The 42-cell (6 week) grid for one month, including the leading/trailing
 * days of its neighbours so every week is a full row. */
function buildGrid(year: number, month: number): Ymd[] {
  const firstWeekday = new Date(year, month, 1).getDay();
  const start = addDays({ year, month, day: 1 }, -firstWeekday);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export interface DatePickerProps {
  /** `YYYY-MM-DD`, or `null` for no selection. */
  value: string | null;
  onValueChange: (value: string | null) => void;
  /** Required: the trigger's accessible name. */
  label: string;
  placeholder?: string;
  /** Inclusive bounds, `YYYY-MM-DD`. A day outside either is not selectable. */
  min?: string;
  max?: string;
  disabled?: boolean;
  size?: ControlSize;
  /** Adds a trailing clear control once a value is set. */
  clearable?: boolean;
  id?: string;
  className?: string;
}

/**
 * A calendar date field, fully styled — the open panel is ours, not the
 * platform's.
 *
 * `<input type="date">` puts the actual picker outside CSS entirely: on
 * Windows it is system chrome that ignores every token in this file, exactly
 * the defect `Select`'s own docblock records for a native `<select>`. This is
 * the same decision applied to the other native picker still in the console —
 * a real month grid, keyboard-driven per the WAI-ARIA dialog-grid pattern
 * (arrow keys move a day at a time, Up/Down a week, Home/End the edges of the
 * month, PageUp/PageDown the adjacent month, Enter/Space selects, Escape
 * closes without one), rendered in the product's own panel chrome.
 */
export function DatePicker({
  value,
  onValueChange,
  label,
  placeholder = 'Select a date',
  min,
  max,
  disabled = false,
  size = 'md',
  clearable = false,
  id,
  className,
}: DatePickerProps) {
  const fieldNamesIt = useFieldNamesControl();
  const fieldProps = useFieldControlProps();
  const geometry = CONTROL_SIZE[size];

  const selected = useMemo(() => parseIso(value), [value]);
  const minYmd = useMemo(() => parseIso(min), [min]);
  const maxYmd = useMemo(() => parseIso(max), [max]);
  const today = useMemo(() => todayYmd(), []);

  const [open, setOpenState] = useState(false);
  // The month the grid shows. Reset to the selection (or today) each time the
  // panel opens, so a picker left open on some other month from a previous
  // visit does not greet the user with the wrong page.
  const [visibleMonth, setVisibleMonth] = useState(() => selected ?? today);
  // The cell arrow keys move, independent of `selected` until Enter commits
  // it — otherwise every arrow press would fire `onValueChange`.
  const [activeDay, setActiveDay] = useState(() => selected ?? today);
  const gridRef = useRef<HTMLDivElement>(null);

  // Resetting the grid to the selection lives in the same handler that opens
  // the panel, not in a `useEffect` keyed on `open` — an effect would render
  // once with the stale month, then immediately re-render with the reset one.
  const setOpen = (next: boolean) => {
    if (next) {
      const anchor = clampYmd(selected ?? today, minYmd, maxYmd);
      setVisibleMonth(anchor);
      setActiveDay(anchor);
    }
    setOpenState(next);
  };

  const disabledDay = (day: Ymd): boolean =>
    Boolean((minYmd && compareYmd(day, minYmd) < 0) || (maxYmd && compareYmd(day, maxYmd) > 0));

  const commit = (day: Ymd) => {
    if (disabledDay(day)) return;
    onValueChange(toIso(day));
    setOpen(false);
  };

  const focusActiveCell = () => {
    gridRef.current?.querySelector<HTMLButtonElement>('[data-active="true"]')?.focus();
  };

  // Roving tabindex, for navigation while already open: move real DOM focus
  // to the active cell whenever it changes, so arrowing through the grid
  // does not silently leave focus behind on the day the last move started on.
  //
  // This does NOT cover the moment the panel *opens* — see the
  // `onOpenChangeComplete` handler below for why that needs its own hook,
  // separate from this one despite doing the same `.focus()` call.
  useEffect(() => {
    if (!open) return;
    focusActiveCell();
  }, [open, activeDay]);

  const moveActive = (next: Ymd) => {
    setActiveDay(next);
    if (next.year !== visibleMonth.year || next.month !== visibleMonth.month) {
      setVisibleMonth(next);
    }
  };

  const handleGridKeyDown = (event: React.KeyboardEvent) => {
    const deltas: Record<string, () => Ymd> = {
      ArrowLeft: () => addDays(activeDay, -1),
      ArrowRight: () => addDays(activeDay, 1),
      ArrowUp: () => addDays(activeDay, -WEEKDAY_COUNT),
      ArrowDown: () => addDays(activeDay, WEEKDAY_COUNT),
      Home: () => ({ ...activeDay, day: 1 }),
      End: () => ({ ...activeDay, day: daysInMonth(activeDay.year, activeDay.month) }),
      PageUp: () => stepMonth(activeDay, -1),
      PageDown: () => stepMonth(activeDay, 1),
    };
    const move = deltas[event.key];
    if (move) {
      event.preventDefault();
      moveActive(move());
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit(activeDay);
    }
  };

  const grid = useMemo(() => buildGrid(visibleMonth.year, visibleMonth.month), [visibleMonth.year, visibleMonth.month]);
  const weeks = useMemo(() => Array.from({ length: 6 }, (_, week) => grid.slice(week * 7, week * 7 + 7)), [grid]);

  const locale = getLocale();
  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(locale || undefined, { month: 'long', year: 'numeric' }).format(
        new Date(visibleMonth.year, visibleMonth.month, 1),
      ),
    [locale, visibleMonth.year, visibleMonth.month],
  );
  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale || undefined, { weekday: 'narrow' });
    // A Sunday-anchored week (2026-08-02 is a Sunday), matching `buildGrid`'s
    // own `getDay()`-based layout, in the locale's own glyphs.
    return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2026, 7, 2 + index)));
  }, [locale]);
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale || undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
    [locale],
  );

  const triggerLabel = selected ? dayFormatter.format(new Date(selected.year, selected.month, selected.day)) : null;
  // A plain `aria-label={label}` would be correct as a NAME but would also
  // suppress the picked date from the accessible tree — `aria-label` wins
  // over descendant content in accessible-name computation, and this button
  // has no separate "value" the way a native `<input>` does. Folding the
  // value into the label itself is how `2 December 2026, Date captured`
  // reaches a screen reader instead of just `Date captured`.
  const accessibleName = triggerLabel ? `${label}, ${triggerLabel}` : label;

  return (
    <BasePopover.Root
      open={open}
      onOpenChange={setOpen}
      // Base UI applies its OWN default initial focus once the open
      // animation genuinely finishes (`PANEL_BASE`'s `motion-pop`), which
      // lands after — and overrides — a plain `useEffect`'s earlier attempt,
      // reverting focus to whatever it defaults to (the first tabbable
      // element, here the Previous-month button). `onOpenChangeComplete` is
      // the one hook guaranteed to run after that settles, so it is the only
      // reliable place to put the day-cell focus that belongs on open.
      onOpenChangeComplete={(nowOpen) => {
        if (nowOpen) focusActiveCell();
      }}
    >
      <div className={cn('relative flex w-full items-center', className)}>
        <BasePopover.Trigger
          aria-label={fieldNamesIt || id ? undefined : accessibleName}
          aria-haspopup="dialog"
          disabled={disabled || Boolean(fieldProps.disabled)}
          className={cn(
            CONTROL_BASE,
            'flex items-center gap-2 text-left',
            controlClass(size),
            clearable && selected && 'pr-9',
          )}
          {...fieldProps}
          {...(id ? { id } : {})}
        >
          <Calendar aria-hidden className={cn('shrink-0 text-text-tertiary', geometry.icon)} />
          <span className={cn('min-w-0 flex-1 truncate', !triggerLabel && 'text-text-disabled')}>
            {triggerLabel ?? placeholder}
          </span>
        </BasePopover.Trigger>
        {clearable && selected ? (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={(event) => {
              event.stopPropagation();
              onValueChange(null);
            }}
            className={cn(
              'absolute flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-text-tertiary',
              'hover:bg-surface-hover hover:text-text-primary',
              geometry.affixInset.trailing,
            )}
          >
            <X aria-hidden className="h-icon-sm w-icon-sm" />
          </button>
        ) : null}
      </div>

      <BasePopover.Portal>
        <BasePopover.Positioner className={PANEL_POSITIONER} side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <BasePopover.Popup
            className={cn(PANEL_BASE, 'w-72 p-3')}
            // Base UI's own default is "the first tabbable element", which
            // here is the Previous-month button — so the panel opened with
            // focus one keypress away from every day in the grid instead of
            // on the day that matters. This is called at the moment Base UI
            // actually applies focus (including its own post-layout
            // re-application), so it always resolves the live active cell
            // rather than one captured too early.
            initialFocus={() => gridRef.current?.querySelector<HTMLElement>('[data-active="true"]') ?? true}
          >
            <div className="flex items-center justify-between pb-2">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setVisibleMonth((current) => addMonths(current, -1))}
                className="flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              >
                <ChevronLeft aria-hidden className="h-icon-sm w-icon-sm" />
              </button>
              <span className="text-sm font-medium text-text-primary" aria-live="polite">
                {monthLabel}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setVisibleMonth((current) => addMonths(current, 1))}
                className="flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              >
                <ChevronRight aria-hidden className="h-icon-sm w-icon-sm" />
              </button>
            </div>

            <div ref={gridRef} role="grid" aria-label={monthLabel} onKeyDown={handleGridKeyDown}>
              <div role="row" className="grid grid-cols-7">
                {weekdayLabels.map((weekday, index) => (
                  <span
                    key={`${weekday}-${index}`}
                    role="columnheader"
                    aria-hidden
                    className="flex h-7 items-center justify-center text-2xs font-medium text-text-tertiary"
                  >
                    {weekday}
                  </span>
                ))}
              </div>
              {weeks.map((week) => (
                <div key={toIso(week[0])} role="row" className="grid grid-cols-7">
                  {week.map((day) => {
                    const outsideMonth = day.month !== visibleMonth.month;
                    const isSelected = selected ? compareYmd(day, selected) === 0 : false;
                    const isActive = compareYmd(day, activeDay) === 0;
                    const isToday = compareYmd(day, today) === 0;
                    const isDisabled = disabledDay(day);
                    return (
                      <div key={toIso(day)} role="gridcell" aria-selected={isSelected}>
                        <button
                          type="button"
                          tabIndex={isActive ? 0 : -1}
                          data-active={isActive || undefined}
                          // `aria-disabled`, not `disabled`: a real `disabled`
                          // button drops out of the tab order and refuses
                          // `.focus()`, which breaks the roving-tabindex grid
                          // the moment an arrow key lands on a day past
                          // `min`/`max` — it would silently strand focus on
                          // the previous cell instead of landing on this one.
                          // `commit` already refuses the day either way.
                          aria-disabled={isDisabled || undefined}
                          aria-label={dayFormatter.format(new Date(day.year, day.month, day.day))}
                          onClick={() => commit(day)}
                          onFocus={() => setActiveDay(day)}
                          className={cn(
                            'flex h-8 w-8 items-center justify-center rounded-sm text-sm transition-colors',
                            'outline-none focus-visible:outline-2 focus-visible:outline-accent-500 focus-visible:outline-offset-1',
                            outsideMonth ? 'text-text-disabled' : 'text-text-primary',
                            !isDisabled && !isSelected && 'hover:bg-surface-hover',
                            isSelected && 'bg-ink text-text-inverse hover:bg-ink-hover',
                            !isSelected && isToday && 'font-semibold text-accent-600',
                            isDisabled && 'cursor-not-allowed text-text-disabled hover:bg-transparent',
                          )}
                        >
                          {day.day}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
