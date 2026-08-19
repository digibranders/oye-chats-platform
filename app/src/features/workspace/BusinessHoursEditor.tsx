import { Combobox, Field, Input, Switch } from '../../ui';
import {
  BUSINESS_DAYS,
  invalidDays,
  normalizeBusinessHours,
  timezoneOptions,
  type BusinessHours,
} from './businessHours';

export interface BusinessHoursEditorProps {
  value: BusinessHours | null | undefined;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
}

export function BusinessHoursEditor({
  value,
  onChange,
  disabled = false,
}: BusinessHoursEditorProps) {
  const hours = normalizeBusinessHours(value);
  const invalid = new Set(invalidDays(hours));

  const update = (mutate: (current: BusinessHours) => BusinessHours): void => {
    onChange(mutate({ ...hours, days: { ...hours.days } }));
  };

  return (
    <div className="space-y-4">
      <Switch
        label="Set opening hours"
        description="Outside them, visitors are shown the offline form instead of a live operator."
        checked={hours.enabled}
        disabled={disabled}
        onCheckedChange={(next) => update((current) => ({ ...current, enabled: next }))}
      />

      {hours.enabled ? (
        <>
          <Field label="Timezone" hint="Hours below are read in this zone.">
            <Combobox
              label="Timezone"
              value={hours.timezone}
              disabled={disabled}
              options={timezoneOptions(hours.timezone).map((zone) => ({
                value: zone,
                label: zone,
              }))}
              onValueChange={(zone) =>
                update((current) => ({ ...current, timezone: zone ?? current.timezone }))
              }
            />
          </Field>

          <ul className="overflow-hidden rounded-md border border-border">
            {BUSINESS_DAYS.map(({ key, label }) => {
              const day = hours.days[key] ?? { enabled: false, start: '09:00', end: '17:00' };
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center gap-3 border-t border-border bg-surface px-3 py-2.5 first:border-t-0"
                >
                  <Switch
                    size="sm"
                    label={label}
                    checked={day.enabled}
                    disabled={disabled}
                    onCheckedChange={(next) =>
                      update((current) => ({
                        ...current,
                        days: { ...current.days, [key]: { ...day, enabled: next } },
                      }))
                    }
                    className="w-40"
                  />
                  {day.enabled ? (
                    <div className="ml-auto flex items-center gap-2">
                      <Input
                        size="sm"
                        type="time"
                        value={day.start}
                        disabled={disabled}
                        aria-label={`${label} opens at`}
                        aria-invalid={invalid.has(key) || undefined}
                        className="figure w-28"
                        onChange={(event) =>
                          update((current) => ({
                            ...current,
                            days: { ...current.days, [key]: { ...day, start: event.target.value } },
                          }))
                        }
                      />
                      <span className="text-xs text-text-tertiary">to</span>
                      <Input
                        size="sm"
                        type="time"
                        value={day.end}
                        disabled={disabled}
                        aria-label={`${label} closes at`}
                        aria-invalid={invalid.has(key) || undefined}
                        className="figure w-28"
                        onChange={(event) =>
                          update((current) => ({
                            ...current,
                            days: { ...current.days, [key]: { ...day, end: event.target.value } },
                          }))
                        }
                      />
                    </div>
                  ) : (
                    <span className="ml-auto text-xs text-text-tertiary">Closed</span>
                  )}
                </li>
              );
            })}
          </ul>

          {invalid.size > 0 ? (
            <p role="status" aria-live="polite" className="text-xs text-danger">
              {invalid.size === 1 ? 'One day closes' : `${invalid.size} days close`} before it opens.
              A day like that is treated as closed all day.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-text-secondary">
          Available around the clock. Whether anyone is actually there is decided by each
          operator's own online switch.
        </p>
      )}
    </div>
  );
}
