import { memo } from 'react';
import { Card, CardSection, Disclosure, Grid } from '../../../ui';
import { NumberField } from './NumberField';
import { CONFIG_GROUPS, type ConfigFieldDef, toDisplay, toStored } from './behaviour.config';

export interface TimingSectionProps {
  config: Record<string, number>;
  onChange: (key: string, storedValue: number) => void;
}

const UNIT_LABEL: Record<ConfigFieldDef['unit'], string | undefined> = {
  seconds: 'seconds',
  ms: 'milliseconds',
  count: undefined,
};

/**
 * Timing and reliability — the lowest-level knobs on the widget, bound to
 * `Bot.widget_config`.
 *
 * Behind the system's own `Disclosure` rather than a hand-wired `aria-expanded`
 * button over a `hidden` div. `hidden` keeps nine number inputs mounted and
 * re-rendering on every keystroke of the page draft — the exact cost the `memo`
 * wrappers in this folder were added to avoid — and it left the card shipping
 * collapsed with a header and no body, whose two adjacent hairlines drew a
 * doubled square-ended line across the card's own rounded bottom edge.
 *
 * Every field is bounded in both directions. The server accepts `widget_config`
 * as an open map with no per-key validation, so a mistyped heartbeat of 5,000
 * seconds would be stored happily and simply stop the widget reconnecting. The
 * bounds are the only thing standing between a typo and a dead widget, so they
 * clamp on entry rather than merely warning.
 */
function TimingSectionInner({ config, onChange }: TimingSectionProps) {
  return (
    <Disclosure
      headingLevel={2}
      summary="Timing and reliability"
      regionLabel="Timing and reliability settings"
      trailing={
        <span className="text-xs text-text-tertiary">The defaults suit almost every site.</span>
      }
      panelClassName="ps-0 pt-2"
    >
      <Card>
        {CONFIG_GROUPS.map((group) => (
          <CardSection key={group.title}>
            <h3 className="text-base font-medium text-text-primary">{group.title}</h3>
            <Grid cols={2} className="mt-3">
              {group.fields.map((field) => (
                <NumberField
                  key={field.key}
                  label={field.label}
                  hint={field.help}
                  unitLabel={UNIT_LABEL[field.unit]}
                  value={toDisplay(field, config[field.key] ?? field.defaultValue)}
                  step={field.step}
                  min={field.min}
                  max={field.max}
                  onChange={(raw) => onChange(field.key, toStored(field, raw))}
                />
              ))}
            </Grid>
          </CardSection>
        ))}
      </Card>
    </Disclosure>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const TimingSection = memo(TimingSectionInner);
