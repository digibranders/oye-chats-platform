import { type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Dialog } from './Dialog';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { Alert } from '../feedback/Alert';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

/**
 * The phases a purchase moves through, in order. The consumer owns the
 * transitions (it holds the money logic); this shell owns how each phase looks
 * and which of them the user is allowed to dismiss.
 *
 * - `confirm`     what they are about to buy, and the button that starts it.
 * - `processing`  the gateway sheet is open on top of this dialog, or the POST
 *                 that opens it is in flight. Nothing to do but wait.
 * - `activating`  paid, but the entitlement is not live yet. We wait for the
 *                 `subscription.activated` webhook rather than claim success on
 *                 the payment — the whole billing layer is built on that rule.
 * - `done`        the entitlement is live. The one moment we celebrate.
 * - `error`       a hard failure with a sentence and, optionally, a retry.
 */
export type PurchasePhase = 'confirm' | 'processing' | 'activating' | 'done' | 'error';

export interface PurchaseSuccessProps {
  /** What the customer just gained, in a sentence. */
  message: ReactNode;
  /**
   * A first-name greeting above the message ("Nice one, Priya."). Optional and
   * tasteful — pass it only where the moment earns it, never on a routine
   * repeat purchase.
   */
  greetingName?: string | null;
}

/**
 * The one way this app celebrates a purchase: a success disc, an optional
 * greeting, and a sentence naming what was gained.
 *
 * Extracted so `PurchaseDialog`'s `done` phase and the plan picker's settled
 * state are the same object rather than two hand-rolled success screens that
 * drift — the exact "six chart palettes, five drawers" failure the rebuild
 * exists to stop.
 */
export function PurchaseSuccess({ message, greetingName }: PurchaseSuccessProps) {
  return (
    <div className="space-y-3 text-center">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-md bg-success-tint">
        <CheckCircle2 aria-hidden className="h-icon-lg w-icon-lg text-success" />
      </span>
      {greetingName ? (
        <p className="text-prose text-text-secondary">
          {translateNow('ds.niceOneName', { name: greetingName }) || `Nice one, ${greetingName}.`}
        </p>
      ) : null}
      <div className="text-prose text-text-secondary">{message}</div>
    </div>
  );
}

export interface PurchaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which phase to render. The consumer advances this as the purchase settles. */
  phase: PurchasePhase;

  /** Header title for every phase except `done`, which uses `doneTitle`. */
  title: string;
  /**
   * What they are buying: the price, what it unlocks, and any tax note. Shown
   * only in `confirm`. A buy button with no priced summary above it is not a
   * purchase a customer can consent to.
   */
  summary: ReactNode;
  confirmLabel: string;
  /** Starts the purchase. The consumer flips `phase` to `processing` from here. */
  onConfirm: () => void;
  cancelLabel?: string;
  /**
   * A non-failure notice shown in the `confirm` phase — most often "you
   * dismissed the last checkout, you were not charged", so a customer who backs
   * out and looks again is told plainly that nothing happened.
   */
  notice?: ReactNode;

  /** Waiting copy. Honest about which half of the wait the customer is in. */
  processingMessage?: string;
  activatingMessage?: string;

  /** The celebration. `doneTitle` becomes the header; `doneMessage` the body. */
  doneTitle: string;
  doneMessage: ReactNode;
  /**
   * A first-name greeting above the congratulations ("Nice one, Priya."). Kept
   * optional and tasteful — a greeting on a routine repeat purchase wears out
   * fast, so callers pass it only where the moment earns it.
   */
  greetingName?: string | null;
  doneLabel?: string;

  /** Hard failure sentence for the `error` phase. */
  error?: string | null;
  /** When present, the `error` phase offers a retry that re-runs the purchase. */
  onRetry?: () => void;
}

