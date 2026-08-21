import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, toast } from '../../ui';
import { createAffiliateCode, updateAffiliateCode } from '../../services/api';
import {
  formatPct,
  validateCodeFormat,
  validateSplit,
  type AffiliateCodeView,
} from './affiliateModel';

export interface CodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates a new code. */
  code: AffiliateCodeView | null;
  /** The commission pool this affiliate may split, as a whole percent. */
  poolPct: number;
  onSaved: () => void;
}

/** A percent text field, coerced. Blank reads as zero, never as NaN. */
function pctValue(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Create or edit a referral code.
 *
 * One dialog for both, because they ask the same four questions and the console
 * this replaces had two nearly-identical modals whose validation had already
 * drifted apart. Editing sends only the fields that actually changed, so
 * renaming a code does not silently rewrite its split.
 *
 * The split is the point of the form, so it is shown as arithmetic while it is
 * being entered: your cut, their discount, and what is left of the pool. A
 * split that exceeds the pool is refused by `affiliate_service._validate_split`
 * server-side; saying so here means the user is not told after the fact.
 */
export function CodeDialog({ open, onOpenChange, code, poolPct, onSaved }: CodeDialogProps) {
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [affiliatePct, setAffiliatePct] = useState('0');
  const [customerPct, setCustomerPct] = useState('0');
  const [codeError, setCodeError] = useState<string | null>(null);

  // Seeded during render on which code is open, so the form never paints one
  // frame of the previously-edited code's split.
  const seed = open ? (code ? String(code.id) : 'new') : null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (seeded !== seed) {
    setSeeded(seed);
    if (seed !== null) {
      setText(code?.code ?? '');
      setLabel(code?.label ?? '');
      setAffiliatePct(String(code ? code.affiliateCommissionPct : poolPct));
      setCustomerPct(String(code ? code.customerDiscountPct : 0));
      setCodeError(null);
    }
  }

  const mine = pctValue(affiliatePct);
  const theirs = pctValue(customerPct);
  const splitError = validateSplit(mine, theirs, poolPct);
  const remaining = Math.max(0, poolPct - mine - theirs);

  const save = useMutation({
    mutationFn: async () => {
      if (!code) {
        return createAffiliateCode(text.trim(), label.trim() || null, {
          affiliateCommissionPct: mine,
          customerDiscountPct: theirs,
        });
      }
      const patch: {
        code?: string;
        label?: string;
        affiliateCommissionPct?: number;
        customerDiscountPct?: number;
      } = {};
      if (text.trim() !== code.code) patch.code = text.trim();
      if (label.trim() !== (code.label ?? '')) patch.label = label.trim();
      if (mine !== code.affiliateCommissionPct) patch.affiliateCommissionPct = mine;
      if (theirs !== code.customerDiscountPct) patch.customerDiscountPct = theirs;
      if (Object.keys(patch).length === 0) return null;
      return updateAffiliateCode(code.id, patch);
    },
    onSuccess: () => {
      toast.success(code ? 'Code updated' : `Code ${text.trim()} created`);
      onOpenChange(false);
      onSaved();
    },
  });

  function submit() {
    const reason = validateCodeFormat(text);
    if (reason) {
      setCodeError(reason);
      return;
    }
    if (splitError) return;
    setCodeError(null);
    save.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={code ? `Edit ${code.code}` : 'New referral code'}
      description={`Split your ${formatPct(poolPct)} pool between what you keep and what your referral saves.`}
      dismissible={!save.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending} disabled={splitError !== null}>
            {code ? 'Save changes' : 'Create code'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {save.isError ? (
          <Alert tone="danger" live title="We could not save that code">
            {save.error instanceof Error
              ? save.error.message
              : 'Something went wrong. Please try again.'}
          </Alert>
        ) : null}

        {code ? (
          <Alert tone="warning">
            Renaming breaks links already using the old code. Existing signups stay attributed.
          </Alert>
        ) : null}

        <Field
          label="Code"
          required
          hint="This is what a visitor types, and what goes in the link."
          error={codeError}
        >
          <Input
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setCodeError(null);
            }}
            placeholder="LAUNCH25"
            autoComplete="off"
            className="figure"
          />
        </Field>

        <Field label="Label" optional hint="Only you see this.">
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Newsletter, March"
          />
        </Field>

        {/* Not `Grid`: its 2-up step is `@3xl/page` (768) and this dialog's
            body is 472px, so `Grid cols={2}` renders one column inside it —
            two 8-character percent fields stacked. See the round-two report. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="You keep" required hint="Percent of every bill.">
            <Input
              value={affiliatePct}
              onChange={(event) => setAffiliatePct(event.target.value)}
              inputMode="decimal"
              className="figure"
            />
          </Field>
          <Field label="They save" required hint="Discount off their plan.">
            <Input
              value={customerPct}
              onChange={(event) => setCustomerPct(event.target.value)}
              inputMode="decimal"
              className="figure"
            />
          </Field>
        </div>

        {/* `Alert tone="neutral"` already draws a sunken ground with an ink
            leading rule and takes `live`. The hand-drawn box was the third copy
            of one unnamed "explainer well" in this scope. */}
        <Alert tone={splitError ? 'danger' : 'neutral'} live>
          {splitError ?? (
            <>
              You keep <span className="figure text-text-primary">{formatPct(mine)}</span>, they
              save <span className="figure text-text-primary">{formatPct(theirs)}</span>, and{' '}
              <span className="figure text-text-primary">{formatPct(remaining)}</span> of your pool
              is unused — that share stays with OyeChats.
            </>
          )}
        </Alert>
      </div>
    </Dialog>
  );
}
