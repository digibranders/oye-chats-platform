import { describe, expect, it } from 'vitest';
import { describeDomain, sortDomains, summariseDomains, type DomainInstall } from './installDomainsModel';

/**
 * The wording a customer acts on.
 *
 * Every row here is a sentence that sends someone somewhere, so the ones that
 * must not be confused with each other are pinned individually: "we looked and
 * it is not there" versus "we could not look", and "your snippet is missing"
 * versus "this page is running a different chatbot". Sending someone to
 * re-paste a snippet that is already correct is the failure this guards.
 */
function domain(over: Partial<DomainInstall> = {}): DomainInstall {
  return {
    hostname: 'acme.com',
    state: 'unchecked',
    observed_first_at: null,
    observed_last_at: null,
    probe_status: null,
    probe_checked_at: null,
    probe_detail: null,
    other_chatbot: null,
    allowed: true,
    ...over,
  };
}

describe('describeDomain', () => {
  it('calls a live domain live and asks nothing of the customer', () => {
    const result = describeDomain(domain({ state: 'live', observed_last_at: '2026-08-31T10:00:00Z' }));
    expect(result.tone).toBe('success');
    expect(result.needsAttention).toBe(false);
  });

  it('flags a live domain that the allow-list would block', () => {
    // The most useful line the card can produce: it works right now and stops
    // the moment domain restriction is switched on. Nothing else surfaces it.
    const result = describeDomain(
      domain({ state: 'live', observed_last_at: '2026-08-31T10:00:00Z', allowed: false }),
    );
    expect(result.needsAttention).toBe(true);
    expect(result.tone).toBe('warning');
    expect(result.label.toLowerCase()).toContain('allow-list');
  });

  it('separates a confirmed snippet from a live one', () => {
    // 'installed' means our own fetch found the snippet and no visitor has been
    // here. Reporting that as 'live' would claim traffic that does not exist.
    const result = describeDomain(domain({ state: 'installed', probe_status: 'installed' }));
    expect(result.tone).toBe('success');
    expect(result.needsAttention).toBe(false);
    expect(result.detail).toContain('No visitor');
  });

  it('explains an OyeChats-owned domain rather than reporting it as untouched', () => {
    // www.oyechats.com runs the widget, so it probes as installed and its
    // heartbeat is refused on purpose: our own traffic must never tick a
    // customer's setup step. Saying "no visitor has opened the chatbot here
    // yet" to somebody who just opened it themselves is what got this
    // reported as a bug against a mechanism working as designed.
    const result = describeDomain(
      domain({ hostname: 'www.oyechats.com', state: 'installed', probe_status: 'installed', counts_as_install: false }),
    );
    expect(result.tone).toBe('success');
    expect(result.needsAttention).toBe(false);
    expect(result.detail).not.toContain('No visitor');
    expect(result.detail).toContain('OyeChats-owned');
  });

  it('keeps the ordinary wording when the flag is absent', () => {
    // An older API build sends no flag. Defaulting to the OWN-domain wording
    // would tell every customer their real install does not count.
    const result = describeDomain(domain({ state: 'installed', probe_status: 'installed' }));
    expect(result.detail).toContain('No visitor');
  });

  it('says a different chatbot is there rather than saying the snippet is missing', () => {
    const result = describeDomain(
      domain({ state: 'missing', probe_status: 'foreign', other_chatbot: 'bot-000000000000' }),
    );
    expect(result.needsAttention).toBe(true);
    expect(result.label.toLowerCase()).toContain('different');
    // The customer's snippet is not the thing to go and fix here.
    expect(result.detail.toLowerCase()).not.toContain('not in it');
  });

  it('reports an absent snippet as something to fix', () => {
    const result = describeDomain(domain({ state: 'missing', probe_status: 'missing' }));
    expect(result.needsAttention).toBe(true);
    expect(result.tone).toBe('warning');
  });

  it('does not blame the customer when WE could not reach the site', () => {
    // A login wall, a firewall, or bot protection. Our failure to look is not
    // evidence of their broken install, and painting it amber next to a real
    // fault teaches people to ignore the colour.
    const result = describeDomain(domain({ state: 'unreachable', probe_status: 'unreachable' }));
    expect(result.needsAttention).toBe(false);
    expect(result.tone).toBe('neutral');
  });

  it('prefers the probe’s own explanation over the generic one', () => {
    const result = describeDomain(
      domain({ state: 'missing', probe_status: 'missing', probe_detail: 'The page loaded (HTTP 200) but no OyeChats snippet was in it.' }),
    );
    expect(result.detail).toContain('HTTP 200');
  });

  it('treats an allow-listed domain nobody has touched as neutral, not broken', () => {
    const result = describeDomain(domain({ state: 'unchecked' }));
    expect(result.tone).toBe('neutral');
    expect(result.needsAttention).toBe(false);
  });
});

describe('sortDomains', () => {
  it('puts what needs a decision first', () => {
    const sorted = sortDomains([
      domain({ hostname: 'zzz.com', state: 'live', observed_last_at: 'x' }),
      domain({ hostname: 'broken.com', state: 'missing', probe_status: 'missing' }),
      domain({ hostname: 'aaa.com', state: 'live', observed_last_at: 'x' }),
    ]);
    expect(sorted.map((d) => d.hostname)).toEqual(['broken.com', 'aaa.com', 'zzz.com']);
  });

  it('does not mutate what it was given', () => {
    const input = [domain({ hostname: 'b.com' }), domain({ hostname: 'a.com' })];
    sortDomains(input);
    expect(input.map((d) => d.hostname)).toEqual(['b.com', 'a.com']);
  });
});

describe('summariseDomains', () => {
  it('counts problems when there are any', () => {
    const text = summariseDomains([
      domain({ hostname: 'a.com', state: 'live', observed_last_at: 'x' }),
      domain({ hostname: 'b.com', state: 'missing', probe_status: 'missing' }),
    ]);
    expect(text).toContain('1');
    expect(text.toLowerCase()).toContain('attention');
  });

  it('says everything is working when it is', () => {
    const text = summariseDomains([
      domain({ hostname: 'a.com', state: 'live', observed_last_at: 'x' }),
      domain({ hostname: 'b.com', state: 'installed', probe_status: 'installed' }),
    ]);
    expect(text.toLowerCase()).toContain('all');
  });

  it('handles having no domains at all', () => {
    expect(summariseDomains([])).toBeTruthy();
  });
});
