import { useState } from 'react';
import { Copy, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card } from '../../../design-system';
import { platforms, categoryLabels, categoryOrder } from '../../../data/platformIntegrations';
import { recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';

const ENV = 'production' as const;

/** A copyable code block. */
function CopyableCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — code is selectable
    }
  };
  return (
    <div className="relative mt-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-3">
      <pre className="overflow-x-auto pr-9">
        <code className="font-mono text-[12px] leading-relaxed text-[var(--ds-text)]">{code}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy code"
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
      >
        {copied ? <Check size={14} className="text-[var(--ds-success)]" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/**
 * Step 8 — Deploy. Pick your platform FIRST, then get platform-specific install
 * instructions (Next.js/WordPress/Shopify/…). Data is reused from the legacy
 * platform-integration config; the UI is rebuilt fresh on the new design system.
 */
export function DeployStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const botKey = selectedBot?.bot_key ?? 'bot-xxxxxxxx';
  const [platformId, setPlatformId] = useState<string | null>(null);

  const platform = platforms.find((p) => p.id === platformId) ?? null;

  // ── Platform picker ──────────────────────────────────────────────
  if (!platform) {
    return (
      <StepShell
        title="Where's your site?"
        description="Pick your platform and we'll give you exact install steps."
        onBack={props.onBack}
        onContinue={props.onContinue}
        isFirst={props.isFirst}
        isLast={props.isLast}
        canContinue={false}
      >
        <div className="space-y-5">
          {categoryOrder.map((category) => {
            const inCategory = platforms.filter((p) => p.category === category);
            if (inCategory.length === 0) return null;
            return (
              <div key={category}>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
                  {categoryLabels[category] ?? category}
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {inCategory.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPlatformId(p.id)}
                      className="flex items-center justify-between gap-2 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3.5 py-3 text-left transition-colors hover:border-[var(--ds-accent)]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-[var(--ds-text)]">
                          {p.name}
                        </p>
                        <p className="truncate text-[11px] text-[var(--ds-text-subtle)]">
                          {p.description}
                        </p>
                      </div>
                      <ChevronRight size={15} className="shrink-0 text-[var(--ds-text-subtle)]" />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </StepShell>
    );
  }

  // ── Platform-specific guide ──────────────────────────────────────
  const steps = platform.getSteps(botKey, ENV);
  return (
    <StepShell
      title={`Add OyeChats to ${platform.name}`}
      description="Follow these steps to put your agent live."
      onBack={props.onBack}
      onContinue={() => {
        void recordActivationEvent('snippet_copied', { botId: selectedBot?.id ?? null });
        props.onContinue();
      }}
      isFirst={props.isFirst}
      isLast={props.isLast}
      continueLabel="I've added it"
    >
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setPlatformId(null)}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text)]"
        >
          <ChevronLeft size={14} />
          Change platform
        </button>

        <ol className="space-y-4">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[11px] font-semibold text-[var(--ds-accent-text)]">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[var(--ds-text)]">{step.title}</p>
                <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">{step.description}</p>
                {step.code && <CopyableCode code={step.code} />}
              </div>
            </li>
          ))}
        </ol>

        <Card className="p-3">
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            Once you've added it, continue — we'll confirm it's live on the next step.
          </p>
        </Card>
      </div>
    </StepShell>
  );
}
