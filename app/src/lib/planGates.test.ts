/**
 * These gates decide what a paying customer can see. The server has its own
 * copy (`plan_entitlements_service._paid_tier_includes`) and it is the
 * authority — every case here is written against ITS two rules, not against
 * whatever the UI happened to do.
 */
import { describe, expect, it } from 'vitest';

import {
  EMAIL_VERIFICATION_SLUGS,
  SEEDED_PLAN_SLUGS,
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

describe('the seeded Enterprise tier', () => {
  /* `enterprise` is a SEEDED ladder tier (`seed_plans.py`), not a bespoke deal.
     Registering it in SEEDED_PLAN_SLUGS revokes rule 2 for it, so every ladder
     must name it explicitly — that pairing is the whole point of these cases.
     The backend learned this the hard way in 594383d: adding the slug to
     `_SEEDED_PLAN_SLUGS` alone silently revoked Visitor Intelligence. */
  it('is registered as a seeded tier, not read as bespoke', () => {
    expect(SEEDED_PLAN_SLUGS.has('enterprise')).toBe(true);
  });

  it('passes every ladder Professional passes', () => {
    const ladders: ReadonlySet<string>[] = [EMAIL_VERIFICATION_SLUGS, VISITOR_INTELLIGENCE_SLUGS];
    for (const ladder of ladders) {
      expect(planIncludes('professional', ladder)).toBe(true);
      expect(planIncludes('enterprise', ladder)).toBe(true);
    }
  });

  it('gets both enrichments by ladder membership', () => {
    expect(planIncludesEmailVerification('enterprise')).toBe(true);
    expect(planIncludesVisitorIntelligence('enterprise')).toBe(true);
  });
});

describe('bespoke plans', () => {
  /* The server's rule 2: a slug off the seeded ladder was provisioned by hand
     for a deal, so it gets the feature. The UI used a bare allow-list, so an
     enterprise customer's switches rendered disabled under "Available on the
     Professional plan" for enrichments their own API was already running. */
  it('gives a hand-provisioned custom slug both enrichments', () => {
    expect(planIncludesEmailVerification('acme-negotiated-2026')).toBe(true);
    expect(planIncludesVisitorIntelligence('acme-negotiated-2026')).toBe(true);
  });

  it('treats a per-contract enterprise slug as bespoke, not as the seeded tier', () => {
    /* `enterprise-acme` is a DIFFERENT string from the seeded `enterprise`. It
       stays off the ladder and keeps taking rule 2, so narrowing the seeded
       tier can never strip a negotiated contract of a feature it was sold. */
    expect(SEEDED_PLAN_SLUGS.has('enterprise-acme')).toBe(false);
    expect(planIncludesEmailVerification('enterprise-acme')).toBe(true);
    expect(planIncludesVisitorIntelligence('enterprise-acme')).toBe(true);
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
