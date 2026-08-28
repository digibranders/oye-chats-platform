import { useCallback, useEffect, useRef, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, PurchaseDialog } from '../../../ui';
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
 * **The buy path runs through a `PurchaseDialog`, not straight to checkout.**
 * The button used to open the Razorpay sheet on the first click, with no
 * statement of what was about to be charged and no moment of arrival once it
 * was. Now the customer confirms the recurring charge first, pays on the
 * gateway that opens over the dialog, and lands back on the same dialog as it
 * congratulates them — the card behind it flips to Active at the same time.
 *
 * **The card never claims the entitlement itself.** The hook waits for the
 * `subscription.activated` webhook and only then reports the badge gone, so the
 * dialog's `activating` phase holds the gap between payment and activation
 * honestly rather than showing an unlocked state the next page load takes away.
 */
export function BrandingAddonCard({ botId, hasPaidPlan, onSettled }: BrandingAddonCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Read the latest open state from inside the settle callback without making
  // that callback churn on every toggle.
  const dialogOpenRef = useRef(dialogOpen);
  useEffect(() => {
    dialogOpenRef.current = dialogOpen;
  }, [dialogOpen]);

  const handleSettled = useCallback(
    (message: string) => {
      // A purchase settles inside the dialog, which shows its own
      // congratulations; a page toast on top would announce the same thing
      // twice, one of them under the modal scrim. A cancellation has no dialog,
      // so it still bubbles up to the page.
      if (dialogOpenRef.current) return;
      onSettled(message);
    },
    [onSettled],
  );

  const {
    active,
    loading,
    busy,
    priceLabel,
    priceIncludesTax,
    error,
    notice,
    awaitingActivation,
    phase,
    purchase,
    cancel,
    reset,
  } = useBrandingAddon({ botId, onSettled: handleSettled });
  const working = busy || awaitingActivation;
  // No price yet means the charge currency is still resolving. Quoting one now
  // could name a currency the rail will not debit, so the card waits.
  const priceReady = priceLabel !== null;

  function openPurchase() {
    // Clear any prior notice/error and reset the flow to `confirm` before the
    // dialog mounts, so a reopen never flashes a stale success or failure.
    reset();
    setDialogOpen(true);
  }

  function handleDialogOpenChange(next: boolean) {
    // Belt-and-braces: `PurchaseDialog` already hides its close control during
    // the waiting phases, but the header X and Escape route through here too,
    // and money must never be left mid-flight behind a closed dialog.
    if (!next && (phase === 'processing' || phase === 'activating')) return;
    setDialogOpen(next);
  }

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
                loading={loading}
                disabled={loading || !priceReady || !hasPaidPlan}
                onClick={openPurchase}
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
            ? 'A recurring charge on top of your plan, billed through Razorpay until you cancel.'
            : 'The add-on rides on a paid subscription. Choose a plan first, then add it here.'}
        </p>

        {/* The purchase's own notice and error live inside the dialog while it is
            open; here the card only carries what the dialog cannot — the result
            of a cancellation, and a settled message once the dialog has closed. */}
        <div aria-live="polite">
          {!dialogOpen && notice ? <p className="text-sm text-text-secondary">{notice}</p> : null}
        </div>

        {!dialogOpen && error ? (
          <Alert tone="danger" live>
            {error}
          </Alert>
        ) : null}
      </CardBody>

      <PurchaseDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        phase={phase}
        title="Remove OyeChats branding"
        summary={
          <div className="space-y-2 text-prose text-text-secondary">
            <p>
              Hides the “Powered by OyeChats” badge on your widget. A recurring charge on your
              subscription, billed through Razorpay until you cancel. A secure checkout opens to
              authorise the mandate.
            </p>
            {priceReady ? (
              <p className="text-base font-semibold text-text-primary">{priceLabel}/mo</p>
            ) : null}
            {/* Only where a BASE price is shown. Once the server has quoted the
                gross, the figure IS the amount payable and this note would
                contradict it. */}
            {priceReady && !priceIncludesTax ? <TaxNote /> : null}
          </div>
        }
        confirmLabel="Continue to secure checkout"
        onConfirm={() => void purchase()}
        notice={notice ?? undefined}
        activatingMessage="Payment received. Switching branding removal on…"
        doneTitle="Branding removed"
        doneMessage={notice ?? 'The “Powered by OyeChats” badge is gone from your widget.'}
        error={error}
        onRetry={() => void purchase()}
      />
    </Card>
  );
}
