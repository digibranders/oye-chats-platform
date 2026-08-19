import { type ReactElement, useMemo } from 'react';
import { Checkbox, Field, Input, Select, Switch } from '../../../ui';
import {
  DAY_KEYS,
  DAY_LABELS,
  defaultBusinessHours,
  localTimezone,
  type BusinessHours,
  type DayKey,
  type DraftErrors,
} from './experience-model';

/**
 * When the chatbot's people are around.
 *
 * Two things about this editor are corrections rather than choices.
 *
 * **It writes the shape the server reads.** The schedule is
 * `{timezone, mon: {start, end} | null, …}` — day keys at the top level, a
 * closed day expressed as `null`. `bot_routes.BusinessHours` declares
 * `extra="forbid"`, so an `enabled` flag or a `days: {…}` wrapper is not stored
 * and ignored, it is a 422. The workspace-level editor this replaces sent
 * exactly that shape, which is why saving hours there could not work at all.
 *
 * **It writes to the chatbot in the URL.** That editor read and wrote
 * `bots[0]`, so a workspace's second and subsequent chatbots had no reachable
 * way to be given a schedule.
 *
 * The whole schedule being absent means "always available" — the availability
 * service short-circuits on a null config — so the switch removes the object
 * rather than setting a flag inside it.
 */

export interface BusinessHoursFieldProps {
  value: BusinessHours | null;
  onChange: (value: BusinessHours | null) => void;
  errors: DraftErrors;
  disabled?: boolean;
}

/** Every zone the browser knows, so a schedule can be set for where the team is. */
function timezoneOptions(current: string): { value: string; label: string }[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  let zones: string[] = [];
  try {
    zones = supported ? supported('timeZone') : [];
  } catch {
    zones = [];
  }
  const all = zones.length > 0 ? zones : ['UTC', localTimezone()];
  const unique = Array.from(new Set([current, ...all].filter(Boolean)));
  return unique.map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }));
}

export function BusinessHoursField({
  value,
  onChange,
  errors,
  disabled = false,
}: BusinessHoursFieldProps): ReactElement {
  const timezone = value?.timezone ?? localTimezone();
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);

  const setDay = (key: DayKey, day: { start: string; end: string } | null): void => {
    if (!value) return;
    onChange({ ...value, days: { ...value.days, [key]: day } });
  };

  return (
    <div className="flex flex-col gap-5">
      <Switch
        label="Only available at set hours"
        description="Outside them the widget shows your offline banner and takes a message instead of queueing for a person."
        checked={value !== null}
        disabled={disabled}
        onCheckedChange={(on) => onChange(on ? defaultBusinessHours() : null)}
      />

      {value ? (
        <>
          <Field
            label="Time zone"
            hint="The hours below are read in this zone, wherever your visitor is."
          >
            <Select
              options={zones}
              value={timezone}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, timezone: event.target.value })}
              className="max-w-xs"
            />
          </Field>

          <fieldset className="min-w-0">
            <legend className="text-base font-medium text-text-primary">Weekly hours</legend>
            <ul className="mt-2.5 flex flex-col">
              {DAY_KEYS.map((key) => {
                const day = value.days[key];
                const error = errors[`businessHours:${key}`];
                return (
                  <li key={key} className="flex flex-col gap-1.5 border-t border-border py-2.5 first:border-t-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="w-40 shrink-0">
                        <Checkbox
                          label={DAY_LABELS[key]}
                          checked={day !== null}
                          disabled={disabled}
                          onCheckedChange={(checked) =>
                            setDay(key, checked === true ? { start: '09:00', end: '17:00' } : null)
                          }
                        />
                      </span>
                      {day ? (
                        <span className="flex items-center gap-2">
                          <Input
                            type="time"
                            size="sm"
                            value={day.start}
                            disabled={disabled}
                            aria-label={`${DAY_LABELS[key]} opens at`}
                            aria-invalid={error ? true : undefined}
                            onChange={(event) => setDay(key, { ...day, start: event.target.value })}
                            className="figure w-28"
                          />
                          <span aria-hidden className="text-xs text-text-tertiary">
                            to
                          </span>
                          <Input
                            type="time"
                            size="sm"
                            value={day.end}
                            disabled={disabled}
                            aria-label={`${DAY_LABELS[key]} closes at`}
                            aria-invalid={error ? true : undefined}
                            onChange={(event) => setDay(key, { ...day, end: event.target.value })}
                            className="figure w-28"
                          />
                        </span>
                      ) : (
                        <span className="text-xs text-text-secondary">Closed</span>
                      )}
                    </div>
                    {error ? (
                      <p role="status" className="text-xs text-danger">
                        {error}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <p className="text-xs leading-relaxed text-text-secondary">
            A closing time earlier than its opening time means the day runs past midnight — 22:00 to
            02:00 is a valid late shift.
          </p>
        </>
      ) : null}
    </div>
  );
}
