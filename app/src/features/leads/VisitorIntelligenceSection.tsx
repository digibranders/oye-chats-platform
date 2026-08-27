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
import { useTranslation } from '../../i18n/useTranslation';

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
  const { t } = useTranslation();
  const { openUpgradeModal } = useUpgradeModal();
  return (
    <section className="space-y-3">
      <SectionTitle>{t('leads.networkRisk') || 'Network & risk'}</SectionTitle>
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
            {t('leads.networkSignalEmailValidityAre') || 'Network signal & email validity are locked'}
          </span>
          <span className="block text-[12px] text-[var(--ds-text-subtle)]">
            {t('leads.upgradeToProfessionalToSee') || 'Upgrade to Professional to see this and send a manual follow-up.'}
          </span>
        </span>
      </button>
    </section>
  );
}

/**
 * The IP signal, read from the flattened shape `ip_intel_service` produces
 * (`company_name` / `company_domain` / `company_type` / `asn_org`, plus the
 * risk booleans). It is namespaced under `visitor_metadata.ip_intel` because
 * that column is shared with the operator console's user-agent fields.
 */
/** Is there anything worth rendering in this IP signal? Kept separate from the
 * component so the caller can pick between the signal and its empty state, a
 * component that returns `null` is still a truthy JSX element to the caller,
 * so `<CompanySignal/> ?? fallback` would silently never show the fallback. */
function hasCompanySignal(intel: Record<string, unknown>): boolean {
  return Boolean(
    asString(intel.company_name) ||
      asString(intel.asn_org) ||
      intel.is_vpn === true ||
      intel.is_proxy === true ||
      intel.is_tor === true,
  );
}

function CompanySignal({ intel }: { intel: Record<string, unknown> }): ReactElement | null {
  const { t } = useTranslation();
  const companyName = asString(intel.company_name);
  const companyDomain = asString(intel.company_domain);
  const asnOrg = asString(intel.asn_org);
  const isVpn = intel.is_vpn === true || intel.is_proxy === true || intel.is_tor === true;

  if (!hasCompanySignal(intel)) return null;

  // `company_name` now arrives already filtered: the API strips it for every
  // hosting range, ISP range, carrier brand and subnet label, so anything that
  // reaches this component is a range someone can actually be employed by.
  // `ip_intel_service.fetch_ip_intel` is the ONLY sanctioned writer of
  // `visitor_metadata.ip_intel`. Anything else writing that key must apply
  // the same gates, or this component starts asserting something it cannot
  // back up. (An alembic backfill was a second, unfiltered writer until it was
  // made to share the gates.)
  // That is why there is no longer an "is this really an employer?" test here
  //, the old inline disclaimer was deciding, in the UI, a question the API
  // now answers. Two DIFFERENT things are rendered, never one thing hedged:
  // a company, or the network that routed them.
  return (
    <div className="space-y-2 rounded-xl border border-[var(--ds-border)] p-4">
      {companyName ? (
        <div className="flex items-start gap-2.5 text-[13px] text-[var(--ds-text)]">
          <Building2 size={15} className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block break-words font-medium">{companyName}</span>
            {companyDomain && (
              <span className="block break-all text-[12px] text-[var(--ds-text-subtle)]">{companyDomain}</span>
            )}
            <span className="mt-1 block text-[11px] text-[var(--ds-text-subtle)]">
              {t('leads.derivedFromVisitorNetwork') || 'Derived from the visitor’s network, not a confirmed employer.'}
            </span>
          </span>
        </div>
      ) : asnOrg ? (
        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          {t('leads.connectingVia') || 'Connecting via'} <span className="text-[var(--ds-text)]">{asnOrg}</span>
        </p>
      ) : null}
      {isVpn && (
        <div className="flex items-start gap-2 text-[12px]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--ds-warning)]" aria-hidden="true" />
          <span className="text-[var(--ds-warning)]">
            {t('leads.connectingViaVpnProxyCompany') || 'Connecting via VPN/proxy. Company signal is unreliable'}
          </span>
        </div>
      )}
    </div>
  );
}

