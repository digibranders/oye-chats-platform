import { describe, expect, it } from 'vitest';
import type { Lead } from '../../types/domain';
import {
  UNKNOWN_LOCATION,
  companyDisplay,
  compareLeads,
  dimensionMax,
  formatLocation,
  hasIntelligence,
  orderedDimensions,
  readLeadStats,
  refineLeads,
} from './leadModel';

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    session_id: 's1',
    tier: 'unqualified',
    status: 'unqualified',
    score: 10,
    contact: null,
    ...overrides,
  } as Lead;
}

/**
 * `ChatSession.location` is stored as `"<City>, <Country> | <IP>"`, or the raw
 * `"IP: <addr>"` stamp written before geolocation resolves. A visitor's IP is
 * personal data under GDPR and the DPDP Act, so it must never reach the
 * dashboard — the table used to print the stored string verbatim, putting raw
 * IPv6 addresses on screen.
 */
describe('formatLocation', () => {
  it('strips the IPv6 address the backend appends', () => {
    expect(formatLocation('Mumbai, India | 2401:4900:88b1:7265:cdd1:3f28:b37:8f91')).toBe(
      'Mumbai, India',
    );
  });

  it('strips an IPv4 address', () => {
    expect(formatLocation('Bengaluru, India | 103.21.244.12')).toBe('Bengaluru, India');
  });

  it('never leaks an IP even with unexpected spacing', () => {
    expect(formatLocation('Pune, India|1.2.3.4')).toBe('Pune, India');
  });

  it('treats the raw pre-geolocation stamp as unknown', () => {
    // Written by the request handler before the background resolver replaces
    // it. It carries no geography at all, so showing it is strictly worse than
    // saying nothing.
    expect(formatLocation('IP: 103.21.244.12')).toBe(UNKNOWN_LOCATION);
  });

  it('is idempotent, so a second pass over a redacted value is a no-op', () => {
    // The server already redacts at its serialisation boundary. This one runs
    // again on the way to the CSV, and the two must not fight.
    expect(formatLocation(formatLocation('Pune, India | 1.2.3.4'))).toBe('Pune, India');
  });
});

describe('companyDisplay', () => {
  it('keeps the domain beneath a resolved name rather than replacing it', () => {
    // Rendering only `company_name` blanks the company row for every lower plan
    // and every domain the paid lookup could not resolve.
    expect(companyDisplay({ company: 'infosys.com', company_name: 'Infosys Limited' })).toEqual({
      value: 'Infosys Limited',
      secondary: 'infosys.com',
    });
  });

  it('falls back to the bare domain', () => {
    expect(companyDisplay({ company: 'infosys.com' })).toEqual({ value: 'infosys.com' });
  });

  it('answers nothing for a personal address', () => {
    expect(companyDisplay({ email: 'priya@gmail.com' })).toBeNull();
  });
});

/**
 * Absence and zero are different facts. Free workspaces get `{total, unread}`
 * only — the tier counts are not computed at all — so a zero here would tell
 * them they have no qualified leads rather than that they cannot see them.
 */
describe('readLeadStats', () => {
  it('reads the BANT keys', () => {
    const stats = readLeadStats({ total: 12, unqualified: 5, mql: 4, sal: 2, sql: 1, avg_score: 41, unread: 3 });
    expect(stats.total).toBe(12);
    expect(stats.qualified).toBe(7);
    expect(stats.avgScore).toBe(41);
    expect(stats.unread).toBe(3);
  });

  it('accepts the legacy cold/warm/hot/qualified aliases', () => {
    const stats = readLeadStats({ total: 6, cold: 3, warm: 2, hot: 1, qualified: 0 });
    expect(stats.unqualified).toBe(3);
    expect(stats.qualified).toBe(3);
  });

  it('leaves the tier counts undefined when the plan omits them', () => {
    const stats = readLeadStats({ total: 9, unread: 2 });
    expect(stats.total).toBe(9);
    expect(stats.unread).toBe(2);
    expect(stats.qualified).toBeUndefined();
    expect(stats.avgScore).toBeUndefined();
  });
});

/**
 * The Free plan's payload has score, tier, BANT and location *deleted*, not
 * nulled. Reading the lock off the response rather than off a plan slug is what
 * stops the table claiming a lock the API did not apply.
 */
describe('hasIntelligence', () => {
  it('is true for a scored lead', () => {
    expect(hasIntelligence(lead())).toBe(true);
  });

  it('is false when the server stripped the layer', () => {
    const free = { session_id: 's2', contact: null } as unknown as Lead;
    expect(hasIntelligence(free)).toBe(false);
  });
});

