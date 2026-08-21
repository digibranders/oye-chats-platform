import { memo, useMemo } from 'react';
import { Plus } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Input,
  SettingBand,
  SettingRow,
  TagInput,
} from '../../../ui';
import {
  MAX_DOMAINS,
  domainNotice,
  entriesForWebsite,
  normalizeDomain,
} from '../channels/deployModel';
import { sessionShareDomainError } from './behaviour.config';

export interface AccessSectionProps {
  /** The public address this chatbot is configured for, if any. */
  website: string | null;
  domains: readonly string[];
  domainCheckEnabled: boolean;
  /** A pinned cookie parent, or '' for auto-detect. */
  sessionShareDomain: string;
  onChange: (patch: {
    allowedDomains?: string[];
    domainCheckEnabled?: boolean;
    sessionShareDomain?: string;
  }) => void;
  disabled?: boolean;
}

/**
 * Where this chatbot is allowed to run: the origin allow-list, and the parent
 * domain a conversation follows a visitor across.
 *
 * **These moved here from Deploy.** They were the last three of eight
 * full-width cards on the install page, each with its own Save button, its own
 * `dirty`/`saved`/`error` state machine and its own inline success alert — three
 * hand-rolled save contracts on one page, none of them guarded against
 * navigating away mid-edit. Neither is an install step: the allow-list is a
 * security control over a public embed key, and the session parent is a cookie
 * scope. They belong with the chatbot's other settings, under this page's single
 * draft and single save bar.
 *
 * The allow-list guard survives the move and lives on the page's save action,
 * because of one exact asymmetry in the backend. It normalises a stored entry by
 * stripping `www.` (`normalize_domain_input`) but reads the browser's `Origin`
 * header **without** stripping it (`extract_hostname`). So a site served at
 * `www.acme.com` and an allow-list of `acme.com` do not match, and enforcement
 * rejects every request from the customer's own homepage. `*.acme.com` is the
 * only entry that admits it.
 *
 * The enable flag is a `Checkbox`, not a `Switch`: it is saved with the list, and
 * a switch means "this takes effect the moment you touch it".
 *
 * Session continuity is **already on**. With no value stored the widget detects
 * the registrable apex of whatever page it is running on and scopes the cookie
 * there, so it works with nothing configured. The field is an override for the
 * few owners who want to pin a specific parent — not a setup step. A wildcard is
 * rejected on purpose: the value becomes a cookie `Domain` attribute, which is a
 * single parent domain and cannot be a pattern.
 */
function AccessSectionInner({
  website,
  domains,
  domainCheckEnabled,
  sessionShareDomain,
  onChange,
  disabled = false,
}: AccessSectionProps) {
  const list = useMemo(() => [...domains], [domains]);

  const notice = useMemo(
    () => domainNotice({ website, domains: list, enabled: domainCheckEnabled }),
    [website, list, domainCheckEnabled],
  );

  const suggestions = useMemo(() => entriesForWebsite(website), [website]);
  const missing = suggestions.filter((entry) => !list.includes(entry));

  const websiteApex = useMemo(() => normalizeDomain(website ?? ''), [website]);
  const trimmed = sessionShareDomain.trim();
  const normalized = normalizeDomain(trimmed);
  // A wildcard is a legitimate allow-list entry and an illegitimate cookie
  // domain, so it gets its own message rather than the generic one.
  const sessionError = sessionShareDomainError(sessionShareDomain);
  const scope = normalized ?? websiteApex;

  // The reassuring reading of the allow-list is a state, not a warning: as an
  // `Alert` it was a bordered, tinted box inside the card restating in two
  // sentences what the checkbox under it and the chips beside it already showed.
  // It rides the row as a badge instead, and the band is kept for the three
  // readings that genuinely warn — off, empty, and locked out of your own site.
  const warning = notice.id !== 'ok';

  return (
    <>
      {warning ? (
        <SettingBand>
          <Alert tone={notice.tone} title={notice.title}>
            {notice.body}
          </Alert>
        </SettingBand>
      ) : null}

      <SettingRow
        label="Only allow the domains listed below"
        description="An empty list allows everything."
        badge={
          warning ? undefined : (
            <Badge tone="success" dot>
              {notice.title}
            </Badge>
          )
        }
        controlWidth="auto"
      >
        <Checkbox
          checked={domainCheckEnabled}
          disabled={disabled}
          onCheckedChange={(next) => onChange({ domainCheckEnabled: next === true })}
          aria-label="Only allow the domains listed below"
        />
      </SettingRow>

      <SettingRow
        label="Domains"
        description={`*.acme.com covers subdomains but not acme.com — most sites want both. Up to ${MAX_DOMAINS}.`}
        stacked
      >
        <div className="flex w-full flex-col gap-2">
          <TagInput
            values={list}
            onValuesChange={(next) => onChange({ allowedDomains: next })}
            label="Domains"
            placeholder="acme.com"
            maxValues={MAX_DOMAINS}
            disabled={disabled}
            // Normalise the way the backend will, so the chip the customer sees
            // is the value that actually gets stored — an entry typed as
            // `https://www.acme.com/pricing` is saved as `acme.com`, and showing
            // it any other way would be showing them a rule that is not the one
            // being enforced.
            normalize={(value) => normalizeDomain(value) ?? value.trim().toLowerCase()}
            validate={(value) =>
              normalizeDomain(value)
                ? null
                : `${value} is not a domain. Use a hostname like acme.com or *.acme.com.`
            }
          />
          {missing.length > 0 ? (
            <div>
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() =>
                  onChange({ allowedDomains: [...list, ...missing].slice(0, MAX_DOMAINS) })
                }
                iconLeft={<Plus aria-hidden />}
              >
                Add {missing.join(' and ')}
              </Button>
            </div>
          ) : null}
        </div>
      </SettingRow>

      <SettingRow
        label="Pin a parent domain"
        badge={<Badge tone="neutral">{trimmed ? `Pinned · ${trimmed}` : `Automatic${scope ? ` · ${scope}` : ''}`}</Badge>}
        description="Conversations follow visitors across your subdomains. One parent domain, no wildcard."
        stacked
        error={sessionError ?? undefined}
      >
        <Input
          value={sessionShareDomain}
          disabled={disabled}
          aria-label="Pin a parent domain"
          aria-invalid={sessionError ? true : undefined}
          onChange={(event) => onChange({ sessionShareDomain: event.target.value })}
          placeholder={
            websiteApex ? `Detected automatically (${websiteApex})` : 'Detected automatically'
          }
          className="figure max-w-sm"
          spellCheck={false}
          autoComplete="off"
        />
      </SettingRow>
    </>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree.
 */
export const AccessSection = memo(AccessSectionInner);
