/**
 * DomainRestrictionsSection — locks the widget to an allow-list of domains.
 *
 * Rebuilt from the orphaned legacy `components/DomainRestrictions.jsx` (which
 * had no route into Admin 2.0, leaving a security control unreachable). Governs
 * the backend `allowed_domains` + `domain_check_enabled` fields via `updateBot`;
 * lives inside the Website channel card, directly beneath the embed snippet,
 * because it decides WHO may embed that snippet.
 *
 * Mount with `key={botId}` so switching agents reseeds from fresh props without
 * a sync effect. On save it re-reads the bot to display the server-normalized
 * domains and merges the result back into the parent record via `onSaved`.
 */
import { useMemo, useState, type KeyboardEvent, type ReactElement } from 'react';
import { AlertCircle, Globe, Shield, ShieldCheck, ShieldOff, Sparkles, X } from 'lucide-react';
import { Button, cn } from '../../../design-system';
import { InsightCard } from '../../../design-system/components/InsightCard';
import { getBot, updateBot } from '../../../services/api';

const MAX_DOMAINS = 50;

export interface DomainRestrictionsSectionProps {
  botId: number;
  website?: string | null;
  initialAllowedDomains: string[];
  initialDomainCheckEnabled: boolean;
  /** Merge the saved values back into the parent's cached bot record. */
  onSaved: (next: { allowed_domains: string[]; domain_check_enabled: boolean }) => void;
}

/**
 * Strip scheme/path/port/leading-www from free-form input so the stored chip
 * matches what the backend persists. Returns null for inputs that can't be a
 * domain, so the caller can surface an error before hitting the API.
 */
