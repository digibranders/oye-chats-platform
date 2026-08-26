/**
 * SubdomainSessionSection - cross-subdomain conversation continuity.
 *
 * A visitor's chat session lives in the widget's `localStorage`, which the
 * browser partitions per origin - so a conversation started on `example.com`
 * would restart on `academy.example.com`. To bridge that, the widget also
 * mirrors the session id into a cookie scoped to the parent domain
 * (`Domain=.example.com`), which every subdomain can read, so the same
 * conversation continues across `*.example.com`.
 *
 * This is now AUTOMATIC: when no domain is set, the widget auto-detects the
 * registrable apex of the page it runs on and scopes the cookie there, so
 * continuity works with zero configuration. This panel therefore presents as
 * "on automatically" with an OPTIONAL override for owners who want to pin a
 * specific parent domain (e.g. to scope narrower/broader than auto-detect).
 *
 * Governs the backend `session_share_domain` field via `updateBot`. Empty =
 * auto-detect (the default). A value = explicit override. Lives in the Website
 * channel card, beneath the domain allow-list, because both concern how the
 * embed behaves across a customer's domains. Mount with `key={botId}` so
 * switching agents reseeds from props.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { AlertCircle, Info, Link2, Network, ShieldCheck } from 'lucide-react';
import { Button, StatusBadge } from '../../../design-system';
import { InsightCard } from '../../../design-system/components/InsightCard';
import { getBot, updateBot } from '../../../services/api';
import { useTranslation } from '../../../i18n/useTranslation';
import { Trans } from '../../../i18n/Trans';
import { t as translateNow } from '../../../i18n/i18n';

export interface SubdomainSessionSectionProps {
  botId: number;
  website?: string | null;
  /** The bot's stored `session_share_domain` (bare hostname) or null/empty. */
  initialShareDomain?: string | null;
  /** Merge the saved value back into the parent's cached bot record. */
  onSaved: (next: { session_share_domain: string | null }) => void;
}

/**
 * Reduce free-form input to a bare, canonical hostname. Strips
 * scheme/path/port/leading-www and a stray `*.` prefix (this value becomes a
 * cookie Domain, which can't be a wildcard). Returns null for input that can't
 * be a domain, so the caller can surface an error before hitting the API.
 */
function normalizeParentDomain(input: string): string | null {
  let value = String(input || '').trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('*.')) value = value.slice(2);
  value = value.replace(/^https?:\/\//, '');
  value = value.split('/')[0];
  value = value.split(':')[0];
  if (value.startsWith('www.')) value = value.slice(4);
  if (!value) return null;
  // Allow local hosts so the feature is configurable during local testing
  // (a host-only cookie still bridges two localhost origins on different ports).
  if (value === 'localhost' || value === '127.0.0.1') return value;

  const hostnamePattern =
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (!hostnamePattern.test(value)) return null;
  return value;
}

