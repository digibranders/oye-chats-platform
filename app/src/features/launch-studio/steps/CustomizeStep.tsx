import { useState } from 'react';
import { Card } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

// Placeholder accent choices. TODO(phase-2b): seed from getClientSettings
// (recommended_colors) and persist primary_color via updateClientSettings.
const ACCENTS: { hex: string; name: string }[] = [
  { hex: '#a21caf', name: 'Violet' },
  { hex: '#4f46e5', name: 'Indigo' },
  { hex: '#0ea5e9', name: 'Sky' },
  { hex: '#059669', name: 'Emerald' },
  { hex: '#e11d48', name: 'Rose' },
  { hex: '#d97706', name: 'Amber' },
];

/**
 * Step 7 — Customize Widget. Appearance only (the agent's NAME is owned by the
 * Create Agent step). Kept light so the step stays fast; the full appearance
 * editor lives in the agent's Experience tab.
 */
export function CustomizeStep(props: StepProps) {
  const [accent, setAccent] = useState(ACCENTS[0].hex);

  return (
    <StepShell
      title="Make it yours"
      description="Pick your agent's accent colour. You can fine-tune everything else later."
      {...props}
    >
      <div className="space-y-5">
        <div>
          <span className="mb-2 block text-[13px] font-medium text-[var(--ds-text)]">
            Accent colour
          </span>
          <div className="flex flex-wrap gap-2.5">
            {ACCENTS.map((color) => (
              <button
                key={color.hex}
                type="button"
                onClick={() => setAccent(color.hex)}
                aria-label={color.name}
                aria-pressed={accent === color.hex}
                title={color.name}
                className="h-9 w-9 rounded-full border-2 transition-transform hover:scale-105"
                style={{
                  backgroundColor: color.hex,
                  borderColor: accent === color.hex ? 'var(--ds-text)' : 'transparent',
                }}
              />
            ))}
          </div>
        </div>

        <Card className="p-4">
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            Logos, greetings and tone are available in the Experience tab after launch.
          </p>
        </Card>
      </div>
    </StepShell>
  );
}
