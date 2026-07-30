/**
 * BusinessHoursEditor - reusable weekly-schedule editor.
 *
 * Rebuilt from the orphaned legacy `components/BusinessHoursEditor.jsx` (which
 * had no route into Admin 2.0). Drives the same JSONB shape stored on
 * `Department.business_hours` (and `Bot.business_hours`), so the backend
 * offline-hours resolver is unchanged:
 *
 *   { enabled, timezone, days: { mon: { enabled, start, end }, … } }
 *
 * A null/absent value (or `enabled: false`) means "always open" - the resolver
 * short-circuits without checking days.
 */
import { type ReactElement } from 'react';
import { Clock } from 'lucide-react';
import { cn, Select } from '../../design-system';

export interface DayHours {
  enabled: boolean;
  start: string;
  end: string;
}

export interface BusinessHours {
  enabled: boolean;
  timezone: string;
  days: Record<string, DayHours>;
}

const DAYS: readonly { key: string; label: string }[] = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function defaultHours(): BusinessHours {
  return {
    enabled: false,
    timezone: localTimezone(),
    days: Object.fromEntries(
      DAYS.map(({ key }) => [key, { enabled: key !== 'sat' && key !== 'sun', start: '09:00', end: '17:00' }]),
    ),
  };
}

/** Merge a stored (possibly partial/null) value with defaults so callers can pass null safely. */
function normalizeBusinessHours(value: BusinessHours | null | undefined): BusinessHours {
  const base = defaultHours();
  if (!value) return base;
  return {
    enabled: Boolean(value.enabled),
    timezone: value.timezone || base.timezone,
    days: { ...base.days, ...(value.days || {}) },
  };
}

function timezoneOptions(current: string): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (supported) {
      const list = supported('timeZone');
      return list.includes(current) ? list : [current, ...list];
    }
  } catch {
    /* fall through */
  }
  return [...new Set(['UTC', current].filter(Boolean))];
}

function Toggle({
  checked,
  onChange,
  disabled,
  id,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  label: string;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
        'focus:outline-none focus-visible:shadow-[0_0_0_2px_var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-bg-sunken)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}

const timeInputClass =
  'rounded-[var(--ds-radius-md)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-2 py-1 text-xs text-[var(--ds-text)] outline-none focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]';

export interface BusinessHoursEditorProps {
  value: BusinessHours | null | undefined;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
}

export function BusinessHoursEditor({ value, onChange, disabled = false }: BusinessHoursEditorProps): ReactElement {
  const hours = normalizeBusinessHours(value);

  const update = (mutator: (h: BusinessHours) => BusinessHours): void => {
    onChange(mutator({ ...hours, days: { ...hours.days } }));
  };

  return (
    <div className="space-y-4">
      {/* Master enable - null/false means "always open". */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text)]">
            <Clock size={14} aria-hidden="true" className="text-[var(--ds-accent)]" />
            Enable business hours
          </p>
          <p className="mt-0.5 text-[12px] text-[var(--ds-text-subtle)]">
            Outside these hours, visitors see the offline form for this department.
          </p>
        </div>
        <Toggle
          label="Enable business hours"
          checked={hours.enabled}
          disabled={disabled}
          onChange={(v) => update((h) => ({ ...h, enabled: v }))}
        />
      </div>

      {hours.enabled && (
        <>
          <div className="flex items-center justify-between gap-4">
            <span className="shrink-0 text-[13px] text-[var(--ds-text-muted)]">Timezone</span>
            <div className="w-full max-w-[16rem]">
              <Select
                value={hours.timezone}
                disabled={disabled}
                searchable
                onChange={(timezone) => update((h) => ({ ...h, timezone }))}
                aria-label="Timezone"
                options={timezoneOptions(hours.timezone).map((tz) => ({ value: tz, label: tz }))}
              />
            </div>
          </div>

          <div className="divide-y divide-[var(--ds-border)] overflow-hidden rounded-xl border border-[var(--ds-border)]">
            {DAYS.map(({ key, label }) => {
              const day = hours.days[key] ?? { enabled: false, start: '09:00', end: '17:00' };
              return (
                <div key={key} className="flex items-center gap-3 bg-[var(--ds-bg-surface)] px-4 py-3">
                  <Toggle
                    id={`bh-${key}`}
                    label={`${label} enabled`}
                    checked={day.enabled}
                    disabled={disabled}
                    onChange={(v) =>
                      update((h) => ({ ...h, days: { ...h.days, [key]: { ...day, enabled: v } } }))
                    }
                  />
                  <label
                    htmlFor={`bh-${key}`}
                    className="w-24 shrink-0 cursor-pointer text-[13px] text-[var(--ds-text-muted)]"
                  >
                    {label}
                  </label>
                  {day.enabled ? (
                    <div className="ml-auto flex items-center gap-2">
                      <input
                        type="time"
                        value={day.start}
                        disabled={disabled}
                        aria-label={`${label} opening time`}
                        onChange={(e) =>
                          update((h) => ({ ...h, days: { ...h.days, [key]: { ...day, start: e.target.value } } }))
                        }
                        className={timeInputClass}
                      />
                      <span className="text-xs text-[var(--ds-text-subtle)]">to</span>
                      <input
                        type="time"
                        value={day.end}
                        disabled={disabled}
                        aria-label={`${label} closing time`}
                        onChange={(e) =>
                          update((h) => ({ ...h, days: { ...h.days, [key]: { ...day, end: e.target.value } } }))
                        }
                        className={timeInputClass}
                      />
                    </div>
                  ) : (
                    <span className="ml-auto text-xs text-[var(--ds-text-subtle)]">Closed</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
