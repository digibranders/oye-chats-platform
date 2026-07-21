import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '../../../design-system';
import { recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

/**
 * Step 8 — Deploy. Copy the embed snippet (real bot_key) and add it to the site.
 * TODO(2b.2): platform selector first (Next.js/WordPress/Shopify/…) so the guide
 * is platform-specific — reuse legacy PlatformSelector + IntegrationGuide.
 */
export function DeployStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const [copied, setCopied] = useState(false);

  const botKey = selectedBot?.bot_key ?? 'bot-xxxxxxxx';
  const snippet = `<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="${botKey}"></script>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      void recordActivationEvent('snippet_copied', { botId: selectedBot?.id ?? null });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the snippet is selectable in the block below.
    }
  };

  return (
    <StepShell
      title="Add it to your site"
      description="Paste this snippet just before the closing </body> tag on every page."
      onBack={props.onBack}
      onContinue={props.onContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      continueLabel="I've added it"
    >
      <div className="space-y-3">
        <div className="relative rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-4">
          <code className="block break-all pr-10 font-mono text-[12px] leading-relaxed text-[var(--ds-text)]">
            {snippet}
          </code>
          <button
            type="button"
            onClick={copy}
            aria-label="Copy snippet"
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
          >
            {copied ? <Check size={16} className="text-[var(--ds-success)]" /> : <Copy size={16} />}
          </button>
        </div>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? 'Copied!' : 'Copy snippet'}
        </Button>
        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          Using WordPress, Shopify or Webflow? Platform-specific guides are coming here.
        </p>
      </div>
    </StepShell>
  );
}
