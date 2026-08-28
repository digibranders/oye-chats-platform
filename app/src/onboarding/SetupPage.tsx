import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import {
  Card,
  CardBody,
  Measure,
  Page,
  PageHeader,
  Progress,
  buttonClass,
  cn,
} from '../ui';
import { useSetupChecklist } from './useSetupChecklist';
import { useTranslation } from '../i18n/useTranslation';

/**
 * The setup checklist, in full.
 *
 * This is not a wizard. There is no next button, no forward gate and no step you
 * can be trapped on — every row is a link into the real surface where that work
 * is done, and the checklist reads its own state back from the server. The flow
 * it replaces was seven full-screen steps outside the shell whose final step
 * hard-blocked on a third-party ping with no way past, so users who could not
 * satisfy it never finished onboarding at all.
 *
 * Reached from the rail's progress ring, and it removes itself once complete.
 */
export function SetupPage() {
  const { t } = useTranslation();
  const { steps, done, total, complete } = useSetupChecklist();

  return (
    <Page>
      <Measure width="form">
        <PageHeader
          eyebrow="Setup"
          title={complete ? t('onboarding.youAreAllSet') || 'You are all set' : t('onboarding.getYourChatbotWorking') || 'Get your chatbot working'}
          description={complete ? t('onboarding.thisChecklistWillStopAppearing') || 'This checklist will stop appearing in the sidebar.' : undefined}
        />

        <Card>
          {/* One mechanism for the seam, not two. The `border-b` here and the
              `border-t` on the first row both drew the same hairline, so which one
              won depended on render order. The list's rows own it. */}
          <CardBody>
            <p className="text-base font-medium text-text-primary">
              <span className="figure">{done}</span> of <span className="figure">{total}</span> done
            </p>
            {/* `hideLabel`, which is what `Progress` documents for "a bar that
                is chrome inside a row a heading already names". Without it the
                card opened with the same fact three times in three type sizes:
                "4 of 6 done", then "Setup progress, 4 of 6 complete", then
                "67%". The heading is the statement; the bar is the picture of
                it; the `aria-label` still carries the sentence. */}
            <Progress
              className="mt-2"
              hideLabel
              value={(done / total) * 100}
              label={`Setup progress, ${done} of ${total} complete`}
            />
          </CardBody>

          <ul>
            {steps.map((step, index) => (
              <li key={step.id} className="border-t border-border first:border-t-0">
                <Link
                  to={step.to}
                  className={cn(
                    'group flex items-start gap-3.5 px-5 py-4 transition-colors',
                    'hover:bg-surface-hover',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                      step.done
                        ? 'border-success-fill bg-success-fill text-text-inverse'
                        : 'border-border-strong text-text-tertiary',
                    )}
                  >
                    {step.done ? (
                      <Check className="h-3 w-3" strokeWidth={3} />
                    ) : (
                      <span className="figure text-2xs">{index + 1}</span>
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    {/* No strikethrough. `line-through` plus tertiary text on a
                        live link reads as disabled; the filled green check is the
                        signal, and the row is still a way into the page. */}
                    <span
                      className={cn(
                        'block text-base font-medium',
                        step.done ? 'text-text-secondary' : 'text-text-primary',
                      )}
                    >
                      {step.label}
                    </span>
                    {step.description ? (
                      <span className="mt-0.5 block text-xs text-text-secondary">
                        {step.description}
                      </span>
                    ) : null}
                  </span>

                  {/* Never gate the *existence* of an affordance on hover: on
                      touch there is no hover, so the only mark saying "this row is
                      a link" never rendered at all. */}
                  <ArrowRight
                    aria-hidden
                    className="mt-1 h-icon-md w-icon-md shrink-0 text-text-tertiary opacity-40 transition-opacity group-hover:opacity-100"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {complete ? (
          <div className="mt-6 flex justify-center">
            <Link to="/" className={buttonClass('primary', 'md')}>
              {t('onboarding.goToHome') || 'Go to Home'}
            </Link>
          </div>
        ) : null}
      </Measure>
    </Page>
  );
}