function EmailValidityBadge({ isValid, score }: { isValid: boolean | null | undefined; score: number | null | undefined }): ReactElement | null {
  const { t } = useTranslation();
  if (isValid === null || isValid === undefined) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--ds-text-subtle)]">
        <Mail size={13} aria-hidden="true" />
        {t('leads.emailNotYetValidated') || 'Email not yet validated'}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {isValid ? (
        <StatusBadge tone="success">
          <CheckCircle2 size={12} aria-hidden="true" className="mr-1 inline" />
          {t('leads.deliverable') || 'Deliverable'}{typeof score === 'number' ? ` · ${score}/100` : ''}
        </StatusBadge>
      ) : (
        <StatusBadge tone="danger">
          <XCircle size={12} aria-hidden="true" className="mr-1 inline" />
          {t('leads.notConfirmedDeliverable') || 'Not confirmed deliverable'}
        </StatusBadge>
      )}
    </div>
  );
}

interface FollowUpActionProps {
  sessionId: string;
  /** Reoon's verdict: true = deliverable, false = known junk, null/undefined = never checked. */
  isValidEmail: boolean | null | undefined;
}

/** The manual "Send Follow-up" button, the only send path in this system;
 * there is no automatic/timed send anywhere.
 *
 * The button is ALWAYS rendered (unless there is literally no address to
 * send to). It previously returned nothing whenever `is_valid_email` wasn't
 * exactly `true`, which silently hid the feature on every lead captured
 * before validation existed. Indistinguishable, to the operator, from the
 * feature being broken. A disabled button with a reason is honest; an
 * invisible one is not.
 *
 * Server-side gates remain authoritative and can still reject the click:
 * 409 (cooldown, or an unvalidated address) offers a one-click confirmed
 * retry; 400/403/423 are terminal and surface as a plain error. */
function FollowUpAction({ sessionId, isValidEmail }: FollowUpActionProps): ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error' | 'confirm'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const blockedByValidation = isValidEmail === false;

  async function send(confirmOverride: boolean): Promise<void> {
    setState('sending');
    setMessage(null);
    try {
      await sendLeadFollowUp(sessionId, confirmOverride);
      setState('sent');
    } catch (err) {
      const detail = err instanceof Error ? err.message : t('leads.couldNotSendTheFollow') || 'Could not send the follow-up.';
      const status = (err as { status?: number } | undefined)?.status;
      // 409 is the server's "are you sure?", a cooldown that hasn't elapsed,
      // or an address Reoon never got to validate. Both are recoverable with
      // an explicit confirm, so offer that instead of a dead end.
      setState(status === 409 ? 'confirm' : 'error');
      setMessage(detail);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={state === 'sending' || state === 'sent' || blockedByValidation}
        onClick={() => void send(false)}
      >
        <Send size={14} aria-hidden="true" />
        {state === 'sending' ? t('leads.sending') || 'Sending…' : state === 'sent' ? t('leads.followUpSent') || 'Follow-up sent' : t('leads.sendFollowUpEmail') || 'Send follow-up email'}
      </Button>

      {blockedByValidation && (
        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          {t('leads.thisAddressFailedEmailValidation') || 'This address failed email validation, so it can’t be contacted.'}
        </p>
      )}
      {!blockedByValidation && isValidEmail !== true && state === 'idle' && (
        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          {t('leads.emailNotValidated') || 'This address hasn’t been validated. You’ll be asked to confirm.'}
        </p>
      )}

      {state === 'confirm' && message && (
        <div className="space-y-1.5">
          <p className="text-[12px] text-[var(--ds-warning)]">{message}</p>
          <Button size="sm" variant="ghost" onClick={() => void send(true)}>
            {t('leads.sendAnyway') || 'Send anyway'}
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
  const { t } = useTranslation();
  if (!unlocked) return <LockedTeaser />;

  // IP intel lives under a namespaced key. `visitor_metadata` itself is a
  // shared blob (the operator console stores user-agent fields alongside).
  const intel = asRecord(asRecord(detail.visitor_metadata).ip_intel);
  const isValidEmail = detail.contact?.is_valid_email;
  const emailScore = detail.contact?.email_score;
  const email = detail.contact?.email;

  return (
    <section className="space-y-3">
      <SectionTitle>{t('leads.networkRisk') || 'Network & risk'}</SectionTitle>
      <div className="space-y-3">
        {hasCompanySignal(intel) ? (
          <CompanySignal intel={intel} />
        ) : (
          <p className="rounded-xl border border-[var(--ds-border)] p-4 text-[12px] text-[var(--ds-text-subtle)]">
            {t('leads.noNetworkDetailsResolvedFor') || 'No network details resolved for this visitor.'}
          </p>
        )}
        {email && <EmailValidityBadge isValid={isValidEmail} score={emailScore} />}
        {email && <FollowUpAction sessionId={detail.session_id} isValidEmail={isValidEmail} />}
      </div>
    </section>
  );
}
