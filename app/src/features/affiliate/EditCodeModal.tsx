/**
 * EditCodeModal - patch an existing referral code.
 *
 * Rebuilt from the legacy `components/affiliate/EditCodeModal.jsx` in the new
 * design language. Every field is an optional patch: renaming (with a loud
 * "this breaks your existing ?ref= link" warning), the private label, the
 * active toggle, and the commission split - the last validated live against the
 * affiliate's pool. Only changed fields are sent.
 *
 * Backend reused verbatim (typed in services/api.d.ts): updateAffiliateCode.
 */
import { type FormEvent, type ReactElement, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button, Input, Modal } from '../../design-system';
import { updateAffiliateCode } from '../../services/api';
import { type AffiliateCodeView, formatPct, validateCodeFormat, validateSplit } from './affiliateModel';

export interface EditCodeModalProps {
  open: boolean;
  onClose: () => void;
  /** The code being edited (null while closed). */
  code: AffiliateCodeView | null;
  /** The affiliate's total commission pool the split must fit. */
  poolPct: number;
  /** Fired after a successful save. */
  onSaved: () => void;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function pctValue(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function EditCodeModal({ open, onClose, code, poolPct, onSaved }: EditCodeModalProps): ReactElement | null {
  const [codeText, setCodeText] = useState('');
  const [label, setLabel] = useState('');
  const [active, setActive] = useState(true);
  const [affiliatePct, setAffiliatePct] = useState('0');
  const [customerPct, setCustomerPct] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seedId, setSeedId] = useState<number | null>(null);

  // Seed the form from the code each time a DIFFERENT code opens the modal.
  if (open && code && seedId !== code.id) {
    setSeedId(code.id);
    setCodeText(code.code);
    setLabel(code.label ?? '');
    setActive(code.active);
    setAffiliatePct(String(code.affiliateCommissionPct));
    setCustomerPct(String(code.customerDiscountPct));
    setError(null);
  } else if (!open && seedId !== null) {
    setSeedId(null);
  }

  const aff = pctValue(affiliatePct);
  const cust = pctValue(customerPct);
  const splitError = useMemo(() => validateSplit(aff, cust, poolPct), [aff, cust, poolPct]);
  const remaining = Math.max(0, poolPct - aff - cust);

  if (!open || !code) return null;

  const renamed = codeText.trim() !== code.code;
  const codeError = codeText.trim() ? validateCodeFormat(codeText) : 'Enter a code.';
  const canSubmit = !submitting && !codeError && !splitError;

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (codeError) {
      setError(codeError);
      return;
    }
    if (splitError) {
      setError(splitError);
      return;
    }

    // Send only what actually changed.
    const patch: {
      code?: string;
      label?: string;
      active?: boolean;
      affiliateCommissionPct?: number;
      customerDiscountPct?: number;
    } = {};
    if (renamed) patch.code = codeText.trim();
    if (label.trim() !== (code.label ?? '')) patch.label = label.trim();
    if (active !== code.active) patch.active = active;
    if (aff !== code.affiliateCommissionPct) patch.affiliateCommissionPct = aff;
    if (cust !== code.customerDiscountPct) patch.customerDiscountPct = cust;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await updateAffiliateCode(code.id, patch);
      onSaved();
    } catch (err) {
      setError(toMessage(err, 'Could not save your changes.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!submitting}
      title={`Edit ${code.code}`}
      description="Rename, relabel, toggle, or re-split this code."
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-code-form" variant="primary" size="sm" disabled={!canSubmit}>
            {submitting && <Loader2 size={14} aria-hidden="true" className="animate-spin" />}
            Save changes
          </Button>
        </div>
      }
    >
      <form id="edit-code-form" onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]">
            <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-danger)]" />
            {error}
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="edit-code-code" className="block text-[13px] font-medium text-[var(--ds-text)]">
            Code
          </label>
          <Input
            id="edit-code-code"
            value={codeText}
            maxLength={20}
            onChange={(e) => setCodeText(e.target.value)}
            aria-invalid={codeError ? true : undefined}
          />
          {renamed ? (
            <p className="flex items-start gap-1.5 text-[12px] text-[var(--ds-warning)]">
              <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
              Renaming breaks any <code className="font-mono">?ref={code.code}</code> links you’ve already shared.
            </p>
          ) : (
            <p className="text-[12px] text-[var(--ds-text-subtle)]">
              {codeError ?? '3–20 letters, numbers, hyphens or underscores.'}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="edit-code-label" className="block text-[13px] font-medium text-[var(--ds-text)]">
            Label <span className="font-normal text-[var(--ds-text-subtle)]">(optional, private)</span>
          </label>
          <Input id="edit-code-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        </div>

        <label className="flex items-center gap-2.5 text-[13px] text-[var(--ds-text)]">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 rounded border-[var(--ds-border)] text-[var(--ds-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
          />
          <span>
            Active <span className="text-[var(--ds-text-subtle)]">- an inactive code stops attributing new signups.</span>
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="edit-code-aff" className="block text-[13px] font-medium text-[var(--ds-text)]">
              You earn (%)
            </label>
            <Input
              id="edit-code-aff"
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
            <label htmlFor="edit-code-cust" className="block text-[13px] font-medium text-[var(--ds-text)]">
              Friend saves (%)
            </label>
            <Input
              id="edit-code-cust"
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
          {splitError ?? `${formatPct(remaining)} of your ${formatPct(poolPct)} pool left unallocated.`}
        </p>
      </form>
    </Modal>
  );
}
