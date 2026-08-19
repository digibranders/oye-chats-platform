import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  Field,
  Input,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
  formatNumber,
  toast,
  validateEmail,
} from '../../ui';
import { platform } from '../client';
import { MAX_CREDIT_DELTA, creditAmountProblem, creditDelta, creditReasonProblem } from './credits';
import type { ClientDetail, CreditGrantResult } from './types';

export interface AccountDialogProps {
  client: ClientDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Re-reads the record. Every one of these writes changes something the page displays. */
  onSaved: () => void;
}

/**
 * A manual credit adjustment.
 *
 * Two steps in one dialog rather than a form behind a second modal. The review
 * step is the confirmation: it names the account, states the direction in words,
 * and shows the balance before and after — which is the only number that tells
 * an operator whether they typed 5,000 or 50,000. The ledger is append-only and
 * event-sourced, so there is no edit afterwards, only a compensating entry; the
 * step says that too.
 */
export function CreditsDialog({ client, open, onOpenChange, onSaved }: AccountDialogProps) {
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setStep('form');
      setDirection('add');
      setAmount('');
      setReason('');
      setError(null);
    }
  }, [open]);

  const parsed = Number(amount);
  const amountProblem = creditAmountProblem(parsed);
  const reasonProblem = creditReasonProblem(reason);
  const delta = creditDelta(direction, parsed);
  const after = client.credits_balance + delta;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await platform.post<CreditGrantResult>(`/clients/${client.id}/credits`, {
        delta,
        reason: reason.trim(),
      });
      toast.success(`Balance is now ${formatNumber(result.balance)} credits.`);
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The adjustment was not recorded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Adjust credits"
      description={`A manual entry on ${client.name}'s credit ledger.`}
      dismissible={!busy}
      footer={
        step === 'form' ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={amountProblem !== null || reasonProblem !== null}
              onClick={() => setStep('review')}
            >
              Review
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setStep('form')}>
              Back
            </Button>
            <Button
              variant={direction === 'remove' ? 'danger' : 'primary'}
              loading={busy}
              onClick={() => void submit()}
            >
              {direction === 'remove'
                ? `Remove ${formatNumber(Math.abs(delta))} credits`
                : `Add ${formatNumber(delta)} credits`}
            </Button>
          </>
        )
      }
    >
      {error ? (
        <Alert tone="danger" live title="The adjustment was not recorded" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {step === 'form' ? (
        <div className="flex flex-col gap-4">
          <SegmentedControl
            label="Direction"
            value={direction}
            onChange={setDirection}
            items={[
              { value: 'add', label: 'Add credits' },
              { value: 'remove', label: 'Remove credits' },
            ]}
          />
          <Field
            label="Credits"
            required
            hint={`Whole credits, up to ${formatNumber(MAX_CREDIT_DELTA)} in one entry.`}
            error={amount !== '' ? amountProblem : null}
          >
            <Input
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="5000"
            />
          </Field>
          <Field
            label="Reason"
            required
            hint="Stored on the ledger entry and in the audit log. 3–500 characters."
            error={reason !== '' ? reasonProblem : null}
          >
            <Textarea
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Goodwill credit for the 14 Aug ingestion outage."
            />
          </Field>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Alert tone={direction === 'remove' ? 'danger' : 'warning'} title="This is money, and it is permanent">
            The credit ledger is append-only. This entry cannot be edited or deleted afterwards — only
            offset by a second, opposite entry.
          </Alert>
          <dl className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken px-3 py-3">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-text-tertiary">Account</dt>
              <dd className="text-sm font-medium text-text-primary">{client.name}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-text-tertiary">Balance now</dt>
              <dd className="figure text-sm text-text-primary">{formatNumber(client.credits_balance)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-text-tertiary">
                {direction === 'remove' ? 'Removing' : 'Adding'}
              </dt>
              <dd
                className={`figure text-sm font-medium ${direction === 'remove' ? 'text-danger' : 'text-success'}`}
              >
                {direction === 'remove' ? '−' : '+'}
                {formatNumber(Math.abs(delta))}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
              <dt className="text-sm font-medium text-text-primary">Balance after</dt>
              <dd className="figure text-sm font-semibold text-text-primary">{formatNumber(after)}</dd>
            </div>
          </dl>
          <div>
            <p className="text-xs text-text-tertiary">Reason recorded</p>
            <p className="mt-0.5 text-prose text-text-primary">{reason.trim()}</p>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Name and login address. `PATCH /superadmin/clients/{id}` — `superadmin_routes_v2.py:221`. */
export function EditAccountDialog({ client, open, onOpenChange, onSaved }: AccountDialogProps) {
  const [name, setName] = useState(client.name);
  const [email, setEmail] = useState(client.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(client.name);
      setEmail(client.email);
      setError(null);
    }
  }, [open, client.name, client.email]);

  const emailProblem = email.trim() ? validateEmail(email.trim()) : 'An account must have a login address.';
  const nameProblem = name.trim() ? null : 'An account must have a name.';
  const changed = name.trim() !== client.name || email.trim() !== client.email;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await platform.patch(`/clients/${client.id}`, { name: name.trim(), email: email.trim() });
      toast.success('Account details saved.');
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The account was not updated.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit account details"
      description="The login address is this account's identity and the destination for every email it receives."
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!changed || emailProblem !== null || nameProblem !== null}
            onClick={() => void submit()}
          >
            Save changes
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" live title="The account was not updated" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-4">
        <Field label="Account name" required error={nameProblem}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field
          label="Login email"
          required
          hint="Changing this changes where sign-in codes, invoices and every notification go."
          error={email.trim() ? emailProblem : null}
        >
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * Relocating an account's billing country.
 *
 * The customer-facing route freezes `billing_country` under a live mandate
 * because it is the tax-classification fact behind every invoice, so this is the
 * only path. The detail endpoint does not return the current value — only the
 * accounts list does — so the dialog does not claim to show one.
 */
export function BillingCountryDialog({ client, open, onOpenChange, onSaved }: AccountDialogProps) {
  const [country, setCountry] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setCountry('');
      setReason('');
      setError(null);
    }
  }, [open]);

  const code = country.trim().toUpperCase();
  const codeProblem = /^[A-Z]{2}$/.test(code) ? null : 'A two-letter ISO 3166-1 alpha-2 code, e.g. IN or GB.';
  const reasonProblem = reason.trim().length >= 1 ? null : 'The API requires a reason.';

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await platform.post(`/clients/${client.id}/billing-country`, { country: code, reason: reason.trim() });
      toast.success(`Billing country set to ${code}.`);
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The billing country was not changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Override billing country"
      description={`Re-classifies every future invoice issued to ${client.name}.`}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={codeProblem !== null || reasonProblem !== null}
            onClick={() => void submit()}
          >
            Set billing country
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" live title="The billing country was not changed" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-4">
        <Alert tone="warning" title="Do the mandate first">
          This records the new country; it does not move the payment rail. Verify the customer and
          re-point their Razorpay mandate before setting it. An account with a GSTIN on record cannot
          be moved off IN — the server answers 422 until the GSTIN is cleared.
        </Alert>
        <Field label="New billing country" required hint="ISO 3166-1 alpha-2." error={country ? codeProblem : null}>
          <Input
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            maxLength={2}
            placeholder="GB"
            autoComplete="off"
          />
        </Field>
        <Field label="Reason" required hint="Stored in the audit log against your account.">
          <Textarea
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Customer relocated to the UK; mandate re-pointed on 12 Aug."
          />
        </Field>
      </div>
    </Dialog>
  );
}

