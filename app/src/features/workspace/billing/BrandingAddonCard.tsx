import { type ReactElement } from 'react';
import { AlertCircle, EyeOff, Loader2 } from 'lucide-react';
import { Button, Card, CardContent, StatusBadge } from '../../../design-system';
import { useBrandingAddon } from './useBrandingAddon';
import { TaxNote } from './TaxNote';

export interface BrandingAddonCardProps {
  /** Agent whose subscription carries the add-on. `null` targets the account. */
  botId: number | null;
  /** True while the workspace is on a paid plan. The add-on requires one. */
  hasPaidPlan: boolean;
  /** Bubbles a settled purchase or cancellation up to the page notice region. */
  onSettled: (message: string) => void;
}

/**
 * BrandingAddonCard - buy or cancel the branding-removal add-on.
 *
 * Sits beside {@link SeatManager} on Billing ▸ Overview because it is the same
 * kind of object: a recurring charge that rides on the subscription rather than
 * a plan tier you switch to. It states the price before the button, as the seat
 * controls do, and never claims the entitlement itself - the hook waits for the
 * activation webhook and only then says the badge is gone.
 */
export function BrandingAddonCard({
  botId,
  hasPaidPlan,
  onSettled,
}: BrandingAddonCardProps): ReactElement {
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
      <CardContent className="flex flex-col gap-4 py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-subtle)] text-[var(--ds-text-muted)]">
              <EyeOff size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[15px] font-semibold text-[var(--ds-text)]">
                Remove OyeChats branding
                {active && (
                  <StatusBadge tone="success">Active</StatusBadge>
                )}
              </p>
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {priceReady
                  ? `${priceLabel}/mo add-on${priceIncludesTax ? ', GST included' : ''}. `
                  : ''}
                {active
                  ? 'The “Powered by OyeChats” badge is hidden on your widget.'
                  : 'Hides the “Powered by OyeChats” badge on your widget.'}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
            {active ? (
              <Button variant="ghost" onClick={() => void cancel()} disabled={working}>
                {busy ? 'Working…' : 'Cancel add-on'}
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => void purchase()}
                disabled={working || loading || !priceReady || !hasPaidPlan}
                title={hasPaidPlan ? undefined : 'The add-on requires a paid plan.'}
              >
                {working ? 'Working…' : priceReady ? `Add for ${priceLabel}/mo` : 'Add branding removal'}
              </Button>
            )}
          </div>
        </div>

        <p className="text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
          {hasPaidPlan
            ? 'This is a recurring charge on top of your plan, billed via Razorpay until you cancel. A secure checkout opens to authorise the payment mandate.'
            : 'The add-on rides on a paid subscription. Choose a plan first, then add it here.'}
        </p>

        {/* Only where the card actually quotes a BASE price. Without a paid
            plan, or before the charge currency resolves, no figure is shown and
            a tax note would qualify nothing. Once the server has quoted the
            gross, the figure above is already the amount payable and this note
            would contradict it. */}
        {hasPaidPlan && priceReady && !priceIncludesTax && <TaxNote className="-mt-2" />}

        {/* Aria-live so the wait for the activation webhook is announced rather
            than leaving a customer who has just paid staring at a static card. */}
        <div aria-live="polite">
          {awaitingActivation && (
            <p className="flex items-center gap-2 text-[12px] text-[var(--ds-text-muted)]">
              <Loader2 size={13} aria-hidden="true" className="animate-spin text-[var(--ds-text-subtle)]" />
              Switching branding removal on…
            </p>
          )}
          {notice && !awaitingActivation && (
            <p className="text-[12px] text-[var(--ds-text-muted)]">{notice}</p>
          )}
        </div>

        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-[12px] text-[var(--ds-danger)]">
            <AlertCircle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
