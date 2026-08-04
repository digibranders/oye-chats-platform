/**
 * ApiKeysPage - the Workspace ▸ API Keys surface. One job: answer
 * "How do I access the API?".
 *
 * It shows the workspace's single secret key (masked), lets the owner rotate it
 * with a deliberate two-step confirm, reveals the fresh key exactly once with
 * copy-to-clipboard, and explains - in plain language - how to authenticate a
 * server-to-server request with the `X-API-Key` header.
 *
 * The masked key is loaded through a small discriminated-union state machine so
 * loading / error / ready are explicit and `setState` never runs synchronously
 * inside the effect (it always follows an `await`). Rotation is destructive, so
 * it lives behind an inline confirmation rather than a one-click button.
 *
 * Colour usage follows the DS pattern (see InsightCard / BillingPage): the
 * saturated semantic hue stays on borders, tint backgrounds, and icons only -
 * body copy renders in --ds-text / --ds-text-muted so it clears WCAG AA (4.5:1),
 * which the mid-tone hues on their own soft tints do not.
 *
 * Backend reused (typed in services/api.d.ts): getClientApiKey,
 * regenerateClientApiKey. Business logic mirrored from the legacy
 * pages/settings/WorkspaceTab.jsx (loadKey / handleRegenerate / reveal-once).
 */
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import {
  Button,
  Card,
  FeedbackBanner,
  InsightCard,
  PageContainer,
  Skeleton,
  StatusBadge,
  useFeedback,
} from '../../design-system';
import { getClientApiKey, regenerateClientApiKey } from '../../services/api';

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Same resolution the runtime API client uses (services/api.js:5). Shown in the
 * usage example so the copied command targets the caller's environment.
 */
const API_BASE_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'https://api.oyechats.com';

/** A faithful, endpoint-agnostic example of authenticating a request. */
const CURL_EXAMPLE = `curl ${API_BASE_URL}/<endpoint> \\
  -H "X-API-Key: <your-api-key>"`;

/** Announced (screen-reader only) the instant a fresh key is revealed. */
const REVEAL_ANNOUNCEMENT =
  'Your API key was regenerated. Copy the new key now - it won’t be shown again.';

// ── State machine ────────────────────────────────────────────────────────────

type LoadPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly masked: string };

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

interface CopyFlag {
  /** True for `resetMs` after `mark()`; drives the button's "Copied" state. */
  readonly copied: boolean;
  /** Flag as copied and schedule an auto-reset (replacing any pending one). */
  readonly mark: () => void;
  /** Clear the pending timer and drop back to the idle state immediately. */
  readonly reset: () => void;
}

/**
 * Owns a short-lived "copied" flag and its auto-reset timer, clearing the timer
 * on unmount so a pending reset never fires on an unmounted component.
 */
function useCopyFlag(resetMs = 2000): CopyFlag {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const mark = useCallback((): void => {
    setCopied(true);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, resetMs);
  }, [clearTimer, resetMs]);

  const reset = useCallback((): void => {
    clearTimer();
    setCopied(false);
  }, [clearTimer]);

  return { copied, mark, reset };
}

// ── Small pieces ─────────────────────────────────────────────────────────────

interface CopyButtonProps {
  /** The text placed on the clipboard when pressed. */
  value: string;
  /** Accessible label describing what gets copied (idle state). */
  label: string;
  onCopied: () => void;
  onError: () => void;
  copied: boolean;
  variant?: 'primary' | 'outline';
}

