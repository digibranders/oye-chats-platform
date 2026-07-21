import { useState } from 'react';
import { Globe, Upload } from 'lucide-react';
import { Input, Card } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

/**
 * Step 3 — Connect Website. The single ask: where should the agent learn from?
 * Includes an upload fallback (audit gap: legacy onboarding was crawl-only and
 * dead-ended on JS-rendered / site-less accounts).
 * TODO(phase-2b): create the bot + persist the website via createBot/updateBot.
 */
export function ConnectStep(props: StepProps) {
  const [url, setUrl] = useState('');

  return (
    <StepShell
      title="Connect your website"
      description="Your AI learns from your website. Drop in your address and we'll do the rest."
      canContinue={url.trim().length > 0}
      {...props}
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]">
            Website address
          </span>
          <div className="relative">
            <Globe
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
            />
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="yourcompany.com"
              className="pl-9"
              autoFocus
            />
          </div>
        </label>

        <Card className="flex items-center gap-3 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
            <Upload size={17} />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[var(--ds-text)]">No website? Upload documents</p>
            <p className="text-[12px] text-[var(--ds-text-subtle)]">
              PDFs, docs or text — a fallback for sites we can't crawl.
            </p>
          </div>
        </Card>
      </div>
    </StepShell>
  );
}
