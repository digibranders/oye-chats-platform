import { useState } from 'react';
import { Input, Card } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

// Placeholder accent choices. TODO(phase-2b): seed from getClientSettings
// (recommended_colors) and persist name + primary_color via updateClientSettings.
const ACCENTS = ['#a21caf', '#4f46e5', '#0ea5e9', '#059669', '#e11d48', '#d97706'];

/**
 * Step 6 — Customize Widget. Kept intentionally light (name + accent) so the
 * step stays fast; the full appearance editor lives in the agent's Experience
 * tab. Richer than the legacy step, which offered name + one colour only.
 */
export function CustomizeStep(props: StepProps) {
  const [name, setName] = useState('Support Assistant');
  const [accent, setAccent] = useState(ACCENTS[0]);

  return (
    <StepShell
      title="Make it yours"
      description="Give your agent a name and a colour. You can fine-tune everything else later."
      canContinue={name.trim().length > 0}
      {...props}
    >
      <div className="space-y-5">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]">
            Agent name
          </span>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Support Assistant" />
        </label>

        <div>
          <span className="mb-2 block text-[13px] font-medium text-[var(--ds-text)]">Accent colour</span>
          <div className="flex flex-wrap gap-2.5">
            {ACCENTS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setAccent(color)}
                aria-label={`Select ${color}`}
                aria-pressed={accent === color}
                className="h-9 w-9 rounded-full border-2 transition-transform hover:scale-105"
                style={{
                  backgroundColor: color,
                  borderColor: accent === color ? 'var(--ds-text)' : 'transparent',
                }}
              />
            ))}
          </div>
        </div>

        <Card className="p-4">
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            Changes preview live on the right. Logos, greetings and tone are available in the
            Experience tab after launch.
          </p>
        </Card>
      </div>
    </StepShell>
  );
}
