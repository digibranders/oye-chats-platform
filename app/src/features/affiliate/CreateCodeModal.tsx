/**
 * CreateCodeModal — create a new referral code for the current affiliate.
 *
 * Rebuilt from the legacy `components/affiliate/CreateCodeModal.jsx` in the new
 * design language. The affiliate picks a memorable code, an optional internal
 * label, and how their commission pool splits between their own cut and the
 * friend's discount. Both the code format and the split are validated live —
 * mirroring the backend rules — so submission only fires on a valid form.
 *
 * Backend reused verbatim (typed in services/api.d.ts): createAffiliateCode.
 */
import { type FormEvent, type ReactElement, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button, Input, Modal } from '../../design-system';
import { createAffiliateCode } from '../../services/api';
import { formatPct, validateCodeFormat, validateSplit } from './affiliateModel';

export interface CreateCodeModalProps {
  open: boolean;
  onClose: () => void;
  /** The affiliate's total commission pool (whole percent) the split must fit. */
  poolPct: number;
  /** Fired after a code is created successfully. */
  onCreated: () => void;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Coerce a percent text field to a non-negative number (blank → 0). */
function pctValue(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function CreateCodeModal({ open, onClose, poolPct, onCreated }: CreateCodeModalProps): ReactElement | null {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [affiliatePct, setAffiliatePct] = useState(String(poolPct));
  const [customerPct, setCustomerPct] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aff = pctValue(affiliatePct);
  const cust = pctValue(customerPct);
  const splitError = useMemo(() => validateSplit(aff, cust, poolPct), [aff, cust, poolPct]);
  const remaining = Math.max(0, poolPct - aff - cust);

  // Reset the form each time the modal is (re)opened.
  const [seenOpen, setSeenOpen] = useState(false);
  if (open && !seenOpen) {
    setSeenOpen(true);
    setCode('');
    setLabel('');
    setAffiliatePct(String(poolPct));
    setCustomerPct('0');
    setError(null);
  } else if (!open && seenOpen) {
    setSeenOpen(false);
  }

  if (!open) return null;

  const codeError = code.trim() ? validateCodeFormat(code) : null;
  const canSubmit = !submitting && code.trim().length > 0 && !codeError && !splitError;

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const formatErr = validateCodeFormat(code);
    if (formatErr) {
      setError(formatErr);
      return;
    }
    if (splitError) {
      setError(splitError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createAffiliateCode(code.trim(), label.trim() || null, {
        affiliateCommissionPct: aff,
        customerDiscountPct: cust,
      });
      onCreated();
    } catch (err) {
      setError(toMessage(err, 'Could not create the code.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!submitting}
      title="New referral code"
      description={`Split your ${formatPct(poolPct)} pool between your commission and your friend’s discount.`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-code-form" variant="primary" size="sm" disabled={!canSubmit}>
            {submitting && <Loader2 size={14} aria-hidden="true" className="animate-spin" />}
            Create code
          </Button>
        </div>
      }
    >
      <form id="create-code-form" onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]">
            <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-danger)]" />
            {error}
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="code-code" className="block text-[13px] font-medium text-[var(--ds-text)]">
            Code
          </label>
          <Input
            id="code-code"
            value={code}
            autoFocus
            placeholder="e.g. STEVE20"
            maxLength={20}
            onChange={(e) => setCode(e.target.value)}
            aria-invalid={codeError ? true : undefined}
          />
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            {codeError ?? '3–20 letters, numbers, hyphens or underscores. This becomes your ?ref= link.'}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="code-label" className="block text-[13px] font-medium text-[var(--ds-text)]">
            Label <span className="font-normal text-[var(--ds-text-subtle)]">(optional, private)</span>
          </label>
          <Input
            id="code-label"
            value={label}
            placeholder="e.g. Newsletter — March"
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="code-aff" className="block text-[13px] font-medium text-[var(--ds-text)]">
              You earn (%)
            </label>
            <Input
              id="code-aff"
              type="number"
              inputMode="decimal"
              min={0}
              max={poolPct}
              step={1}
              value={affiliatePct}
              onChange={(e) => setAffiliatePct(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="code-cust" className="block text-[13px] font-medium text-[var(--ds-text)]">
              Friend saves (%)
            </label>
            <Input
              id="code-cust"
              type="number"
              inputMode="decimal"
              min={0}
              max={poolPct}
              step={1}
              value={customerPct}
              onChange={(e) => setCustomerPct(e.target.value)}
            />
          </div>
        </div>

        <p className={splitError ? 'text-[12px] text-[var(--ds-danger)]' : 'text-[12px] text-[var(--ds-text-subtle)]'}>
          {splitError ?? `${formatPct(remaining)} of your pool left unallocated (kept by the platform).`}
        </p>
      </form>
    </Modal>
  );
}