/**
 * A four-state purchase flow in one dialog: confirm → (gateway) → activating →
 * done, with an honest error branch.
 *
 * It stays mounted across the whole flow, including while the Razorpay sheet is
 * open on top of it, so the customer never loses the thread — they confirm
 * here, pay on the gateway, and land back on the same surface that now
 * congratulates them. That continuity is the point: the old flows either opened
 * checkout with no confirmation (branding) or closed the moment payment landed
 * (top-up), so a paid customer was left looking at a card that had not visibly
 * changed.
 *
 * **It never celebrates a payment — only an activation.** `done` is reached when
 * the consumer's settle poll sees the entitlement or plan go live, not when the
 * charge succeeds. Showing "you're all set" on the payment alone is the exact
 * bug the billing hooks document: an unlocked state the next page load takes
 * away. The `activating` phase exists to hold that gap truthfully.
 *
 * Dismissibility follows the phase: a customer may back out of `confirm`, close
 * `done` or `error`, but not `processing` or `activating` — a dialog that closes
 * mid-charge cannot tell them whether their money moved.
 *
 * This is a shell, not a policy: it holds no price, currency, or gateway logic.
 * Each purchase (branding, plan, seats) supplies its own copy and drives the
 * phase from its own hook, so all of them read as one system without sharing a
 * single monster component.
 */
export function PurchaseDialog({
  open,
  onOpenChange,
  phase,
  title,
  summary,
  confirmLabel,
  onConfirm,
  cancelLabel: cancelLabelProp,
  notice,
  processingMessage: processingMessageProp,
  activatingMessage: activatingMessageProp,
  doneTitle,
  doneMessage,
  greetingName,
  doneLabel: doneLabelProp,
  error,
  onRetry,
}: PurchaseDialogProps) {
  const { t } = useTranslation();
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const cancelLabel = cancelLabelProp === undefined ? (t('ds.cancel') || 'Cancel') : cancelLabelProp;
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const processingMessage = processingMessageProp === undefined ? (t('ds.openingSecureCheckout') || 'Opening secure checkout…') : processingMessageProp;
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const activatingMessage = activatingMessageProp === undefined ? (t('ds.paymentReceivedFinishingUp') || 'Payment received. Finishing up…') : activatingMessageProp;
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const doneLabel = doneLabelProp === undefined ? (t('ds.done') || 'Done') : doneLabelProp;
  const waiting = phase === 'processing' || phase === 'activating';
  const close = () => onOpenChange(false);

  const footer =
    phase === 'confirm' ? (
      <>
        <Button variant="secondary" onClick={close}>
          {cancelLabel}
        </Button>
        <Button variant="primary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </>
    ) : phase === 'done' ? (
      <Button variant="primary" onClick={close}>
        {doneLabel}
      </Button>
    ) : phase === 'error' ? (
      <>
        <Button variant="secondary" onClick={close}>
          {t('ds.close') || 'Close'}
        </Button>
        {onRetry ? (
          <Button variant="primary" onClick={onRetry}>
            {t('ds.tryAgain') || 'Try again'}
          </Button>
        ) : null}
      </>
    ) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={phase === 'done' ? doneTitle : title}
      // Only the phases with nothing in flight can be dismissed. Base UI hides
      // the header close control when this is false, so the two waiting phases
      // have no exit at all — which is correct while money is moving.
      dismissible={!waiting}
      size="sm"
      footer={footer}
    >
      {/* One live region for the whole body: phase changes happen while the
          dialog is already open, so without this a screen-reader user hears the
          confirm copy and then silence through payment, activation and success. */}
      <div aria-live="polite">
        {phase === 'confirm' ? (
          <div className="space-y-4">
            {notice ? (
              <Alert tone="neutral" live>
                {notice}
              </Alert>
            ) : null}
            {summary}
          </div>
        ) : waiting ? (
          <div className="flex items-center gap-3 py-2 text-prose text-text-secondary">
            <Spinner size="sm" label={null} />
            <span>{phase === 'processing' ? processingMessage : activatingMessage}</span>
          </div>
        ) : phase === 'done' ? (
          <PurchaseSuccess message={doneMessage} greetingName={greetingName} />
        ) : (
          <Alert tone="danger" live>
            {error ?? (t('ds.somethingWentWrongPleaseTry') || 'Something went wrong. Please try again.')}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
