import { useState } from 'react';
import {
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
  type PlatformEnv,
} from '../../../data/platformIntegrations';
import { getBotDemoUrl, trackDemoShareClick } from '../../../services/api';
import { cn } from '../../../design-system';

/** The two install targets: the live CDN widget vs. the local preview build. */
const ENV_OPTIONS: ReadonlyArray<{ value: PlatformEnv; label: string }> = [
  { value: 'production', label: 'Production' },
  { value: 'development', label: 'Development' },
];

/** A copyable code block. Clipboard write is best-effort; the code is always selectable. */
function CopyableCode({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. insecure context) — the code stays selectable.
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
  /** The agent's numeric id — used to attribute demo-link shares. */
  botId: number;
}

/**
 * WebsiteInstall — everything needed to put the agent live on a website: the
 * embed key (reveal + copy), a link to a hosted preview, and platform-specific
 * install steps. The platform config + snippets are reused wholesale from the
 * legacy `data/platformIntegrations` module (see `pages/my-bots/InstallDrawer.jsx`
 * for the original drawer); only the presentation is rebuilt on the design system.
 */
export function WebsiteInstall({ botKey, botId }: WebsiteInstallProps) {
  const [showKey, setShowKey] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [demoCopied, setDemoCopied] = useState(false);
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [env, setEnv] = useState<PlatformEnv>('production');

  const platform = platforms.find((p) => p.id === platformId) ?? null;
  const demoUrl = getBotDemoUrl(botKey);

  const copyKey = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(botKey);
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      // Clipboard blocked — the key is visible when revealed.
    }
  };

  const copyDemoLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(demoUrl);
      setDemoCopied(true);
      window.setTimeout(() => setDemoCopied(false), 2000);
    } catch {
      // Clipboard blocked — the demo link is still reachable via the button above.
    }
    // Attribution is best-effort: a failed track must not undo the copy.
    try {
      await trackDemoShareClick(botId);
    } catch {
      // Analytics failures are non-fatal.
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
            <span role="status" aria-live="polite" className="sr-only">
              {demoCopied ? 'Demo link copied' : ''}
            </span>
          </div>
          <p className="mt-1.5 text-[12px] text-[var(--ds-text-subtle)]">
            Opens a hosted page with your agent — no install needed to try it. Share the link so
            others can chat with it too.
          </p>
        </div>
      </div>

      {/* Platform-specific install steps */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
            Install steps
          </span>
          {/* Production loads the CDN widget; Development points snippets at the
              local preview build (see `platformIntegrations`). */}
          <div
            role="radiogroup"
            aria-label="Install environment"
            className="inline-flex rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-0.5"
          >
            {ENV_OPTIONS.map((option) => {
              const selected = env === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setEnv(option.value)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                    selected
                      ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                      : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {env === 'development' && (
          <p className="mb-3 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
            Development snippets point at your local widget preview
            (<code className="font-mono">localhost:4173</code>). Run{' '}
            <code className="font-mono">npm run build</code> then{' '}
            <code className="font-mono">npx vite preview --port 4173</code> in the widget project
            before embedding these.
          </p>
        )}

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

            <ol className="space-y-4">
              {platform.getSteps(botKey, env).map((step, index) => (
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
                    {inCategory.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPlatformId(p.id)}
                        className={cn(
                          'flex items-center justify-between gap-2 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3.5 py-3 text-left transition-colors',
                          'hover:border-[var(--ds-accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                        )}
                      >
                        <span className="min-w-0">
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
                    ))}
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
