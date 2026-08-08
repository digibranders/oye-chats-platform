/**
 * VisitorIntelligenceSection - the Professional-only company/threat signal
 * + validated-email display inside the lead detail drawer, plus the manual
 * "Send Follow-up" action.
 *
 * Unlike `LeadInsights` (whose sections simply omit themselves when their
 * data is absent), this section is itself gated: on Free/Starter/Standard
 * it renders a compact locked teaser instead of the fields, since the data
 * genuinely doesn't exist in the API response on those plans (see
 * `build_lead_response`'s `include_visitor_intelligence` parameter).
 */
import { type ReactElement, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, Lock, Mail, Send, Shield, XCircle } from 'lucide-react';
import { Button, StatusBadge } from '../../design-system';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { sendLeadFollowUp } from '../../services/api';
import { type LeadDetail } from './useLeadDetail';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function SectionTitle({ children }: { children: string }): ReactElement {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-muted)]">
      <Shield size={13} aria-hidden="true" />
      {children}
    </h3>
  );
}

/** Compact locked teaser shown in place of the section on non-Professional plans. */
function LockedTeaser(): ReactElement {
  const { openUpgradeModal } = useUpgradeModal();
  return (
    <section className="space-y-3">
      <SectionTitle>Visitor Intelligence</SectionTitle>
      <button
        type="button"
        onClick={() => openUpgradeModal('view_visitor_intelligence')}
        className="flex w-full items-center gap-3 rounded-xl border border-dashed border-[var(--ds-border)] p-4 text-left transition-colors hover:border-[var(--ds-border-strong)]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
          <Lock size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-[var(--ds-text)]">
            Company signal & email validity are locked
          </span>
          <span className="block text-[12px] text-[var(--ds-text-subtle)]">
            Upgrade to Professional to see this and send a manual follow-up.
          </span>
        </span>
      </button>
    </section>
  );
}

function CompanySignal({ metadata }: { metadata: Record<string, unknown> }): ReactElement | null {
  const company = asString(metadata.company);
  const asn = asString(metadata.asn) ?? asString(metadata.org);
  const isVpn = metadata.is_vpn === true || metadata.is_proxy === true;
  if (!company && !asn && !isVpn) return null;

  return (
    <div className="space-y-2 rounded-xl border border-[var(--ds-border)] p-4">
      {company && (
        <div className="flex items-center gap-2.5 text-[13px] text-[var(--ds-text)]">
          <Building2 size={15} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
          <span className="break-words">{company}</span>
        </div>
      )}
      {asn && !company && <p className="text-[12px] text-[var(--ds-text-subtle)]">Network: {asn}</p>}
      {isVpn && (
        <div className="flex items-center gap-2 text-[12px]">
          <AlertTriangle size={13} className="shrink-0 text-[var(--ds-warning)]" aria-hidden="true" />
          <span className="text-[var(--ds-warning)]">Connecting via VPN/proxy — company signal may be unreliable</span>
        </div>
      )}
    </div>
  );
}

function EmailValidityBadge({ isValid, score }: { isValid: boolean | null | undefined; score: number | null | undefined }): ReactElement | null {
  if (isValid === null || isValid === undefined) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--ds-text-subtle)]">
        <Mail size={13} aria-hidden="true" />
        Email not yet validated
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {isValid ? (
        <StatusBadge tone="success">
          <CheckCircle2 size={12} aria-hidden="true" className="mr-1 inline" />
          Deliverable{typeof score === 'number' ? ` · ${score}/100` : ''}
        </StatusBadge>
      ) : (
        <StatusBadge tone="danger">
          <XCircle size={12} aria-hidden="true" className="mr-1 inline" />
          Not confirmed deliverable
        </StatusBadge>
      )}
    </div>
  );
}

interface FollowUpActionProps {
  sessionId: string;
  eligible: boolean;
}

/** The manual "Send Follow-up" button — the only send path in this system;
 * there is no automatic/timed send anywhere. Every server-side gate can
 * still reject the click (409 cooldown offers a one-click override retry;
 * 400/403/423 surface as a plain error with no retry). */
function FollowUpAction({ sessionId, eligible }: FollowUpActionProps): ReactElement {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error' | 'cooldown'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function send(confirmOverride: boolean): Promise<void> {
    setState('sending');
    setMessage(null);
    try {
      await sendLeadFollowUp(sessionId, confirmOverride);
      setState('sent');
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Could not send the follow-up.';
      const status = (err as { status?: number } | undefined)?.status;
      if (status === 409) {
        setState('cooldown');
        setMessage(detail);
      } else {
        setState('error');
        setMessage(detail);
      }
    }
  }

  if (!eligible) return <></>;

  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={state === 'sending' || state === 'sent'}
        onClick={() => void send(false)}
      >
        <Send size={14} aria-hidden="true" />
        {state === 'sending' ? 'Sending…' : state === 'sent' ? 'Sent' : 'Send follow-up email'}
      </Button>
      {state === 'cooldown' && message && (
        <div className="space-y-1.5">
          <p className="text-[12px] text-[var(--ds-warning)]">{message}</p>
          <Button size="sm" variant="ghost" onClick={() => void send(true)}>
            Send anyway
          </Button>
        </div>
      )}
      {state === 'error' && message && <p className="text-[12px] text-[var(--ds-danger)]">{message}</p>}
    </div>
  );
}

export function VisitorIntelligenceSection({
  detail,
  unlocked,
}: {
  detail: LeadDetail;
  unlocked: boolean;
}): ReactElement {
  if (!unlocked) return <LockedTeaser />;

  const metadata = asRecord(detail.visitor_metadata);
  const hasCompanySignal = Object.keys(metadata).length > 0;
  const isValidEmail = detail.contact?.is_valid_email;
  const emailScore = detail.contact?.email_score;
  const eligibleForFollowUp = Boolean(detail.contact?.email) && isValidEmail === true;

  return (
    <section className="space-y-3">
      <SectionTitle>Visitor Intelligence</SectionTitle>
      <div className="space-y-3">
        {hasCompanySignal ? (
          <CompanySignal metadata={metadata} />
        ) : (
          <p className="rounded-xl border border-[var(--ds-border)] p-4 text-[12px] text-[var(--ds-text-subtle)]">
            No company signal resolved for this visitor's IP yet.
          </p>
        )}
        {detail.contact?.email && <EmailValidityBadge isValid={isValidEmail} score={emailScore} />}
        <FollowUpAction sessionId={detail.session_id} eligible={eligibleForFollowUp} />
      </div>
    </section>
  );
}
