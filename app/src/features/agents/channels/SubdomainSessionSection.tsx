/**
 * SubdomainSessionSection - opt-in cross-subdomain conversation continuity.
 *
 * A visitor's chat session lives in the widget's `localStorage`, which the
 * browser partitions per origin - so a conversation started on `example.com`
 * would restart on `academy.example.com`. When a parent domain is set here, the
 * widget mirrors the session id into a cookie scoped to that domain
 * (`Domain=.example.com`), which every subdomain can read, so the same
 * conversation continues across `*.example.com`.
 *
 * Governs the backend `session_share_domain` field via `updateBot`. Empty =
 * disabled (default). Lives in the Website channel card, beneath the domain
 * allow-list, because both concern how the embed behaves across a customer's
 * domains. Mount with `key={botId}` so switching agents reseeds from props.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { AlertCircle, Info, Link2, Network, ShieldCheck } from 'lucide-react';
import { Button } from '../../../design-system';
import { InsightCard } from '../../../design-system/components/InsightCard';
import { getBot, updateBot } from '../../../services/api';

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
  const seededDomain = (initialShareDomain || '').trim();
  const [enabled, setEnabled] = useState<boolean>(Boolean(seededDomain));
  const [domain, setDomain] = useState<string>(seededDomain);
  const [inputError, setInputError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const websiteDomain = useMemo(() => normalizeParentDomain(website || ''), [website]);
  const normalizedDomain = useMemo(() => normalizeParentDomain(domain), [domain]);

  const status = useMemo(() => {
    if (!enabled) {
      return {
        tone: 'info' as const,
        icon: Network,
        title: 'Conversations stay on one site',
        body: 'A chat started on one subdomain restarts if the visitor moves to another. Turn this on to carry it across all your subdomains.',
      };
    }
    if (!normalizedDomain) {
      return {
        tone: 'warning' as const,
        icon: AlertCircle,
        title: 'Add your domain to finish',
        body: 'Enter your parent domain (e.g. example.com) so the conversation can follow visitors across its subdomains.',
      };
    }
    return {
      tone: 'success' as const,
      icon: ShieldCheck,
      title: `Conversations continue across *.${normalizedDomain}`,
      body: `A chat started on ${normalizedDomain} keeps going on every subdomain, like app.${normalizedDomain} or academy.${normalizedDomain}.`,
    };
  }, [enabled, normalizedDomain]);

  const markDirty = (): void => {
    setDirty(true);
    setSaved(false);
    setSaveError('');
  };

  const toggleEnabled = (): void => {
    setEnabled((prev) => {
      const next = !prev;
      // Turning on with an empty field: prefill from the saved website so the
      // common case is one click.
      if (next && !domain.trim() && websiteDomain) {
        setDomain(websiteDomain);
        setInputError('');
      }
      return next;
    });
    markDirty();
  };

  const detectFromWebsite = (): void => {
    if (!websiteDomain) return;
    setDomain(websiteDomain);
    setInputError('');
    if (!enabled) setEnabled(true);
    markDirty();
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    // Validate before hitting the API so the error is immediate and local.
    if (enabled) {
      const normalized = normalizeParentDomain(domain);
      if (!normalized) {
        setInputError('Enter a valid domain like example.com');
        return;
      }
    }
    setInputError('');
    setSaving(true);
    setSaveError('');
    // Empty string clears the field server-side (disables sharing).
    const payload = enabled ? (normalizeParentDomain(domain) as string) : '';
    try {
      await updateBot(botId, { session_share_domain: payload });
      // Re-read so we reflect the server-normalized value and stay in sync.
      let nextDomain: string | null = payload || null;
      try {
        const fresh = (await getBot(botId)) as { session_share_domain?: string | null };
        nextDomain = fresh.session_share_domain ?? null;
        setDomain(nextDomain || '');
        setEnabled(Boolean(nextDomain));
      } catch {
        /* keep the optimistic value if the reload fails */
      }
      onSaved({ session_share_domain: nextDomain });
      setDirty(false);
      setSaved(true);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save session sharing.');
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
          Continue sessions across subdomains
        </span>
        <button
          type="button"
          onClick={toggleEnabled}
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle cross-subdomain session sharing"
          className={
            'rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ' +
            'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] ' +
            (enabled
              ? 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
              : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]')
          }
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>

      <InsightCard tone={status.tone} icon={StatusIcon} title={status.title} body={status.body} />

      {enabled && (
        <>
          <p className="mb-2 mt-4 text-[12px] text-[var(--ds-text-muted)]">
            Enter the parent domain your subdomains share (e.g. example.com).
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
              placeholder="example.com"
              aria-label="Parent domain for session sharing"
              className="w-full bg-transparent font-mono text-[12px] text-[var(--ds-text)] outline-none placeholder:text-[var(--ds-text-subtle)]"
            />
          </div>

          {inputError && (
            <p role="alert" className="mt-1.5 flex items-center gap-1 text-[11px] text-[var(--ds-danger)]">
              <AlertCircle size={12} aria-hidden="true" />
              {inputError}
            </p>
          )}

          {canDetect && websiteDomain && (
            <button
              type="button"
              onClick={detectFromWebsite}
              className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-accent)] transition-opacity hover:opacity-80"
            >
              <Network size={13} aria-hidden="true" />
              Use {websiteDomain}
            </button>
          )}

          {/* Reminder: continuity ≠ appearance. The widget only renders on pages
              that actually load the embed snippet, so each subdomain needs it too. */}
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3 py-2.5">
            <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" />
            <p className="text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
              This keeps the <span className="font-medium text-[var(--ds-text)]">conversation</span> going across
              your subdomains — it doesn’t place the widget on them. For the chat to{' '}
              <span className="font-medium text-[var(--ds-text)]">appear</span> on a subdomain like{' '}
              <code className="rounded bg-[var(--ds-bg-surface)] px-1 py-0.5 font-mono text-[11px]">
                academy.{normalizedDomain || 'example.com'}
              </code>
              , add the same embed snippet (with this agent’s key) to that subdomain too — it’s the copyable code
              up in the install steps above.
            </p>
          </div>
        </>
      )}

      {/* Save row */}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving || !dirty} size="sm">
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {saved && !dirty && (
          <span className="flex items-center gap-1 text-[12px] text-[var(--ds-success)]">
            <ShieldCheck size={13} aria-hidden="true" />
            Saved
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