function CopyButton({
  value,
  label,
  onCopied,
  onError,
  copied,
  variant = 'outline',
}: CopyButtonProps): ReactElement {
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      onCopied();
    } catch {
      onError();
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={() => {
        void handleCopy();
      }}
      // Swap the accessible name so AT users hear the state change, which the
      // static label would otherwise mask.
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function ApiKeysPage(): ReactElement {
  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);
  const { feedback, notify, dismiss } = useFeedback();

  // Rotation lifecycle.
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // The full key exists only in the moment after a rotation; once dismissed we
  // drop it from state and fall back to the mask - it is never shown again.
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const keyCopy = useCopyFlag();
  const curlCopy = useCopyFlag();

  // setState always follows an await here, so `loading` is a genuine derived
  // phase rather than a synchronous effect write.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await getClientApiKey();
        if (!active) return;
        setPhase({ status: 'ready', masked: data.api_key_masked });
      } catch (error) {
        if (!active) return;
        setPhase({
          status: 'error',
          message: toMessage(error, 'We couldn’t load your API key. Please try again.'),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshToken]);

  const retry = (): void => {
    setPhase({ status: 'loading' });
    setRefreshToken((token) => token + 1);
  };

  const handleRegenerate = async (): Promise<void> => {
    setRegenerating(true);
    dismiss();
    try {
      const data = await regenerateClientApiKey();
      setPhase({ status: 'ready', masked: data.api_key_masked });
      setRevealedKey(data.api_key);
      keyCopy.reset();
      setConfirming(false);
      // Success is communicated by the one-time reveal box (visually) and the
      // persistent status region (for AT); no redundant banner is shown.
    } catch (error) {
      notify({ tone: 'error', message: toMessage(error, 'Failed to regenerate the API key.') });
    } finally {
      setRegenerating(false);
    }
  };

  const dismissReveal = (): void => {
    setRevealedKey(null);
    keyCopy.reset();
  };

  return (
    <PageContainer
      title="API Keys"
      description="Your secret key for programmatic, server-to-server access to OyeChats."
      className="max-w-3xl"
    >
      {/* Screen-reader announcement for a fresh key. Permanently mounted (never
          conditionally rendered) so the live region is in the a11y tree before
          its text is swapped in - several screen readers skip regions that were
          absent/display:none at mutation time. */}
      <p className="sr-only" role="status" aria-live="polite">
        {revealedKey ? REVEAL_ANNOUNCEMENT : ''}
      </p>

      {/* Rotation / copy failures. Errors never auto-dismiss - they stay until
          the user dismisses them or the next attempt replaces them. */}
      <FeedbackBanner feedback={feedback} onDismiss={dismiss} />

      {/* ── Secret key ──────────────────────────────────────────────────────── */}
      <Card className="p-6">
        <div className="mb-5 flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
            <KeyRound size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--ds-text)]">Secret key</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
              One key authenticates your workspace. Keep it private - anyone with it can act on your
              behalf.
            </p>
          </div>
        </div>

        {phase.status === 'loading' && (
          <div className="space-y-3">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-9 w-40" />
          </div>
        )}

        {phase.status === 'error' && (
          <div className="rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-4 py-3">
            <p className="text-[13px] text-[var(--ds-text)]">{phase.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={retry}
              className="mt-3"
            >
              <RefreshCw size={14} aria-hidden="true" />
              Try again
            </Button>
          </div>
        )}

        {phase.status === 'ready' && (
          <div className="space-y-4">
            {/* One-time reveal of a freshly-rotated key. */}
            {revealedKey ? (
              <div className="rounded-lg border border-[var(--ds-success)] bg-[var(--ds-success-soft)] p-4">
                <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ds-text)]">
                  <Check size={13} aria-hidden="true" className="text-[var(--ds-success)]" />
                  Your new API key (shown once)
                </p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2 font-mono text-[13px] text-[var(--ds-text)]">
                    {revealedKey}
                  </code>
                  <CopyButton
                    value={revealedKey}
                    label="Copy new API key"
                    copied={keyCopy.copied}
                    variant="primary"
                    onCopied={keyCopy.mark}
                    onError={() => notify({ tone: 'error', message: 'Could not copy to clipboard.' })}
                  />
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
                  Store it somewhere safe. For security, we can’t show the full key again.
                </p>
                <button
                  type="button"
                  onClick={dismissReveal}
                  className="mt-3 text-[12px] font-semibold text-[var(--ds-text)] underline-offset-2 hover:underline"
                >
                  I’ve saved it
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <code className="min-w-0 flex-1 truncate rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3 py-2 font-mono text-[13px] text-[var(--ds-text-muted)]">
                  {phase.masked || '-'}
                </code>
                <StatusBadge tone="neutral">Active</StatusBadge>
              </div>
            )}

            {/* Rotation, behind a deliberate confirm. */}
            {confirming ? (
              <div className="rounded-lg border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] p-4">
                <p className="flex items-start gap-2 text-[13px] text-[var(--ds-text)]">
                  <AlertTriangle
                    size={15}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-[var(--ds-warning)]"
                  />
                  <span>
                    <strong className="font-semibold">Regenerate this key?</strong> The current key
                    stops working immediately, and every integration using it must be updated with
                    the new key.
                  </span>
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={regenerating}
                    onClick={() => {
                      void handleRegenerate();
                    }}
                  >
                    {regenerating ? (
                      <Loader2 size={14} aria-hidden="true" className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} aria-hidden="true" />
                    )}
                    Yes, regenerate
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={regenerating}
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setConfirming(true);
                  dismiss();
                }}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Regenerate key
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* ── How to use it ───────────────────────────────────────────────────── */}
      <Card className="p-6">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]">
            <Terminal size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--ds-text)]">How to use your key</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
              Send it as the{' '}
              <code className="rounded bg-[var(--ds-bg-sunken)] px-1 py-0.5 font-mono text-[12px] text-[var(--ds-text)]">
                X-API-Key
              </code>{' '}
              header on every request from your server.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-border)] px-4 py-2">
            <span className="text-[12px] font-medium text-[var(--ds-text-subtle)]">Example request</span>
            <CopyButton
              value={CURL_EXAMPLE}
              label="Copy example request"
              copied={curlCopy.copied}
              onCopied={curlCopy.mark}
              onError={() => notify({ tone: 'error', message: 'Could not copy to clipboard.' })}
            />
          </div>
          <pre className="px-4 py-3">
            <code className="whitespace-pre font-mono text-[13px] leading-relaxed text-[var(--ds-text)]">
              {CURL_EXAMPLE}
            </code>
          </pre>
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
          Replace <code className="font-mono">&lt;your-api-key&gt;</code> with the key above and{' '}
          <code className="font-mono">&lt;endpoint&gt;</code> with the resource you’re calling. Never
          embed this key in browser or mobile app code - it belongs on your server only.
        </p>
      </Card>

      {/* ── Safety reminder ─────────────────────────────────────────────────── */}
      <InsightCard
        tone="warning"
        icon={ShieldCheck}
        title="Treat your key like a password"
        body="If it’s ever exposed in a commit, a log, or a screenshot, regenerate it right away. Rotating instantly disables the old key so a leaked one can’t be used."
      />
    </PageContainer>
  );
}