describe('orderedDimensions', () => {
  it('reorders a framework\'s own order into B-A-N-T', () => {
    // The backend emits need/timeline/authority/budget. Read left to right, the
    // chips have to spell the acronym the operator already knows.
    const dimensions = orderedDimensions({
      bant: {
        need: { value: 'Reduce support load', score: 20 },
        timeline: { value: null, score: 0 },
        authority: { value: 'Head of CX', score: 15 },
        budget: { value: null, score: 0 },
      },
    });
    expect(dimensions.map((dimension) => dimension.key)).toEqual([
      'budget',
      'authority',
      'need',
      'timeline',
    ]);
  });

  it('sorts non-BANT dimensions after the four, keeping their own order', () => {
    const dimensions = orderedDimensions({
      bant: {
        metrics: { value: null, score: 0 },
        economic_buyer: { value: null, score: 0 },
        budget: { value: null, score: 5 },
      },
    });
    expect(dimensions.map((dimension) => dimension.key)).toEqual([
      'budget',
      'metrics',
      'economic_buyer',
    ]);
  });

  it('gives every dimension a real word, never an initial', () => {
    const [dimension] = orderedDimensions({ bant: { economic_buyer: { value: null, score: 0 } } });
    expect(dimension.label).toBe('Economic buyer');
  });

  it('marks a dimension captured only once it has scored', () => {
    const dimensions = orderedDimensions({
      bant: { budget: { value: 'Approved', score: 20 }, need: { value: null, score: 0 } },
    });
    expect(dimensions[0].captured).toBe(true);
    expect(dimensions[1].captured).toBe(false);
  });
});

/**
 * A denominator this screen does not have is not a denominator it may invent.
 *
 * Two earlier versions did. One floored the ceiling to the lead's own highest
 * score, so two leads on the same chatbot read "18 / 25" and "30 / 30". The
 * next used `round(100 / dimensionCount)`, which assumes the 100 is shared
 * equally and it is not: MEDDIC has six dimensions weighted 17 and a top option
 * worth 21, so a top-scoring lead read "21/17". The lead payload carries only
 * `{value, score}` per dimension, so the honest answer is `null`.
 */
describe('dimensionMax', () => {
  it('is null for the payload the API actually sends', () => {
    expect(dimensionMax({ value: 'Approved', score: 21 })).toBeNull();
  });

  it('is null rather than a guess when the count is all we know', () => {
    const dimensions = orderedDimensions({
      bant: {
        metrics: { value: null, score: 21 },
        economic_buyer: { value: null, score: 17 },
      },
    });
    expect(dimensions.map((dimension) => dimension.max)).toEqual([null, null]);
  });

  it('uses a real ceiling the moment the payload states one', () => {
    expect(dimensionMax({ max: 21 })).toBe(21);
    const [dimension] = orderedDimensions({
      bant: { metrics: { value: null, score: 21, max: 21 } },
    } as Parameters<typeof orderedDimensions>[0]);
    expect(dimension.max).toBe(21);
  });

  it('refuses a ceiling that could not be one', () => {
    expect(dimensionMax({ max: 0 })).toBeNull();
    expect(dimensionMax({ max: -4 })).toBeNull();
    expect(dimensionMax({ max: 'seventeen' })).toBeNull();
    expect(dimensionMax(null)).toBeNull();
  });
});

describe('refineLeads', () => {
  const priya = lead({
    session_id: 'a',
    contact: { name: 'Priya Raman', email: 'priya@infosys.com', company: 'infosys.com', company_name: 'Infosys Limited' },
  });
  const anon = lead({ session_id: 'b', contact: null, location: 'Pune, India' });

  it('matches the resolved company name, which is what is on screen', () => {
    // Searching only the raw domain meant typing "Infosys Limited" — the name
    // the drawer shows — matched nothing.
    expect(refineLeads([priya, anon], { contact: 'all', query: 'infosys limited' })).toEqual([priya]);
  });

  it('matches an email fragment', () => {
    expect(refineLeads([priya, anon], { contact: 'all', query: 'INFOSYS.COM' })).toEqual([priya]);
  });

  it('separates named from anonymous visitors', () => {
    expect(refineLeads([priya, anon], { contact: 'named', query: '' })).toEqual([priya]);
    expect(refineLeads([priya, anon], { contact: 'anonymous', query: '' })).toEqual([anon]);
  });

  it('returns everything when nothing is set', () => {
    expect(refineLeads([priya, anon], { contact: 'all', query: '  ' })).toHaveLength(2);
  });
});

/**
 * Every comparator has a stable tiebreak. Without one, two leads on the same
 * score swap places on each re-render and the table appears to shuffle under
 * the cursor — and `DataTable` negates comparators for a descending sort, so an
 * unstable one is not the mirror of itself.
 */
describe('compareLeads', () => {
  it('breaks a tied score deterministically', () => {
    const first = lead({ session_id: 'a', score: 50 });
    const second = lead({ session_id: 'b', score: 50 });
    expect(compareLeads.score(first, second)).toBeLessThan(0);
    expect(compareLeads.score(second, first)).toBeGreaterThan(0);
  });

  it('sorts an undated lead below a dated one', () => {
    const dated = lead({ session_id: 'a', last_active_at: '2026-08-13T10:00:00Z' });
    const undated = lead({ session_id: 'b', last_active_at: null });
    expect(compareLeads.lastActive(undated, dated)).toBeLessThan(0);
  });

  it('treats an unparseable date as absent rather than as NaN', () => {
    // A NaN comparator result makes `Array#sort` order implementation-defined.
    const broken = lead({ session_id: 'a', last_active_at: 'not a date' });
    const dated = lead({ session_id: 'b', last_active_at: '2026-08-13T10:00:00Z' });
    expect(Number.isNaN(compareLeads.lastActive(broken, dated))).toBe(false);
  });

  it('names an anonymous visitor consistently when sorting', () => {
    const named = lead({ session_id: 'a', contact: { name: 'Ada' } });
    const anon = lead({ session_id: 'b', contact: null });
    expect(compareLeads.name(named, anon)).toBeLessThan(0);
  });
});
