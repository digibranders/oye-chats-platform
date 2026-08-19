import { useState, memo } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, CardSection, cn } from '../../../ui';
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
 * Behind a disclosure because the defaults suit almost every site and the
 * section is nine fields long, but the disclosure is a real button with
 * `aria-expanded` and an `aria-controls` target rather than a div that toggles a
 * class.
 *
 * Every field is bounded in both directions. The server accepts `widget_config`
 * as an open map with no per-key validation, so a mistyped heartbeat of 5,000
 * seconds would be stored happily and simply stop the widget reconnecting. The
 * bounds are the only thing standing between a typo and a dead widget, so they
 * clamp on entry rather than merely warning.
 */
function TimingSectionInner({ config, onChange }: TimingSectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader
        title="Timing and reliability"
        titleAs="h2"
        description="Animation timing, frustration detection and how the widget recovers a dropped connection. The defaults work well — change these only if you know you need to."
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setOpen((previous) => !previous)}
            aria-expanded={open}
            aria-controls="timing-panel"
          >
            {open ? 'Hide' : 'Show'} settings
            <ChevronDown
              aria-hidden
              className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
            />
          </Button>
        }
      />
      <div id="timing-panel" hidden={!open}>
        {CONFIG_GROUPS.map((group, index) => {
          const Icon = group.icon;
          const Wrapper = index === 0 ? CardBody : CardSection;
          return (
            <Wrapper key={group.title}>
              <div className="flex items-start gap-2.5">
                <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
                <div className="min-w-0">
                  <h3 className="text-base font-medium text-text-primary">{group.title}</h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
                    {group.description}
                  </p>
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
              </div>
            </Wrapper>
          );
        })}
      </div>
    </Card>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const TimingSection = memo(TimingSectionInner);
