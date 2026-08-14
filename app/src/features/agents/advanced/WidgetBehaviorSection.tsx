import { type ReactElement } from 'react';
import { Sliders } from 'lucide-react';
import { Card, SectionHeader } from '../../../design-system';
import { Toggle } from './controls';
import { FEATURE_FLAGS } from './advanced.config';

interface WidgetBehaviorSectionProps {
  flags: Record<string, boolean>;
  onToggle: (key: string, next: boolean) => void;
}

/**
 * Widget behaviour - per-agent feature toggles bound to the reused
 * `feature_flags` Bot field. Plan-based locking is enforced server-side
 * (bot_routes.py), so this surface always reflects the saved values.
 */
export function WidgetBehaviorSection({
  flags,
  onToggle,
}: WidgetBehaviorSectionProps): ReactElement {
  return (
    <section aria-labelledby="behavior-heading" className="space-y-4">
      <SectionHeader
        title={
          <span id="behavior-heading" className="inline-flex items-center gap-2">
            <Sliders size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
            Widget behaviour
          </span>
        }
        description="Turn individual widget features on or off for this chatbot."
      />

      <Card className="divide-y divide-[var(--ds-border)]">
        {FEATURE_FLAGS.map((flag) => {
          const Icon = flag.icon;
          const checked = flags[flag.key] ?? flag.default;
          return (
            <div key={flag.key} className="flex items-center justify-between gap-4 p-4">
              <div className="flex min-w-0 items-start gap-3">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]"
                  aria-hidden="true"
                >
                  <Icon size={15} />
                </div>
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-[var(--ds-text)]">{flag.label}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
                    {flag.desc}
                  </p>
                </div>
              </div>
              <Toggle
                checked={checked}
                onChange={(next) => onToggle(flag.key, next)}
                label={flag.label}
              />
            </div>
          );
        })}
      </Card>
    </section>
  );
}
