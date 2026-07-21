import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '../../../design-system';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

// Placeholder snippet. TODO(phase-2b): use the real bot_key + PlatformSelector /
// IntegrationGuide for per-platform install instructions.
const SNIPPET =
  '<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxxxxxxx"></script>';

/**
 * Step 8 — Deploy. Copy the embed snippet and add it to the site. Split from
 * Verify (a distinct step) so installation confirmation is explicit.
 */
export function DeployStep(props: StepProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SNIPPET);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the snippet is selectable in the block below.
    }
  };

  return (
    <StepShell
      title="Add it to your site"
      description="Paste this snippet just before the closing </body> tag on every page."
      continueLabel="I've added it"
      {...props}
    >
      <div className="space-y-3">
        <div className="relative rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-4">
          <code className="block break-all pr-10 font-mono text-[12px] leading-relaxed text-[var(--ds-text)]">
            {SNIPPET}
          </code>
          <button
            type="button"
            onClick={copy}
            aria-label="Copy snippet"
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
          >
            {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
          </button>
        </div>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? 'Copied!' : 'Copy snippet'}
        </Button>
        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          Using WordPress, Shopify or Webflow? Platform-specific guides appear here after launch.
        </p>
      </div>
    </StepShell>
  );
}
