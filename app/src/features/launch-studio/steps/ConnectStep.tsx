import { useState } from 'react';
import { Globe, Upload } from 'lucide-react';
import { Input, Card } from '../../../design-system';
import { updateBot, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useCrawl } from '../../../context/CrawlContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

function normalizeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * Step 3 — Connect Website. Saves the website on the agent and kicks off a real
 * crawl (monitored on the AI Training step). Includes an upload fallback for
 * sites that can't be crawled.
 */
export function ConnectStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const { crawl, startCrawl } = useCrawl();
  const [url, setUrl] = useState(selectedBot?.website ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!selectedBot) {
      setError('Create your agent first.');
      return;
    }
    const site = normalizeUrl(trimmed);
    setSubmitting(true);
    setError(null);
    try {
      await updateBot(selectedBot.id, { website: site });
      // Start the crawl unless one is already running / finished for this agent.
      const alreadyRunning =
        crawl.botId === selectedBot.id && (crawl.status === 'running' || crawl.status === 'done');
      if (!alreadyRunning) {
        await startCrawl({
          url: site,
          botId: selectedBot.id,
          botName: selectedBot.name,
          mode: 'full',
        });
        void recordActivationEvent('crawl_started', { botId: selectedBot.id });
      }
      props.onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <StepShell
      title="Connect your website"
      description="Your AI learns from your website. Drop in your address and we'll do the rest."
      onBack={props.onBack}
      onContinue={handleContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={url.trim().length > 0 && !submitting}
      continueLabel={submitting ? 'Starting…' : undefined}
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

        {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}

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
