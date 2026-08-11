/**
 * These gates decide what a paying customer can see. The server has its own
 * copy (`plan_entitlements_service._paid_tier_includes`) and it is the
 * authority — every case here is written against ITS two rules, not against
 * whatever the UI happened to do.
 */
import { describe, expect, it } from 'vitest';

import {
  EMAIL_VERIFICATION_SLUGS,
  VISITOR_INTELLIGENCE_SLUGS,
  planIncludes,
  planIncludesEmailVerification,
  planIncludesVisitorIntelligence,
} from './planGates';

describe('the standard ladder', () => {
  it('gives email verification to Standard and Professional only', () => {
    expect(planIncludesEmailVerification('standard')).toBe(true);
    expect(planIncludesEmailVerification('professional')).toBe(true);
    expect(planIncludesEmailVerification('free')).toBe(false);
    expect(planIncludesEmailVerification('starter')).toBe(false);
  });

  it('gives the company lookup to Professional only', () => {
    expect(planIncludesVisitorIntelligence('professional')).toBe(true);
    expect(planIncludesVisitorIntelligence('standard')).toBe(false);
    expect(planIncludesVisitorIntelligence('starter')).toBe(false);
    expect(planIncludesVisitorIntelligence('free')).toBe(false);
  });
});

describe('bespoke plans', () => {
  /* The server's rule 2: a slug off the seeded ladder was provisioned by hand
     for a deal, so it gets the feature. The UI used a bare allow-list, so an
     enterprise customer's switches rendered disabled under "Available on the
     Professional plan" for enrichments their own API was already running. */
  it('gives an enterprise plan both enrichments', () => {
    expect(planIncludesEmailVerification('enterprise')).toBe(true);
    expect(planIncludesVisitorIntelligence('enterprise')).toBe(true);
  });

  it('gives a hand-provisioned custom slug both enrichments', () => {
    expect(planIncludesEmailVerification('acme-negotiated-2026')).toBe(true);
    expect(planIncludesVisitorIntelligence('acme-negotiated-2026')).toBe(true);
  });
});

describe('slugs that must never open a gate', () => {
  it('denies while the plan is still resolving', () => {
    /* Callers pass '' before the agent loads. Opening here would flash paid
       controls and then take them away. */
    expect(planIncludesEmailVerification('')).toBe(false);
    expect(planIncludesVisitorIntelligence('')).toBe(false);
    expect(planIncludesEmailVerification(null)).toBe(false);
    expect(planIncludesEmailVerification(undefined)).toBe(false);
  });

  it('denies whitespace, which is not a bespoke slug', () => {
    expect(planIncludesVisitorIntelligence('   ')).toBe(false);
  });
});

describe('slug normalisation', () => {
  it('matches regardless of case or surrounding space', () => {
    /* `bot_plan_slug()` lowercases server-side, but this must not depend on a
       remote invariant to avoid locking a paying agent out. */
    expect(planIncludes('  Professional  ', VISITOR_INTELLIGENCE_SLUGS)).toBe(true);
    expect(planIncludes('STANDARD', EMAIL_VERIFICATION_SLUGS)).toBe(true);
  });

  it('does not let a cased seeded slug fall through as bespoke', () => {
    /* 'FREE' must normalise onto the ladder and be DENIED, not be read as an
       unknown slug and handed everything. */
    expect(planIncludesEmailVerification('FREE')).toBe(false);
    expect(planIncludesVisitorIntelligence('Starter')).toBe(false);
  });
});
