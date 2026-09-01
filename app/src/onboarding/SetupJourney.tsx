import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
  const { pathname } = useLocation();
  const key = dismissKeyFor(workspaceId);
  const [dismissed, setDismissed] = useState(() => readDismissed(key));

  // Nothing while it is still resolving: a strip that appears a beat late and
  // shifts the page under a reader is worse than one that never appeared.
  if (loading || complete || dismissed) return null;

  const next = steps.find((step) => !step.done);
  if (!next) return null;

  /**
   * WHERE YOU ARE, which is not the same question as WHAT IS NEXT.
   *
   * The strip used to answer only the second and paint it "current", so
   * standing on Deploy you saw "Customise your chatbot" highlighted and nothing
   * at all marking "Put it on your website" -- the step you were literally
   * looking at. A progress bar that cannot say which of its steps you are on is
   * a list of links.
   *
   * `startsWith` rather than equality: a step points at a section root
   * (`/chatbots/7/deploy`) and the page may add to it. Longest match wins so
   * `/leads` cannot claim a path that a more specific step owns.
   */
  const here =
    [...steps]
      .filter((step) => pathname === step.to || pathname.startsWith(`${step.to}/`))
      .sort((a, b) => b.to.length - a.to.length)[0] ?? null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface-sunken px-cell py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* The ordered path, so "what comes after this" is answerable at a
            glance. Each dot is a link, because a step you can see and cannot
            reach is a worse version of not showing it. */}
        <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          {steps.map((step) => {
            // Two independent states. `onThisPage` is where the reader is;
            // `isNext` is the one action the strip is nudging toward. They
            // coincide often enough that conflating them looked right, and
            // diverge exactly when the customer has wandered off the happy
            // path -- which is when a "you are here" is worth most.
            const onThisPage = here?.id === step.id;
            const isNext = step.id === next.id;
            return (
              <li key={step.id} className="flex items-center gap-1.5">
                <Link
                  to={step.to}
                  // `step` marks the one being performed, so it follows the
                  // page. With no step matching the route it falls back to the
                  // next action, which is still the truest answer available.
                  aria-current={(here ? onThisPage : isNext) ? 'step' : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs transition-colors',
                    // The page you are on is stated with a ring, which reads
                    // as position. The next action keeps the filled tint, which
                    // reads as emphasis. Both at once when they coincide.
                    onThisPage && 'ring-1 ring-inset ring-accent-600',
                    isNext
                      ? 'bg-accent-tint font-medium text-accent-700'
                      : onThisPage
                        ? 'font-medium text-text-primary'
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
                        isNext || onThisPage ? 'bg-accent-600' : 'bg-border-strong',
                      )}
                    />
                  )}
                  <span className={cn('truncate', step.done && 'line-through')}>{step.label}</span>
                  {/* Leading space on purpose: without it the accessible name
                      concatenates to "Customise your chatbot(done)" and is read
                      as one word. */}
                  <span className="sr-only">
                    {/* Both facts, because a screen reader gets no ring and no
                        tint. Order matches the visual weight. */}
                    {onThisPage ? ` ${t('onboarding.stepHere') || '(you are here)'}` : ''}
                    {step.done
                      ? ` ${t('onboarding.stepDone') || '(done)'}`
                      : isNext
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
