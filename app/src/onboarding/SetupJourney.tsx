import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, X } from 'lucide-react';
import { Button, buttonClass, cn } from '../ui';
import { useSetupChecklist } from './useSetupChecklist';
import { useTranslation } from '../i18n/useTranslation';

/** Per workspace, so dismissing it on one does not dismiss it on another. */
function dismissKeyFor(workspaceId: string | number | null): string {
  return `oyechats_journey_dismissed_${workspaceId ?? 'default'}`;
}

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    // Private mode. Not dismissed, which is the safe direction: showing a strip
    // that was dismissed is a smaller failure than hiding the only thing
    // telling a new customer what to do next.
    return false;
  }
}

export interface SetupJourneyProps {
  /** Scopes the dismissal. Null falls back to a shared key. */
  workspaceId?: string | number | null;
}

/**
 * Where the customer is in setting up, on the pages where they are doing it.
 *
 * **This is not a wizard and it is deliberately not a screen.** The flow this
 * console replaced was seven full-screen steps outside the shell, each a
 * degraded copy of a page that already existed, ending on a step that
 * hard-blocked on a third-party ping with no way past. Nothing here gates
 * anything: every step is a link into the real surface, the customer can do
 * them in any order or ignore them entirely, and the strip removes itself the
 * moment the work is genuinely done.
 *
 * What it fixes is the seam rather than the pages. The first run ends by
 * dropping someone onto their chatbot's Knowledge page with a crawl running and
 * no indication that anything follows it. The checklist that knows the answer
 * already existed, but only in the rail's progress ring, on Home, and on
 * `/setup` — three places the customer is not, at the moment they need it. So
 * this renders the same `useSetupChecklist` state above the page they are
 * actually on.
 *
 * The state is derived from the server, never from a stored flag, so it cannot
 * claim a step is done on one browser and not another. The only thing kept
 * locally is the dismissal, which is a preference rather than progress.
 */
export function SetupJourney({ workspaceId = null }: SetupJourneyProps) {
  const { t } = useTranslation();
  const { steps, done, total, complete, loading } = useSetupChecklist();
  const key = dismissKeyFor(workspaceId);
  const [dismissed, setDismissed] = useState(() => readDismissed(key));

  // Nothing while it is still resolving: a strip that appears a beat late and
  // shifts the page under a reader is worse than one that never appeared.
  if (loading || complete || dismissed) return null;

  const next = steps.find((step) => !step.done);
  if (!next) return null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface-sunken px-cell py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* The ordered path, so "what comes after this" is answerable at a
            glance. Each dot is a link, because a step you can see and cannot
            reach is a worse version of not showing it. */}
        <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          {steps.map((step) => {
            const current = step.id === next.id;
            return (
              <li key={step.id} className="flex items-center gap-1.5">
                <Link
                  to={step.to}
                  aria-current={current ? 'step' : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs transition-colors',
                    current
                      ? 'bg-accent-tint font-medium text-accent-700'
                      : step.done
                        ? 'text-text-tertiary hover:text-text-secondary'
                        : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  {step.done ? (
                    <Check aria-hidden className="h-3 w-3 shrink-0" />
                  ) : (
                    <span
                      aria-hidden
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        current ? 'bg-accent-600' : 'bg-border-strong',
                      )}
                    />
                  )}
                  <span className={cn('truncate', step.done && 'line-through')}>{step.label}</span>
                  {/* Leading space on purpose: without it the accessible name
                      concatenates to "Make it yours(done)" and is read as one
                      word. */}
                  <span className="sr-only">
                    {step.done
                      ? ` ${t('onboarding.stepDone') || '(done)'}`
                      : current
                        ? ` ${t('onboarding.stepCurrent') || '(next step)'}`
                        : ''}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>

        <div className="flex shrink-0 items-center gap-2">
          <span className="figure text-xs text-text-tertiary">
            {done}/{total}
          </span>
          {/* The next action, spelled out. The strip's whole job.

              Named "Next: …" rather than repeating the bare label, which the
              path above already carries: two links with identical accessible
              names is the same destination announced twice to a screen reader,
              with nothing to tell them apart. */}
          <Link
            to={next.to}
            className={buttonClass('secondary', 'sm')}
            aria-label={`${t('onboarding.nextStep') || 'Next'}: ${next.label}`}
          >
            <span aria-hidden>
              {t('onboarding.nextStep') || 'Next'}: {next.label}
            </span>
            <ArrowRight aria-hidden />
          </Link>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('onboarding.hideSetupJourney') || 'Hide setup steps'}
            onClick={() => {
              setDismissed(true);
              try {
                window.localStorage.setItem(key, 'true');
              } catch {
                /* private mode: it stays dismissed for this session */
              }
            }}
          >
            <X aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
