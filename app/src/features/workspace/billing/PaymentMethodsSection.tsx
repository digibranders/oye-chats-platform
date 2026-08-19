import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingRows,
} from '../../../ui';
import { deletePaymentMethod, getPaymentMethods } from '../../../services/api';
import { keys } from '../../../query/keys';

interface SavedMethod {
  id: number;
  token_id: string | null;
  type: string;
  last4: string | null;
  network: string | null;
  issuer: string | null;
  upi_handle: string | null;
}

function methodLabel(method: SavedMethod): string {
  if (method.type === 'upi' && method.upi_handle) return method.upi_handle;
  const network = method.network ?? 'Card';
  return method.last4 ? `${network} ···· ${method.last4}` : network;
}

/**
 * What the workspace pays WITH - two genuinely different objects, kept apart.
 *
 * The subscription mandate cannot be swapped in place: Razorpay has no "change
 * the card on this subscription" call, so replacing it means authorising a
 * fresh mandate, which is what a plan change or a reactivation already does.
 * Listing it beside a Remove button would promise something the gateway cannot
 * do. Saved instruments are real tokens used for one-off top-ups, and those can
 * be listed and revoked.
 *
 * Only RBI-permitted metadata is ever shown: last four digits, network, issuer.
 * Expiry is not stored anywhere, by design.
 */
export function PaymentMethodsSection({
  provider,
  hasPaidPlan,
}: {
  provider: string | null;
  hasPaidPlan: boolean;
}) {
  const client = useQueryClient();
  const [pendingRemoval, setPendingRemoval] = useState<SavedMethod | null>(null);

  const methods = useQuery({
    queryKey: keys.billing.paymentMethods(),
    queryFn: async () => {
      const rows = (await getPaymentMethods()) as unknown as SavedMethod[];
      return Array.isArray(rows) ? rows : [];
    },
  });

  const refresh = useMutation({
    mutationFn: async () => {
      const rows = (await getPaymentMethods({ refresh: true })) as unknown as SavedMethod[];
      return Array.isArray(rows) ? rows : [];
    },
    onSuccess: (rows) => client.setQueryData(keys.billing.paymentMethods(), rows),
  });

  const remove = useMutation({
    mutationFn: (tokenId: string) => deletePaymentMethod(tokenId),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.billing.paymentMethods() }),
  });

  return (
    <Card>
      <CardHeader
        eyebrow="Payment"
        title="Payment methods"
        titleAs="h2"
        description="Instruments saved for one-off credit top-ups. Your plan's own payment mandate is separate and is authorised whenever you change plan."
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            {refresh.isPending ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      {hasPaidPlan ? (
        <CardBody>
          <div className="flex items-start gap-2.5">
            <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <p className="text-prose text-text-secondary">
              Your subscription is billed through an authorised{' '}
              {provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Razorpay'} mandate.
              It cannot be swapped in place - changing plan authorises a new one and retires the old.
            </p>
          </div>
        </CardBody>
      ) : null}

      <CardSection>
        {methods.isPending ? (
          <LoadingRows rows={2} />
        ) : methods.isError ? (
          <ErrorState
            compact
            title="We could not check your saved methods"
            description="An empty list and a failed lookup are different things, so we are not claiming you have none."
            onRetry={() => void methods.refetch()}
          />
        ) : methods.data.length === 0 ? (
          <EmptyState
            compact
            icon={CreditCard}
            title="Nothing saved yet"
            description="Choose to save your card or UPI ID when you next buy credits, and repeat top-ups will need only a CVV."
          />
        ) : (
          <ul className="divide-y divide-border">
            {methods.data.map((method) => (
              <li key={method.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <CreditCard aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1">
                  <span className="figure block truncate text-sm text-text-primary">
                    {methodLabel(method)}
                  </span>
                  {method.issuer ? (
                    <span className="block truncate text-xs text-text-tertiary">{method.issuer}</span>
                  ) : null}
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!method.token_id || remove.isPending}
                  onClick={() => setPendingRemoval(method)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        {remove.isError ? (
          <Alert tone="danger" live className="mt-3">
            {remove.error instanceof Error
              ? remove.error.message
              : 'We could not remove that payment method.'}
          </Alert>
        ) : null}
      </CardSection>

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemoval(null);
        }}
        title="Remove this payment method?"
        description={
          pendingRemoval
            ? `${methodLabel(pendingRemoval)} will be revoked at Razorpay and removed from this workspace. Your subscription's own mandate is a separate authorisation and keeps billing normally. You will need to enter the details again for your next top-up.`
            : ''
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!pendingRemoval?.token_id) return;
          await remove.mutateAsync(pendingRemoval.token_id);
          setPendingRemoval(null);
        }}
      />
    </Card>
  );
}
