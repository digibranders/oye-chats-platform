import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Bot as BotIcon, Loader2, AlertCircle } from 'lucide-react';
import { createBot } from '../../services/api';
import { type Bot } from '../../types/domain';
import { Button, Input } from '../../design-system';
import { requiresSubscription } from '../../utils/apiErrors';

export interface CreateAgentDialogProps {
  /** Whether the modal is mounted/visible. */
  open: boolean;
  /** Dismiss without creating (backdrop, Cancel, or Esc). */
  onClose: () => void;
  /** Called with the freshly created agent so the parent can refresh + navigate. */
  onCreated: (bot: Bot) => void;
  /**
   * Called instead of showing an inline error when `createBot` returns 402
   * `must_subscribe` — the dialog closes itself; the parent is responsible
   * for opening the upgrade modal (kept out of this dialog so both the
   * pre-emptive limit check and this reactive 402 path share one call site).
   */
  onRequiresUpgrade: () => void;
}

/** Prefix a bare host with https:// so createBot always receives a real URL. */
function normalizeWebsite(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function messageFromError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong. Please try again.';
}

/**
 * CreateAgentDialog — the focused "new agent" modal for the AI Agents page.
 *
 * ONE job: name the agent (and optionally point it at a website), then create
 * it. Reuses the legacy `createBot` API. The first agent on an account is free;
 * additional agents require a plan, so a 402 `must_subscribe` response closes
 * this dialog and routes to `onRequiresUpgrade` (the shared upgrade modal)
 * instead of surfacing a raw error. The full paid-agent checkout (Razorpay)
 * lives in the legacy CreateBotWizard and is intentionally out of scope here.
 */
export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
  onRequiresUpgrade,
}: CreateAgentDialogProps): ReactElement | null {
  const titleId = useId();
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const panelRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Keep the latest onClose reachable from the focus effect WITHOUT depending on
  // it: AgentsPage passes a fresh inline arrow every render, so depending on it
  // would tear the trap down and yank focus back to the trigger mid-typing on
  // any parent re-render (e.g. BotContext refreshing).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Clear transient form state whenever the dialog (re)opens, so no dismiss path
  // (Esc, backdrop, Cancel) can leak a previously-typed name or a stale
  // error/plan banner on reopen. Render-time adjustment — not a setState-in-effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName('');
      setWebsite('');
      setError('');
      setSubmitting(false);
    }
  }

  // Focus management + Esc-to-close + Tab focus-trap + body scroll-lock while
  // open. Focus the name field on open; restore focus to the trigger on close.
  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => nameInputRef.current?.focus(), 40);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
      returnFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !submitting;

  const resetAndClose = (): void => {
    setName('');
    setWebsite('');
    setError('');
    onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!trimmedName || submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const normalizedWebsite = normalizeWebsite(website);
      const bot = await createBot({
        name: trimmedName,
        website: normalizedWebsite || undefined,
      });
      onCreated(bot);
    } catch (err) {
      if (requiresSubscription(err)) {
        // Paywalled: close this dialog and hand off to the shared upgrade
        // modal instead of showing a raw/inline error.
        onClose();
        onRequiresUpgrade();
      } else {
        setError(messageFromError(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) resetAndClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]"
      >
        <div className="p-6">
          <div className="mb-5 flex items-center gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]"
              aria-hidden="true"
            >
              <BotIcon size={20} />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-[var(--ds-text)]">
                Create a new agent
              </h2>
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                Give it a name — you can train and customize it next.
              </p>
            </div>
          </div>

          {error && (
            <div
              className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] p-3 text-[13px] text-[var(--ds-danger)]"
              role="alert"
            >
              <AlertCircle size={15} className="mt-px shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="create-agent-name"
                className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]"
              >
                Agent name
              </label>
              <Input
                id="create-agent-name"
                ref={nameInputRef}
                value={name}
                required
                maxLength={50}
                placeholder="e.g. Support Assistant"
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div>
              <label
                htmlFor="create-agent-website"
                className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]"
              >
                Website{' '}
                <span className="font-normal text-[var(--ds-text-subtle)]">(optional)</span>
              </label>
              <Input
                id="create-agent-website"
                value={website}
                inputMode="url"
                placeholder="yourwebsite.com"
                onChange={(event) => setWebsite(event.target.value)}
              />
              <p className="mt-1.5 text-[12px] text-[var(--ds-text-subtle)]">
                We&rsquo;ll use this to help train your agent later.
              </p>
            </div>

            <div className="flex gap-3 pt-1">
              <Button type="button" variant="outline" className="flex-1" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button type="submit" className="flex-1" disabled={!canSubmit}>
                {submitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                    Creating&hellip;
                  </>
                ) : (
                  'Create agent'
                )}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