const ROLES = [
  { value: 'owner', label: 'Owner — may grant super-admin' },
  { value: 'admin', label: 'Admin — full writes' },
  { value: 'readonly', label: 'Read-only — no writes' },
];

/**
 * Super-admin privileges.
 *
 * Gated twice on the server: only an owner-tier actor may grant or change them,
 * and nobody may change their own through this endpoint. Both refusals come back
 * as a 403 with a sentence worth reading, so this surfaces the server's message
 * rather than guessing the caller's own role — which the client is never told.
 */
export function PrivilegesDialog({ client, open, onOpenChange, onSaved }: AccountDialogProps) {
  const [isSuperadmin, setIsSuperadmin] = useState(client.is_superadmin);
  const [role, setRole] = useState(client.superadmin_role ?? 'readonly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setIsSuperadmin(client.is_superadmin);
      setRole(client.superadmin_role ?? 'readonly');
      setError(null);
    }
  }, [open, client.is_superadmin, client.superadmin_role]);

  const changed = isSuperadmin !== client.is_superadmin || role !== (client.superadmin_role ?? 'readonly');

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await platform.patch(`/clients/${client.id}`, {
        is_superadmin: isSuperadmin,
        superadmin_role: isSuperadmin ? role : null,
      });
      toast.success('Privileges updated.');
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Privileges were not changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Super-admin privileges"
      description={`Grants or removes platform-console access for ${client.name}.`}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={!changed} onClick={() => void submit()}>
            {isSuperadmin ? 'Grant super-admin' : 'Remove super-admin'}
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" live title="Privileges were not changed" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-4">
        <Alert tone="danger" title="This grants access to every customer's data">
          A super-admin can read and act on every account on the platform. Only an owner-tier
          super-admin may make this change, and nobody may change their own privileges here.
        </Alert>
        <Switch
          checked={isSuperadmin}
          onCheckedChange={setIsSuperadmin}
          label="Platform console access"
          description="Signs this account into /platform with the super-admin persona."
        />
        {isSuperadmin ? (
          <Field label="Tier" hint="Read-only cannot write anything, including revoking its own tokens' peers.">
            <Select options={ROLES} value={role} onChange={(event) => setRole(event.target.value)} />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}
