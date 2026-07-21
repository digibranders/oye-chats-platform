import { type ReactElement, useState } from 'react';
import { Timer, ChevronDown } from 'lucide-react';
import { Card, SectionHeader, cn } from '../../../design-system';
import { NumberField } from './controls';
import { CONFIG_GROUPS, type ConfigFieldDef } from './advanced.config';

interface TimingReliabilitySectionProps {
  config: Record<string, number>;
  onChange: (key: string, storedValue: number) => void;
}

const UNIT_SUFFIX: Record<ConfigFieldDef['unit'], string | undefined> = {
  seconds: 'sec',
  ms: 'ms',
  count: undefined,
};

/** Convert a stored value (ms/int) into its display value for the field's unit. */
function toDisplay(field: ConfigFieldDef, stored: number): number {
  if (field.unit === 'seconds') {
    // Round to 2 decimals so 350ms shows as 0.35, not 0.35000000001.
    return Math.round((stored / 1000) * 100) / 100;
  }
  return stored;
}

/** Convert a raw input string back into the stored value (ms/int), clamped. */
function toStored(field: ConfigFieldDef, raw: string): number {
  const parsed = field.unit === 'count' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return field.defaultValue;
  const display = Math.max(field.min, parsed);
  if (field.unit === 'seconds') return Math.round(display * 1000);
  if (field.unit === 'count') return Math.round(display);
  return display;
}

/**
 * Timing & reliability — the deepest widget_config knobs. Hidden behind
 * progressive disclosure because the defaults suit almost every site; only
 * power users tuning animation timing, frustration detection or WebSocket
 * reconnection need to open it.
 */
export function TimingReliabilitySection({
  config,
  onChange,
}: TimingReliabilitySectionProps): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <section aria-labelledby="timing-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="timing-heading" className="inline-flex items-center gap-2">
            <Timer size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
            Timing &amp; reliability
          </span>
        }
        description="Low-level timing for animations, frustration detection and connection recovery. The defaults work well — only change these if you know you need to."
      />

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls="timing-panel"
        className={cn(
          'flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-4 py-3 text-left transition-colors hover:border-[var(--ds-text-subtle)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-bg-canvas)]',
        )}
      >
        <span className="text-[13px] font-medium text-[var(--ds-text)]">
          {open ? 'Hide advanced timing settings' : 'Show advanced timing settings'}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cn(
            'shrink-0 text-[var(--ds-text-subtle)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div id="timing-panel" className="space-y-4">
          {CONFIG_GROUPS.map((group) => {
            const GroupIcon = group.icon;
            return (
              <Card key={group.title} className="space-y-4 p-5">
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]"
                    aria-hidden="true"
                  >
                    <GroupIcon size={15} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-semibold text-[var(--ds-text)]">
                      {group.title}
                    </h3>
                    <p className="mt-0.5 text-[12px] text-[var(--ds-text-subtle)]">
                      {group.description}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {group.fields.map((field) => (
                    <NumberField
                      key={field.key}
                      id={`cfg-${field.key}`}
                      label={field.label}
                      help={field.help}
                      value={toDisplay(field, config[field.key] ?? field.defaultValue)}
                      unit={UNIT_SUFFIX[field.unit]}
                      step={field.step}
                      min={field.min}
                      onChange={(raw) => onChange(field.key, toStored(field, raw))}
                    />
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
