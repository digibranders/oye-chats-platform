import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { Alert, Badge, Button, ConfirmDialog, LockedState, buttonClass } from '../../ui';
import { sendLeadFollowUp } from '../../services/api';
import type { Lead } from '../../types/domain';

/**
 * The Professional-only network and email signal, plus the manual follow-up.
 *
 * Unlike `LeadInsights`, whose sections omit themselves when their data is
 * absent, this one is itself gated: on Free, Starter and Standard the fields do
 * not exist in the API response at all (`build_lead_response`'s
 * `include_visitor_intelligence`), so a locked panel is the honest rendering.
 *
 * The follow-up button now confirms. It sends a real email to a real person on
 * a single click, and it did so with no confirmation and no way back.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Is there anything worth rendering in this IP signal?
 *
 * Kept apart from the component because a component returning `null` is still a
 * truthy element to its caller, so `<CompanySignal/> ?? fallback` would never
 * show the fallback.
 */
function hasNetworkSignal(intel: Record<string, unknown>): boolean {
  return Boolean(
    asText(intel.company_name) ||
      asText(intel.asn_org) ||
      intel.is_vpn === true ||
      intel.is_proxy === true ||
      intel.is_tor === true,
  );
}

function NetworkSignal({ intel }: { intel: Record<string, unknown> }) {
  const company = asText(intel.company_name);
  const domain = asText(intel.company_domain);
  const asn = asText(intel.asn_org);
  const masked = intel.is_vpn === true || intel.is_proxy === true || intel.is_tor === true;

  // `company_name` arrives already filtered: the API strips it for every
  // hosting range, ISP range and carrier brand, so anything reaching here is a
  // range somebody could actually be employed by. Two different things are
  // rendered — a company, or the network that routed them — never one hedged.
  return (
    <div className="space-y-2 rounded-md border border-border px-3.5 py-3">
      {company ? (
        <div>
          <p className="text-base font-medium text-text-primary">{company}</p>
          {domain ? <p className="break-all text-xs text-text-secondary">{domain}</p> : null}
          <p className="mt-1 text-xs text-text-tertiary">
            Derived from the visitor&rsquo;s network. Not a confirmed employer.
          </p>
        </div>
      ) : asn ? (
        <p className="text-prose text-text-secondary">
          Connecting via <span className="text-text-primary">{asn}</span>
        </p>
      ) : null}
      {masked ? (
        <Alert tone="warning">
          Connecting through a VPN or proxy, so the network signal is unreliable.
        </Alert>
      ) : null}
    </div>
  );
}

function FollowUp({ sessionId, isValidEmail, email }: {
  sessionId: string;
  /** Reoon's verdict: true deliverable, false known junk, null never checked. */
  isValidEmail: boolean | null | undefined;
  email: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<'idle' | 'sent' | 'error' | 'needs-override' | 'paused'>(
    'idle',
  );
  const [message, setMessage] = useState<string | null>(null);

  const blocked = isValidEmail === false;

  async function send(override: boolean): Promise<void> {
    setMessage(null);
    try {
      await sendLeadFollowUp(sessionId, override);
      setState('sent');
      setConfirming(false);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'The follow-up could not be sent.';
      const status = (cause as { status?: number } | undefined)?.status;
      // 409 is the server asking "are you sure?" — a cooldown that has not
      // elapsed, or an address validation never reached. Both are recoverable
      // with an explicit second confirmation, so offer it rather than a dead end.
      //
      // 423 is Gate 4: follow-ups are paused for the whole chatbot. There is no
      // override for it and retrying is pointless, so it gets its own state
      // that names the switch instead of offering a "Send anyway" that the
      // server would refuse identically.
      setState(status === 409 ? 'needs-override' : status === 423 ? 'paused' : 'error');
      setMessage(detail);
      setConfirming(false);
    }
  }

  if (state === 'sent') {
    return (
      <Alert tone="success" live>
        Follow-up sent to {email}.
      </Alert>
    );
  }

  return (
    <div className="space-y-2">
      {/* Always rendered unless there is no address at all. An earlier version
          hid it whenever `is_valid_email` was not exactly `true`, which made the
          feature invisible on every lead captured before validation existed —
          indistinguishable, to the operator, from it being broken. */}
      <Button
        variant="secondary"
        size="sm"
        disabled={blocked}
        iconLeft={<Send aria-hidden className="h-3.5 w-3.5" />}
        onClick={() => setConfirming(true)}
      >
        Send a follow-up email
      </Button>

      {blocked ? (
        <p className="text-xs text-text-secondary">
          This address failed validation, so it cannot be contacted.
        </p>
      ) : isValidEmail !== true ? (
        <p className="text-xs text-text-secondary">
          This address has not been validated yet. You will be asked to confirm.
        </p>
      ) : null}

      {state === 'needs-override' && message ? (
        <Alert
          tone="warning"
          live
          action={
            <Button size="sm" variant="secondary" onClick={() => void send(true)}>
              Send anyway
            </Button>
          }
        >
          {message}
        </Alert>
      ) : null}
      {state === 'paused' && message ? (
        <Alert tone="warning" live title="Follow-ups are paused for this chatbot">
          {message} Somebody with access to the chatbot can turn them back on under Behaviour ▸
          Lead follow-up emails. Nothing is queued in the meantime.
        </Alert>
      ) : null}
      {state === 'error' && message ? (
        <Alert tone="danger" live>
          {message}
        </Alert>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Send a follow-up email?"
        description={
          <>
            This sends a real email to <strong>{email}</strong> now. It cannot be recalled, and the
            visitor did not ask for it.
          </>
        }
        confirmLabel="Send it"
        onConfirm={() => send(false)}
      />
    </div>
  );
}

export function VisitorIntelligenceSection({
  lead,
  unlocked,
}: {
  lead: Lead;
  unlocked: boolean;
}) {
  if (!unlocked) {
    return (
      <section className="space-y-2">
        <h3 className="text-lg font-semibold text-text-primary">Network and email</h3>
        <LockedState
          compact
          title="Included on the Professional plan"
          description="See the company behind a visitor's network, whether their email address is deliverable, and send them a follow-up from here."
          action={
            <Link to="/billing" className={buttonClass('secondary', 'sm')}>
              See plans
            </Link>
          }
        />
      </section>
    );
  }

  // IP intel lives under a namespaced key: `visitor_metadata` is a shared blob
  // that the operator console also writes user-agent fields into.
  const intel = asRecord(asRecord(lead.visitor_metadata).ip_intel);
  const email = lead.contact?.email ?? null;
  const isValidEmail = lead.contact?.is_valid_email;
  const emailScore = lead.contact?.email_score;

  return (
    <section className="space-y-2">
      <h3 className="text-lg font-semibold text-text-primary">Network and email</h3>

      {hasNetworkSignal(intel) ? (
        <NetworkSignal intel={intel} />
      ) : (
        <p className="rounded-md border border-border px-3.5 py-3 text-prose text-text-secondary">
          No network details resolved for this visitor.
        </p>
      )}

      {email ? (
        <div className="space-y-2">
          {isValidEmail === true ? (
            <Badge tone="success">
              Deliverable{typeof emailScore === 'number' ? ` · ${emailScore}/100` : ''}
            </Badge>
          ) : isValidEmail === false ? (
            <Badge tone="danger">Not deliverable</Badge>
          ) : (
            <Badge>Not validated yet</Badge>
          )}
          <FollowUp sessionId={lead.session_id} isValidEmail={isValidEmail} email={email} />
        </div>
      ) : null}
    </section>
  );
}