export function SubdomainSessionSection({
  botId,
  website,
  initialShareDomain,
  onSaved,
}: SubdomainSessionSectionProps): ReactElement {
  const { t } = useTranslation();
  const seededDomain = (initialShareDomain || '').trim();
  const [domain, setDomain] = useState<string>(seededDomain);
  const [inputError, setInputError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const websiteDomain = useMemo(() => normalizeParentDomain(website || ''), [website]);
  const normalizedDomain = useMemo(() => normalizeParentDomain(domain), [domain]);
  const hasOverride = domain.trim().length > 0;

  // Status card. Continuity is ALWAYS on now (the widget auto-detects the
  // apex when no domain is set), so the copy distinguishes the automatic
  // default from an explicit override, and warns while an invalid override
  // is being typed.
  const status = useMemo(() => {
    if (hasOverride && !normalizedDomain) {
      return {
        tone: 'warning' as const,
        icon: AlertCircle,
        title: translateNow('agents.thatDoesNotLookLike') || 'That does not look like a domain',
        body: translateNow('agents.enterAParentDomainLike') || 'Enter a parent domain like example.com, or clear the field to detect it automatically.',
      };
    }
    if (normalizedDomain) {
      return {
        tone: 'success' as const,
        icon: ShieldCheck,
        title: `Scoped to *.${normalizedDomain}`,
        body: `A chat started on ${normalizedDomain} keeps going on every subdomain, like app.${normalizedDomain} or academy.${normalizedDomain}.`,
      };
    }
    return {
      tone: 'success' as const,
      icon: ShieldCheck,
      title: translateNow('agents.onAutomatically') || 'On automatically',
      body: websiteDomain
        ? `Conversations follow visitors across all your subdomains. We detect ${websiteDomain} automatically, so there is nothing to set up.`
        : translateNow('agents.conversationsFollowVisitorsAcrossAll') || 'Conversations follow visitors across all your subdomains automatically. There is nothing to set up.',
    };
  }, [hasOverride, normalizedDomain, websiteDomain]);

  const markDirty = (): void => {
    setDirty(true);
    setSaved(false);
    setSaveError('');
  };

  const detectFromWebsite = (): void => {
    if (!websiteDomain) return;
    setDomain(websiteDomain);
    setInputError('');
    markDirty();
  };

  const clearOverride = (): void => {
    setDomain('');
    setInputError('');
    markDirty();
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    // Validate only when an override is present; an empty field means
    // auto-detect, which is always valid.
    if (hasOverride) {
      const normalized = normalizeParentDomain(domain);
      if (!normalized) {
        setInputError(t('agents.enterAValidDomainLike') || 'Enter a valid domain like example.com');
        return;
      }
    }
    setInputError('');
    setSaving(true);
    setSaveError('');
    // Empty string clears the override server-side, so the widget falls
    // back to auto-detecting the apex (sharing stays on).
    const payload = hasOverride ? (normalizeParentDomain(domain) as string) : '';
    try {
      await updateBot(botId, { session_share_domain: payload });
      // Re-read so we reflect the server-normalized value and stay in sync.
      let nextDomain: string | null = payload || null;
      try {
        const fresh = (await getBot(botId)) as { session_share_domain?: string | null };
        nextDomain = fresh.session_share_domain ?? null;
        setDomain(nextDomain || '');
      } catch {
        /* keep the optimistic value if the reload fails */
      }
      onSaved({ session_share_domain: nextDomain });
      setDirty(false);
      setSaved(true);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : t('agents.failedToSaveSessionSharing') || 'Failed to save session sharing.');
    } finally {
      setSaving(false);
    }
  };

  const StatusIcon = status.icon;
  const canDetect = Boolean(websiteDomain) && normalizedDomain !== websiteDomain;

  return (
    <div className="mt-6 border-t border-[var(--ds-border)] pt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--ds-text)]">
          <Link2 size={14} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
          {t('agents.continueSessionsAcrossSubdomains') || 'Continue sessions across subdomains'}
        </span>
        {/* Not a toggle: continuity is always on. The pill just reports
            whether it is running on auto-detect or a pinned override. Uses
            the shared StatusBadge so it matches every other pill in the
            admin (quiet chip, tone carried by the dot). */}
        <StatusBadge tone="success">{hasOverride ? 'Custom' : 'Automatic'}</StatusBadge>
      </div>

      <InsightCard tone={status.tone} icon={StatusIcon} title={status.title} body={status.body} />

      {/* Optional override. Most owners never touch this; auto-detect covers
          the common case, so it is framed as opt-in refinement, not setup. */}
      <p className="mb-2 mt-4 text-[12px] text-[var(--ds-text-muted)]">
        {t('agents.optionalPinASpecificParent') || 'Optional: pin a specific parent domain. Leave blank to detect it automatically.'}
      </p>

      <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2">
        <input
          type="text"
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value);
            if (inputError) setInputError('');
            markDirty();
          }}
          placeholder={t('agents.autoDetectEGExample') || 'Auto-detect (e.g. example.com)'}
          aria-label={t('agents.parentDomainForSessionSharing') || 'Parent domain for session sharing (optional override)'}
          className="w-full bg-transparent font-mono text-[12px] text-[var(--ds-text)] outline-none placeholder:text-[var(--ds-text-subtle)]"
        />
      </div>

      {inputError && (
        <p role="alert" className="mt-1.5 flex items-center gap-1 text-[11px] text-[var(--ds-danger)]">
          <AlertCircle size={12} aria-hidden="true" />
          {inputError}
        </p>
      )}

      {(canDetect || hasOverride) && (
        <div className="mt-2 flex items-center gap-4">
          {canDetect && websiteDomain && (
            <button
              type="button"
              onClick={detectFromWebsite}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-accent)] transition-opacity hover:opacity-80"
            >
              <Network size={13} aria-hidden="true" />
              {t('agents.useDomain', { domain: websiteDomain }) || `Use ${websiteDomain}`}
            </button>
          )}
          {hasOverride && (
            <button
              type="button"
              onClick={clearOverride}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-text-muted)] transition-opacity hover:opacity-80"
            >
              {t('agents.resetToAutomatic') || 'Reset to automatic'}
            </button>
          )}
        </div>
      )}

      {/* Reminder: continuity is not the same as appearance. The widget only
          renders on pages that actually load the embed snippet, so each
          subdomain needs it too. */}
      <div className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3 py-2.5">
        <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" />
        <p className="text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
          {/* One key for the whole paragraph. It emphasises three things inside
              itself, so splitting it into fragments bakes English clause order
              into the markup - and the codemod had already produced exactly
              that fragment ("This keeps the"). */}
          <Trans
            k="agents.subdomainSessionHint"
            fallback="This keeps the {conversation} going across your subdomains. It does not place the widget on them. For the chat to {appear} on a subdomain like {example}, add the same embed snippet (with this chatbot’s key) to that subdomain too. It is the copyable code up in the install steps above."
            values={{
              conversation: (
                <span className="font-medium text-[var(--ds-text)]">
                  {t('agents.conversationWord') || 'conversation'}
                </span>
              ),
              appear: (
                <span className="font-medium text-[var(--ds-text)]">
                  {t('agents.appearWord') || 'appear'}
                </span>
              ),
              example: (
                <code className="rounded bg-[var(--ds-bg-surface)] px-1 py-0.5 font-mono text-[11px]">
                  academy.{normalizedDomain || websiteDomain || 'example.com'}
                </code>
              ),
            }}
          />
        </p>
      </div>

      {/* Save row */}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving || !dirty} size="sm">
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {saved && !dirty && (
          <span className="flex items-center gap-1 text-[12px] text-[var(--ds-success)]">
            <ShieldCheck size={13} aria-hidden="true" />
            {t('agents.saved') || 'Saved'}
          </span>
        )}
        {saveError && (
          <span role="alert" className="flex items-center gap-1 text-[12px] text-[var(--ds-danger)]">
            <AlertCircle size={13} aria-hidden="true" />
            {saveError}
          </span>
        )}
      </div>
    </div>
  );
}
