/**
 * A weekly opening schedule.
 *
 * Drives the same JSONB the backend's offline-hours resolver reads, on both
 * `Department.business_hours` and `Bot.business_hours`:
 *
 *     { enabled, timezone, days: { mon: { enabled, start, end }, … } }
 *
 * A null value, or `enabled: false`, means "always open" — the resolver
 * short-circuits without looking at the days at all. That is why the master
 * switch is a real state and not just a way of hiding the rows: turning it off
 * is what a workspace with no fixed hours actually wants to say.
 */

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

export const BUSINESS_DAYS: readonly { key: string; label: string }[] = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultBusinessHours(): BusinessHours {
  return {
    enabled: false,
    timezone: localTimezone(),
    days: Object.fromEntries(
      BUSINESS_DAYS.map(({ key }) => [
        key,
        { enabled: key !== 'sat' && key !== 'sun', start: '09:00', end: '17:00' },
      ]),
    ),
  };
}

/** Merge a stored (possibly null or partial) value with defaults. */
export function normalizeBusinessHours(value: BusinessHours | null | undefined): BusinessHours {
  const base = defaultBusinessHours();
  if (!value) return base;
  return {
    enabled: Boolean(value.enabled),
    timezone: value.timezone || base.timezone,
    days: { ...base.days, ...(value.days ?? {}) },
  };
}

/**
 * A day whose end is not after its start is never open.
 *
 * The previous editor accepted 17:00–09:00 silently, and the resolver then read
 * the department as closed all week with nothing on screen saying so.
 */
export function invalidDays(hours: BusinessHours): string[] {
  if (!hours.enabled) return [];
  return BUSINESS_DAYS.filter(({ key }) => {
    const day = hours.days[key];
    return day?.enabled === true && day.start >= day.end;
  }).map(({ key }) => key);
}

export function timezoneOptions(current: string): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (kind: string) => string[] })
      .supportedValuesOf;
    if (supported) {
      const list = supported('timeZone');
      return list.includes(current) ? list : [current, ...list];
    }
  } catch {
    /* Browsers without `supportedValuesOf` fall through to the short list. */
  }
  return [...new Set(['UTC', current].filter(Boolean))];
}
