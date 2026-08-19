import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import {
  Card,
  CardBody,
  Page,
  PageHeader,
  Progress,
  buttonClass,
  cn,
} from '../ui';
import { useSetupChecklist } from './useSetupChecklist';

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
  const { steps, done, total, complete } = useSetupChecklist();

  return (
    <Page width="default">
      <PageHeader
        eyebrow="Setup"
        title={complete ? 'You are all set' : 'Get your chatbot working'}
        description={
          complete
            ? 'Everything is in place. This checklist will stop appearing in the sidebar.'
            : 'Six things, in any order. Each one opens the page where you actually do it.'
        }
      />

      <Card>
        <CardBody className="border-b border-border">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-base font-medium text-text-primary">
              <span className="figure">{done}</span> of <span className="figure">{total}</span> done
            </p>
          </div>
          <Progress
            className="mt-2"
            value={(done / total) * 100}
            label={`Setup progress, ${done} of ${total} complete`}
          />
        </CardBody>

        <ul>
          {steps.map((step, index) => (
            <li key={step.id} className={cn(index > 0 && 'border-t border-border')}>
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
                  <span
                    className={cn(
                      'block text-base font-medium',
                      step.done ? 'text-text-tertiary line-through' : 'text-text-primary',
                    )}
                  >
                    {step.label}
                  </span>
                  <span className="mt-0.5 block text-prose text-text-secondary">
                    {step.description}
                  </span>
                </span>

                <ArrowRight
                  aria-hidden
                  className="mt-1 h-4 w-4 shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
                />
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      {complete ? (
        <div className="mt-6 flex justify-center">
          <Link to="/" className={buttonClass('primary', 'md')}>
            Go to Home
          </Link>
        </div>
      ) : null}
    </Page>
  );
}
