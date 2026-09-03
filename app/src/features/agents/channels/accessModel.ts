import { normalizeDomain } from './deployModel';
import { t as translateNow } from '../../../i18n/i18n';

/**
 * Access — the three `Bot` columns that decide **where** this chatbot may run.
 *
 * | Draft field | Column | Contract |
 * |---|---|---|
 * | `allowedDomains` | `allowed_domains` | list of hostnames, normalised |
 * | `domainCheckEnabled` | `domain_check_enabled` | bool |
 * | `sessionShareDomain` | `session_share_domain` | one parent domain, no wildcard |
 *
 * These lived on Behaviour for one release. They are back on Deploy because
 * that is where a customer looks when the widget will not appear on their site,
 * and the allow-list is the most common reason it does not. What made them wrong
 * on the *old* Deploy was never the page: it was that each card carried its own
 * hand-rolled Save button and its own unguarded dirty state. They are under a
 * single draft and a single save bar here, the same contract Behaviour uses.
 *
 * The model is its own file, separate from `deployModel`, because that module is
 * pure presentation logic over a chatbot that is already loaded, and this one
 * describes an editable draft and the PATCH body it produces.
 */
export interface AccessDraft {
  /** Origins allowed to embed this chatbot. Empty allows everything. */
  allowedDomains: string[];
  /** Whether the allow-list is enforced at all. */
  domainCheckEnabled: boolean;
  /** A pinned cookie parent for session continuity. Empty = auto-detect. */
  sessionShareDomain: string;
}

/** Narrow the loosely-typed `GET /bots/{id}` payload into an Access draft. */
export function parseAccess(raw: Record<string, unknown>): AccessDraft {
  return {
    allowedDomains: Array.isArray(raw.allowed_domains)
      ? raw.allowed_domains.filter((entry): entry is string => typeof entry === 'string')
      : [],
    domainCheckEnabled: raw.domain_check_enabled === true,
    sessionShareDomain:
      typeof raw.session_share_domain === 'string' ? raw.session_share_domain.trim() : '',
  };
}

/**
 * The PATCH body for an Access draft.
 *
 * A pure function rather than an inline literal in the save handler, so a test
 * can assert the whole payload. The dangerous direction of a dropped field here
 * is writing a wrong value, not failing to write one: this is a security
 * control over a public embed key.
 */
export function toAccessPayload(draft: AccessDraft): Record<string, unknown> {
  const trimmed = draft.sessionShareDomain.trim();
  return {
    allowed_domains: draft.allowedDomains,
    domain_check_enabled: draft.domainCheckEnabled,
    // An empty string clears the override server-side and returns the widget to
    // auto-detect. Continuity itself never turns off.
    session_share_domain: trimmed ? (normalizeDomain(trimmed) ?? trimmed) : '',
  };
}

/**
 * Why a pinned parent cannot be saved, in the customer's terms.
 *
 * The backend raises on a wildcard (`_normalize_session_share_domain`) because
 * the value becomes a cookie `Domain`, which is one parent and not a pattern. It
 * is said here rather than surfaced as a 422.
 */
export function sessionShareDomainError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('*.')) {
    return translateNow('agents.aWildcardWillNotWork') || 'A wildcard will not work here. Use the parent domain on its own, e.g. acme.com.';
  }
  if (!normalizeDomain(trimmed)) return translateNow('agents.thatIsNotADomain') || 'That is not a domain. Use a hostname like acme.com.';
  return null;
}

/** True when the access slice differs, so an untouched allow-list is not rewritten. */
export function accessChanged(next: AccessDraft, previous: AccessDraft): boolean {
  return (
    next.domainCheckEnabled !== previous.domainCheckEnabled ||
    next.sessionShareDomain !== previous.sessionShareDomain ||
    next.allowedDomains.length !== previous.allowedDomains.length ||
    next.allowedDomains.some((entry, index) => entry !== previous.allowedDomains[index])
  );
}
