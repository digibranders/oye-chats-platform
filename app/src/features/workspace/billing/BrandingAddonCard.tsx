import { EyeOff } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner } from '../../../ui';
import { useBrandingAddon } from './useBrandingAddon';
import { TaxNote } from './TaxNote';

export interface BrandingAddonCardProps {
  /** The chatbot whose subscription carries the add-on. `null` targets the account. */
  botId: number | null;
  /** The workspace is on a paid plan. The add-on rides on one. */
  hasPaidPlan: boolean;
  /** Bubbles a settled purchase or cancellation up to the page's notice region. */
  onSettled: (message: string) => void;
}

/**
 * Buy or cancel branding removal.
 *
 * It sits with the seat controls rather than among the plan cards because it is
 * the same kind of object: a recurring charge riding on the subscription, not a
 * tier you switch to. Branding removal is deliberately NOT a plan inclusion —
 * no seeded tier grants it, and `plan_entitlements_service` overwrites the flag
 * unconditionally — so a customer on any paid plan buys it here or not at all.
 *
 * **The card never claims the entitlement itself.** The hook waits for the
 * `subscription.activated` webhook and only then reports the badge gone.
 * Asserting it on the POST alone showed a customer an unlocked switch that the
 * next page load took away again.
 */
export function BrandingAddonCard({ botId, hasPaidPlan, onSettled }: BrandingAddonCardProps) {
  const {
    active,
    loading,
    busy,
    priceLabel,
    priceIncludesTax,
    error,
    notice,
    awaitingActivation,
    purchase,
    cancel,
  } = useBrandingAddon({ botId, onSettled });

  const working = busy || awaitingActivation;
  // No price yet means the charge currency is still resolving. Quoting one now
  // could name a currency the rail will not debit, so the card waits.
  const priceReady = priceLabel !== null;

  return (
    <Card>
      <CardHeader
        title="Remove OyeChats branding"
        titleAs="h2"
        description={
          active
            ? 'The “Powered by OyeChats” badge is hidden on your widget.'
            : 'Hides the “Powered by OyeChats” badge on your widget.'
        }
        actions={
          <>
            {active ? <Badge tone="success">Active</Badge> : null}
            {active ? (
              <Button variant="secondary" size="sm" loading={busy} disabled={working} onClick={() => void cancel()}>
                Cancel add-on
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                loading={working}
                disabled={working || loading || !priceReady || !hasPaidPlan}
                onClick={() => void purchase()}
                iconLeft={<EyeOff aria-hidden />}
              >
                {priceReady ? `Add for ${priceLabel}/mo` : 'Add branding removal'}
              </Button>
            )}
          </>
        }
      />
      <CardBody className="space-y-3">
        <p className="text-sm text-text-secondary">
          {hasPaidPlan
            ? 'A recurring charge on top of your plan, billed through Razorpay until you cancel. A secure checkout opens to authorise the mandate.'
            : 'The add-on rides on a paid subscription. Choose a plan first, then add it here.'}
        </p>

        {/* Only where the card actually quotes a BASE price. Without a paid
            plan, or before the charge currency resolves, no figure is shown and
            a tax note would qualify nothing. Once the server has quoted the
            gross, the figure above IS the amount payable and this note would
            contradict it. */}
        {hasPaidPlan && priceReady && !priceIncludesTax ? <TaxNote /> : null}

        {/* Announced, not merely rendered: a customer who has just paid should
            not be left watching a card that has not visibly changed. */}
        <div aria-live="polite">
          {awaitingActivation ? (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Spinner size="sm" label={null} />
              Switching branding removal on…
            </p>
          ) : notice ? (
            <p className="text-sm text-text-secondary">{notice}</p>
          ) : null}
        </div>

        {error ? (
          <Alert tone="danger" live>
            {error}
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}
