import { normalizeUrl, validateUrl } from '../ui';

/**
 * The three legitimate ways to start.
 *
 * The wizard this replaces had exactly one — crawl a website — and could not
 * train a JavaScript-rendered site at all, while the real Knowledge page could.
 * A customer with no site, or a site behind a login, had no first run.
 */
export type FirstRunSource = 'website' | 'documents' | 'text';

export interface FirstRunDraft {
  name: string;
  source: FirstRunSource;
  website: string;
}

export interface FirstRunErrors {
  name?: string;
  website?: string;
}

/** The bare domain, for headings and for naming the chatbot. */
export function domainOf(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    return new URL(normalizeUrl(trimmed)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Suggest a name from the website, so the field is never an empty box on the
 * first screen of the product. `acme.com` becomes `Acme` — a name someone would
 * actually have typed, not `acme.com assistant`.
 */
export function suggestName(website: string, fallback: string): string {
  const domain = domainOf(website);
  if (!domain) return fallback;
  const label = domain.split('.')[0];
  if (!label) return fallback;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function validateFirstRun(draft: FirstRunDraft): FirstRunErrors {
  const errors: FirstRunErrors = {};
  if (!draft.name.trim()) {
    errors.name = 'Give your chatbot a name — you can change it later.';
  } else if (draft.name.trim().length > 60) {
    errors.name = 'That is longer than 60 characters. Something short works better in the widget.';
  }
  if (draft.source === 'website') {
    const website = draft.website.trim();
    if (!website) {
      errors.website = 'Enter the address of the site it should learn from.';
    } else if (validateUrl(website) !== null) {
      errors.website = 'That does not look like a web address. Try something like example.com.';
    }
  }
  return errors;
}

export function hasErrors(errors: FirstRunErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/**
 * How far a crawl has got, as a fraction.
 *
 * Returns `null` — an *indeterminate* bar — rather than a fake number whenever
 * the total is unknown, which it is for the first several seconds of every
 * crawl. In this design language progress is motion, and a bar that jumps from
 * 0 to 100 because the denominator arrived late is worse than one that simply
 * says "working".
 */
export function crawlFraction(crawled: number | undefined, total: number | undefined): number | null {
  if (!total || total <= 0) return null;
  const done = Math.max(0, crawled ?? 0);
  return Math.min(100, Math.round((done / total) * 100));
}

/** Terminal crawl states, so the UI stops polling and says what happened. */
export function isCrawlFinished(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
