import { ConfirmDialog } from '../../../ui';
import { cancelSubscription } from '../../../services/api';
import { cancellationConsequence, type PlanView, type SubscriptionView } from '../billingModel';

export interface CancelSubscriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: SubscriptionView;
  plan: PlanView | null;
  /** Purchased top-up credits still in the workspace. They survive cancellation. */
  topupCreditsRemaining: number;
  botId?: number | null;
  onCancelled: (message: string) => void;
}

/**
 * Cancelling a subscription, with the consequence stated rather than implied.
 *
 * "Are you sure? This cannot be undone" is not a consequence, and here it would
 * not even be true - cancelling is scheduled, reversible until the period ends,
 * and does not delete anything. What a customer actually needs to know is the
 * date access ends, that the plan credit grant stops on that date, that the
 * credits they PAID for separately are not touched, and that their chatbots and
 * transcripts survive. All four are stated, with the real date.
 */
export function CancelSubscriptionDialog({
  open,
  onOpenChange,
  subscription,
  plan,
  topupCreditsRemaining,
  botId = null,
  onCancelled,
}: CancelSubscriptionDialogProps) {
  const consequence = cancellationConsequence(subscription, plan?.name ?? null, topupCreditsRemaining);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={plan ? `Cancel ${plan.name}?` : 'Cancel your subscription?'}
      description={
        <span className="block space-y-2">
          {consequence.lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </span>
      }
      confirmLabel="Cancel subscription"
      cancelLabel="Keep my plan"
      destructive
      onConfirm={async () => {
        await cancelSubscription(null, botId);
        onCancelled(
          consequence.endsAt
            ? 'Your subscription will end at the close of the current period. You can restore it until then.'
            : 'Your subscription has been cancelled.',
        );
        onOpenChange(false);
      }}
    />
  );
}
