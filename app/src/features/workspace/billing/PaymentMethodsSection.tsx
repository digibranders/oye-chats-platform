import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, MoreHorizontal, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
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
  LockedState,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  buttonClass,
} from '../../../ui';
import { deletePaymentMethod, getPaymentMethods } from '../../../services/api';
import { keys } from '../../../query/keys';
import { errorStatus } from '../billingModel';

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
      const rows = (await getPaymentMethods({
        refresh: true,
      })) as unknown as SavedMethod[];
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
        description="Saved for one-off credit top-ups."
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <RefreshCw aria-hidden />
            {refresh.isPending ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      {/* Always rendered. When it was conditional, a workspace with no paid
          plan put a `CardSection`'s `border-t` immediately under the header's
          `border-b` — two 1px lines abutting as one 2px rule. */}
      <CardBody>
        <div className="flex items-start gap-2.5">
          <ShieldCheck aria-hidden className="mt-0.5 h-icon-md w-icon-md shrink-0 text-success" />
          <p className="text-prose text-text-secondary">
            {hasPaidPlan
              ? `Your subscription is billed through an authorised ${provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Razorpay'} mandate. It cannot be swapped in place — changing plan authorises a new one and retires the old.`
              : 'Your subscription mandate is authorised when you choose a plan, separately from anything saved here.'}
          </p>
        </div>
      </CardBody>

      <CardSection>
        {methods.isPending ? (
          <LoadingRows rows={2} />
        ) : errorStatus(methods.error) === 403 ? (
          // The fourth state. A 403 here is a seat that may not read the
          // workspace's money, not a service that failed.
          <LockedState
            size="panel"
            title="Payment methods are visible to owners and admins"
            description="Ask an owner if a saved card needs removing."
          />
        ) : methods.isError ? (
          <ErrorState
            size="panel"
            title="We could not check your saved methods"
            description="An empty list and a failed lookup are different things, so we are not claiming you have none."
            onRetry={() => void methods.refetch()}
          />
        ) : methods.data.length === 0 ? (
          <EmptyState
            size="panel"
            icon={CreditCard}
            title="Nothing saved yet"
            description="Save your card or UPI ID when you next buy credits."
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
                    <span className="block truncate text-xs text-text-tertiary">
                      {method.issuer}
                    </span>
                  ) : null}
                </span>
                {/* In the row menu, like every other row action in the
                    console, rather than a per-row destructive button. */}
                <MenuRoot>
                  <MenuTrigger
                    aria-label={`Actions for ${methodLabel(method)}`}
                    className={buttonClass('ghost', 'icon-sm')}
                  >
                    <MoreHorizontal aria-hidden />
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem
                      destructive
                      disabled={!method.token_id || remove.isPending}
                      icon={<Trash2 aria-hidden />}
                      onSelect={() => setPendingRemoval(method)}
                    >
                      Remove
                    </MenuItem>
                  </MenuContent>
                </MenuRoot>
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
            ? `${methodLabel(pendingRemoval)} is revoked at Razorpay. Your subscription's own mandate keeps billing normally, and you will need these details again for your next top-up.`
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
