import { useState } from 'react';
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Link2,
} from 'lucide-react';
import {
  platforms,
  categoryLabels,
  categoryOrder,
} from '../../../data/platformIntegrations';
import { getApiBaseUrl, getBotDemoUrl, trackDemoShareClick } from '../../../services/api';
import { cn, platformLogos, Skeleton } from '../../../design-system';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getEmbedEnvironment } from './embedEnvironment';
import { buildInstallPrompt } from './installPrompt';

/** A copyable code block. Clipboard write is best-effort; the code is always selectable. */
function CopyableCode({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. insecure context) - the code stays selectable.
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
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
      >
        {copied ? <Check size={14} className="text-[var(--ds-success)]" /> : <Copy size={14} />}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? `${label} copied` : ''}
      </span>
    </div>
  );
}

function maskKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 6)}••••••••${key.slice(-4)}` : key;
}

export interface WebsiteInstallProps {
  /** The agent's public embed key (`data-bot-key`). */
  botKey: string;
  /** The agent's numeric id - used to attribute demo-link shares. */
  botId: number;
}

/**
 * WebsiteInstall - everything needed to put the agent live on a website: the
 * embed key (reveal + copy), a link to a hosted preview, and platform-specific
 * install steps. The platform config + snippets are reused wholesale from the
 * legacy `data/platformIntegrations` module (see `pages/my-bots/InstallDrawer.jsx`
 * for the original drawer); only the presentation is rebuilt on the design system.
 */
export function WebsiteInstall({ botKey, botId }: WebsiteInstallProps) {
  const [showKey, setShowKey] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [demoCopied, setDemoCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [platformId, setPlatformId] = useState<string | null>(null);

  const platform = platforms.find((p) => p.id === platformId) ?? null;
  const demoUrl = getBotDemoUrl(botKey);
  const env = getEmbedEnvironment(getApiBaseUrl());

  // Plans entitled to remove branding get a snippet with no attribution anchor.
  // Note this keys off the entitlement, not the bot's live `showBranding` flag,
  // which this screen does not load - a paid customer who chooses to keep the
  // badge still gets an anchor-free snippet.
  //
  // `loading` guards this: the entitlements fallback defaults `branding_removable`
  // to `false`, so a not-yet-resolved fetch would otherwise compute `attribution
  // = true` even for a workspace entitled to remove it. Unlike `FeatureGate`'s
  // optimistic `loadingFallback` (safe there only because the backend re-checks
  // the gated action), nothing re-verifies a value the user has already copied to
  // their clipboard - so instead of guessing, the steps and the copy-prompt
  // button below stay inert (skeleton / disabled) until entitlements resolve,
  // matching `JourneyPage`'s "wait for entitlements before deciding" pattern.
  const { hasFeature, loading: entitlementsLoading } = useEntitlements();
  const attribution = !hasFeature('branding_removable');

  const copyKey = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(botKey);
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      // Clipboard blocked - the key is visible when revealed.
    }
  };

  const copyDemoLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(demoUrl);
      setDemoCopied(true);
      window.setTimeout(() => setDemoCopied(false), 2000);
    } catch {
      // Clipboard blocked - the demo link is still reachable via the button above.
    }
    // Attribution is best-effort: a failed track must not undo the copy.
    try {
      await trackDemoShareClick(botId);
    } catch {
      // Analytics failures are non-fatal.
    }
  };

  const copyAgentPrompt = async (): Promise<void> => {
    // Belt-and-suspenders alongside the button's `disabled` state: never build a
    // prompt from an unresolved `attribution` - see the comment above its
    // computation for why this can't default safely like `FeatureGate` does.
    if (entitlementsLoading) return;
    try {
      await navigator.clipboard.writeText(
        buildInstallPrompt({ botKey, apiBaseUrl: getApiBaseUrl(), env, platform, attribution }),
      );
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. insecure context) - the steps below still work by hand.
    }
  };

  return (
    <div className="space-y-6">
      {/* Embed key + preview */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
              <Key size={11} aria-hidden="true" /> Embed key
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Hide embed key' : 'Show embed key'}
                className="flex h-6 w-6 items-center justify-center rounded text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button
                type="button"
                onClick={copyKey}
                className="flex items-center gap-1 rounded px-1 text-[11px] font-semibold uppercase text-[var(--ds-accent-text)] transition-colors hover:text-[var(--ds-accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
              >
                {keyCopied ? <Check size={12} /> : <Copy size={12} />}
                {keyCopied ? 'Copied' : 'Copy'}
              </button>
              <span role="status" aria-live="polite" className="sr-only">
                {keyCopied ? 'Embed key copied' : ''}
              </span>
            </div>
          </div>
          <div className="flex items-center rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3 py-2">
            <code className="truncate font-mono text-[12px] text-[var(--ds-text)]">
              {showKey ? botKey : maskKey(botKey)}
            </code>
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
            Preview
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={demoUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="See your agent live (opens in a new tab)"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3.5 py-2 text-[13px] font-medium text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              <ExternalLink size={14} aria-hidden="true" />
              See your agent live
            </a>
            <button
              type="button"
              onClick={copyDemoLink}
              aria-label={demoCopied ? 'Demo link copied' : 'Copy demo link'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3.5 py-2 text-[13px] font-medium text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              {demoCopied ? (
                <Check size={14} className="text-[var(--ds-success)]" aria-hidden="true" />
              ) : (
                <Link2 size={14} aria-hidden="true" />
              )}
              {demoCopied ? 'Copied' : 'Copy demo link'}
            </button>
            <button
              type="button"
              onClick={copyAgentPrompt}
              disabled={entitlementsLoading}
              aria-label={
                entitlementsLoading
                  ? 'Copy prompt for AI agent (resolving your plan…)'
                  : promptCopied
                    ? 'Install prompt copied'
                    : platform
                      ? `Copy the ${platform.name} install prompt for a coding agent`
                      : 'Copy the install prompt for a coding agent'
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3.5 py-2 text-[13px] font-medium text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--ds-bg-surface)]"
            >
              {promptCopied ? (
                <Check size={14} className="text-[var(--ds-success)]" aria-hidden="true" />
              ) : (
                <Bot size={14} aria-hidden="true" />
              )}
              {promptCopied ? 'Copied' : 'Copy prompt for AI agent'}
            </button>
            <span role="status" aria-live="polite" className="sr-only">
              {demoCopied ? 'Demo link copied' : ''}
              {promptCopied ? 'Install prompt copied' : ''}
            </span>
          </div>
        </div>
      </div>

      {/* Platform-specific install steps */}
      <div>
        <span className="mb-3 block text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
          Install steps
        </span>

        {platform ? (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setPlatformId(null)}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              <ChevronLeft size={14} aria-hidden="true" />
              Change platform
            </button>

            {entitlementsLoading ? (
              <div className="space-y-4" aria-busy="true" aria-label="Resolving your plan">
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
              </div>
            ) : (
              <ol className="space-y-4">
                {platform.getSteps(botKey, env, { attribution }).map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[11px] font-semibold text-[var(--ds-accent-text)]">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-[var(--ds-text)]">{step.title}</p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
                        {step.description}
                      </p>
                      {step.code ? (
                        <CopyableCode code={step.code} label={`${platform.name} snippet`} />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {categoryOrder.map((category) => {
              const inCategory = platforms.filter((p) => p.category === category);
              if (inCategory.length === 0) return null;
              return (
                <div key={category}>
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
                    {categoryLabels[category] ?? category}
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {inCategory.map((p) => {
                      const Logo = platformLogos[p.id];
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setPlatformId(p.id)}
                          className={cn(
                            'flex items-center gap-2.5 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3.5 py-3 text-left transition-colors',
                            'hover:border-[var(--ds-accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                          )}
                        >
                          {Logo ? (
                            <span className="shrink-0">
                              <Logo size={26} aria-hidden="true" />
                            </span>
                          ) : null}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-semibold text-[var(--ds-text)]">
                              {p.name}
                            </span>
                            <span className="block truncate text-[11px] text-[var(--ds-text-subtle)]">
                              {p.description}
                            </span>
                          </span>
                          <ChevronRight
                            size={15}
                            className="shrink-0 text-[var(--ds-text-subtle)]"
                            aria-hidden="true"
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