function normalizeDomain(input: string): string | null {
  let value = String(input || '').trim().toLowerCase();
  if (!value) return null;

  let wildcard = false;
  if (value.startsWith('*.')) {
    wildcard = true;
    value = value.slice(2);
  }
  value = value.replace(/^https?:\/\//, '');
  value = value.split('/')[0];
  value = value.split(':')[0];
  if (value.startsWith('www.')) value = value.slice(4);
  if (!value) return null;
  if (value === 'localhost' || value === '127.0.0.1') return value;

  const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (!hostnamePattern.test(value)) return null;
  return wildcard ? `*.${value}` : value;
}

/** Turn the saved website into apex + wildcard so "Detect" can pre-fill. */
function deriveFromWebsite(website: string | null | undefined): string[] {
  const apex = normalizeDomain(website || '');
  if (!apex) return [];
  if (apex.startsWith('*.') || apex === 'localhost' || apex === '127.0.0.1') return [apex];
  return [apex, `*.${apex}`];
}

export function DomainRestrictionsSection({
  botId,
  website,
  initialAllowedDomains,
  initialDomainCheckEnabled,
  onSaved,
}: DomainRestrictionsSectionProps): ReactElement {
  const [domains, setDomains] = useState<string[]>(initialAllowedDomains || []);
  const [enabled, setEnabled] = useState<boolean>(Boolean(initialDomainCheckEnabled));
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const status = useMemo(() => {
    if (!enabled) {
      return {
        tone: 'warning' as const,
        icon: ShieldOff,
        title: 'Your widget is unprotected',
        body: 'Anyone with your embed key can load the widget on any site. Turn this on to lock it down.',
      };
    }
    if (domains.length === 0) {
      return {
        tone: 'danger' as const,
        icon: AlertCircle,
        title: 'Widget will be blocked everywhere',
        body: 'Domain restriction is on but no domains are listed. Add at least one, or the widget won’t load anywhere.',
      };
    }
    return {
      tone: 'success' as const,
      icon: ShieldCheck,
      title: `Widget locked to ${domains.length} domain${domains.length === 1 ? '' : 's'}`,
      body: 'Requests from any other site are rejected.',
    };
  }, [enabled, domains]);

  const websiteSuggestions = useMemo(() => deriveFromWebsite(website), [website]);
  const canDetect = websiteSuggestions.some((d) => !domains.includes(d));

  const markDirty = (): void => {
    setDirty(true);
    setSaved(false);
    setSaveError('');
  };

  const tryAdd = (raw: string): boolean => {
    const normalized = normalizeDomain(raw);
    if (!normalized) {
      setDraftError('Enter a valid domain like acme.com or *.acme.com');
      return false;
    }
    if (domains.includes(normalized)) {
      setDraftError('Already added');
      return false;
    }
    if (domains.length >= MAX_DOMAINS) {
      setDraftError(`Maximum ${MAX_DOMAINS} domains`);
      return false;
    }
    setDomains((prev) => [...prev, normalized]);
    setDraftError('');
    markDirty();
    return true;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (tryAdd(draft)) setDraft('');
    } else if (e.key === 'Backspace' && draft === '' && domains.length > 0) {
      setDomains((prev) => prev.slice(0, -1));
      markDirty();
    }
  };

  const removeDomain = (target: string): void => {
    setDomains((prev) => prev.filter((d) => d !== target));
    markDirty();
  };

  const detectFromWebsite = (): void => {
    setDomains((prev) => {
      const merged = [...prev];
      for (const suggestion of websiteSuggestions) {
        if (!merged.includes(suggestion) && merged.length < MAX_DOMAINS) merged.push(suggestion);
      }
      return merged;
    });
    if (!enabled) setEnabled(true);
    markDirty();
  };

  const toggleEnabled = (): void => {
    setEnabled((prev) => !prev);
    markDirty();
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await updateBot(botId, { allowed_domains: domains, domain_check_enabled: enabled });
      // Re-read so we show the server-normalized values (and stay in sync).
      let nextDomains = domains;
      let nextEnabled = enabled;
      try {
        const fresh = (await getBot(botId)) as {
          allowed_domains?: string[] | null;
          domain_check_enabled?: boolean | null;
        };
        nextDomains = fresh.allowed_domains ?? [];
        nextEnabled = Boolean(fresh.domain_check_enabled);
        setDomains(nextDomains);
        setEnabled(nextEnabled);
      } catch {
        /* keep the optimistic values if the reload fails */
      }
      onSaved({ allowed_domains: nextDomains, domain_check_enabled: nextEnabled });
      setDirty(false);
      setSaved(true);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save domain restrictions.');
    } finally {
      setSaving(false);
    }
  };

  const StatusIcon = status.icon;

  return (
    <div className="mt-6 border-t border-[var(--ds-border)] pt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--ds-text)]">
          <Shield size={14} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
          Allowed domains
        </span>
        <button
          type="button"
          onClick={toggleEnabled}
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle domain restriction"
          className={cn(
            'rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
            'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
            enabled
              ? 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
              : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]',
          )}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>

      <InsightCard tone={status.tone} icon={StatusIcon} title={status.title} body={status.body} />

      <p className="mb-3 mt-4 text-[12px] text-[var(--ds-text-muted)]">
        Lock the widget to the sites below. Prefix an entry with{' '}
        <code className="rounded bg-[var(--ds-bg-sunken)] px-1 py-0.5 font-mono text-[11px]">*.</code> to include
        every subdomain (e.g. <code className="font-mono text-[11px]">*.acme.com</code> covers www, blog, shop).
      </p>

      {/* Chip field */}
      <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {domains.map((domain) => (
            <span
              key={domain}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--ds-bg-sunken)] px-2 py-1 font-mono text-[12px] text-[var(--ds-text)]"
            >
              <Globe size={11} aria-hidden="true" className="text-[var(--ds-accent)]" />
              {domain}
              <button
                type="button"
                onClick={() => removeDomain(domain)}
                aria-label={`Remove ${domain}`}
                className="text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-danger)]"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <input
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (draftError) setDraftError('');
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (draft.trim() && tryAdd(draft)) setDraft('');
            }}
            placeholder={domains.length ? 'Add another…' : 'acme.com'}
            aria-label="Add a domain"
            className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 font-mono text-[12px] text-[var(--ds-text)] outline-none placeholder:text-[var(--ds-text-subtle)]"
          />
        </div>
      </div>

      {draftError && (
        <p role="alert" className="mt-1.5 flex items-center gap-1 text-[11px] text-[var(--ds-danger)]">
          <AlertCircle size={12} aria-hidden="true" />
          {draftError}
        </p>
      )}

      {canDetect && (
        <button
          type="button"
          onClick={detectFromWebsite}
          className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-accent)] transition-opacity hover:opacity-80"
        >
          <Sparkles size={13} aria-hidden="true" />
          Detect from {website ? website.replace(/^https?:\/\//, '').split('/')[0] : 'my website'}
        </button>
      )}

      {/* Save row */}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving || !dirty} size="sm">
          {saving ? 'Saving…' : 'Save domains'}
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
