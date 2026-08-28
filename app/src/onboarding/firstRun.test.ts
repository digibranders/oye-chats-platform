import { describe, expect, it } from 'vitest';
import {
  crawlFraction,
  domainOf,
  hasErrors,
  isCrawlFinished,
  suggestName,
  validateFirstRun,
  type FirstRunDraft,
} from './firstRun';

function draft(overrides: Partial<FirstRunDraft> = {}): FirstRunDraft {
  return { name: 'Support', source: 'website', website: 'example.com', ...overrides };
}

describe('domainOf', () => {
  it('accepts a bare host and strips www', () => {
    expect(domainOf('example.com')).toBe('example.com');
    expect(domainOf('https://www.example.com/pricing')).toBe('example.com');
  });

  it('returns nothing rather than throwing on junk', () => {
    expect(domainOf('not a url')).toBe('');
    expect(domainOf('')).toBe('');
  });
});

describe('suggestName', () => {
  it('names the chatbot after the business, not after the URL', () => {
    expect(suggestName('https://acme.com', 'My chatbot')).toBe('Acme');
    expect(suggestName('www.northwind.co.uk', 'My chatbot')).toBe('Northwind');
  });

  it('falls back when there is no usable website', () => {
    expect(suggestName('', 'Northwind Traders')).toBe('Northwind Traders');
    expect(suggestName('???', 'Northwind Traders')).toBe('Northwind Traders');
  });
});

describe('validateFirstRun', () => {
  it('accepts a website start', () => {
    expect(hasErrors(validateFirstRun(draft()))).toBe(false);
  });

  it('requires a name, and says what to do about it', () => {
    const errors = validateFirstRun(draft({ name: '   ' }));
    expect(errors.name).toMatch(/name/i);
  });

  it('only demands a website when the website is the source', () => {
    expect(validateFirstRun(draft({ website: '' })).website).toBeTruthy();
    // Upload-only and paste-text are legitimate first runs; the wizard this
    // replaces had no path at all for a customer without a crawlable site.
    expect(validateFirstRun(draft({ source: 'documents', website: '' })).website).toBeUndefined();
    expect(validateFirstRun(draft({ source: 'text', website: '' })).website).toBeUndefined();
  });

  it('rejects something that is not an address', () => {
    expect(validateFirstRun(draft({ website: 'my company' })).website).toBeTruthy();
  });
});

describe('crawlFraction', () => {
  it('is indeterminate until the total is genuinely known', () => {
    // The denominator arrives seconds after the crawl starts. A bar that jumps
    // 0 → 100 when it lands is worse than one that says it is working.
    expect(crawlFraction(0, undefined)).toBeNull();
    expect(crawlFraction(4, 0)).toBeNull();
  });

  it('reports a percentage once both numbers exist, and never exceeds 100', () => {
    expect(crawlFraction(5, 20)).toBe(25);
    expect(crawlFraction(25, 20)).toBe(100);
    expect(crawlFraction(undefined, 20)).toBe(0);
  });
});

describe('isCrawlFinished', () => {
  it('stops the poll on every terminal state, not only success', () => {
    expect(isCrawlFinished('done')).toBe(true);
    expect(isCrawlFinished('no_content')).toBe(true);
    expect(isCrawlFinished('failed')).toBe(true);
    expect(isCrawlFinished('cancelled')).toBe(true);
  });

  it('keeps polling while the crawl is still moving', () => {
    expect(isCrawlFinished('idle')).toBe(false);
    expect(isCrawlFinished('running')).toBe(false);
    expect(isCrawlFinished('cancelling')).toBe(false);
    expect(isCrawlFinished(undefined)).toBe(false);
  });
});
