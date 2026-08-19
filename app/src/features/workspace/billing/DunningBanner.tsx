import { Alert, Button, buttonClass } from '../../../ui';
import { dunningMessage, formatDate, type DunningView, type ReauthView } from '../billingModel';

/**
 * The banner a customer whose card has failed must see.
 *
 * `Subscription.status` has carried `past_due` since billing shipped and the
 * console had no dunning surface at all, so the first a customer knew about a
 * declined payment was their chatbot going quiet. Three things have to be on
 * screen: that the payment failed, what happens next and when, and one control
 * that fixes it.
 *
 * `recoverable` is tri-state and each state gets a different control.
 * `recoverable` gets the hosted Razorpay page. `settled` means the mandate is
 * terminal, so the only real remedy is choosing a plan again - offering
 * "retry payment" there sends the customer to a page that cannot work.
 * `unknown` means the gateway did not answer, which must render as neither a
 * dead button nor a claim that the subscription is gone.
 */
export function DunningBanner({
  dunning,
  onRecheck,
  onChoosePlan,
}: {
  dunning: DunningView;
  onRecheck: () => void;
  onChoosePlan: () => void;
}) {
  if (!dunning.pastDue) return null;

  const action =
    dunning.recovery === 'recoverable' && dunning.recoveryUrl ? (
      <a
        href={dunning.recoveryUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClass('primary', 'sm')}
      >
        Pay now
      </a>
    ) : dunning.recovery === 'settled' ? (
      <Button size="sm" onClick={onChoosePlan}>
        Choose a plan
      </Button>
    ) : (
      <Button size="sm" variant="secondary" onClick={onRecheck}>
        Check again
      </Button>
    );

  return (
    <Alert tone="danger" title="Your last payment did not go through" action={action} live>
      {dunningMessage(dunning)}
    </Alert>
  );
}

/**
 * The other `past_due`: a downgrade waiting on its new mandate.
 *
 * A paid→paid downgrade parks the customer on a short-lived `past_due` grace
 * row on the TARGET plan while they still owe a one-time authorisation of the
 * cheaper mandate. Nothing failed, and there is no mandate to build a recovery
 * link from, so rendering it as a declined payment would be false twice over.
 * The backend keeps the two apart in `payment_recovery`; so does this.
 */
export function ReauthBanner({ reauth, onAuthorise }: { reauth: ReauthView; onAuthorise: () => void }) {
  const deadline = reauth.graceUntil ? formatDate(reauth.graceUntil) : null;
  const plan = reauth.targetPlanName ?? 'your new plan';
  return (
    <Alert
      tone="warning"
      title="Finish switching to your new plan"
      action={
        <Button size="sm" onClick={onAuthorise}>
          Authorise payment
        </Button>
      }
    >
      {`Nothing failed and you have not been charged twice. ${plan} needs a one-time authorisation of its new, lower payment mandate before it can start billing. `}
      {deadline
        ? `Authorise it by ${deadline}${reauth.daysLeft != null ? ` (${reauth.daysLeft} day${reauth.daysLeft === 1 ? '' : 's'} left)` : ''} or the workspace drops to Free.`
        : 'Until you do, the workspace will drop to Free when the grace period ends.'}
    </Alert>
  );
}
