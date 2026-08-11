/**
 * Plan gates for the two metered lead enrichments, mirroring the server.
 *
 * The authority is `plan_entitlements_service._paid_tier_includes`. It applies
 * TWO rules, and the frontend only ever implemented the first:
 *
 * 1. A slug on the standard ladder gets exactly what the ladder says.
 * 2. A slug OFF the ladder is a bespoke enterprise deal at a negotiated price,
 *    and gets the feature.
 *
 * Rule 2 exists because narrowing these gates to a bare allow-list silently
 * removed a paid feature from enterprise customers. The frontend's bare
 * `new Set(['professional'])` reintroduced exactly that bug one layer up: the
 * server granted an `enterprise` customer both enrichments while their own
 * Advanced tab showed both switches disabled under "Available on the
 * Professional plan", and their Leads page hid the Visitor Intelligence panel
 * outright. The feature worked; the only thing they could not do was find it.
 *
 * Keep this file in step with `plan_entitlements_service.py`. If a slug is
 * added to `seed_plans.py`, add it to {@link SEEDED_PLAN_SLUGS} here too —
 * a new seeded tier that is missing from this set would be read as bespoke and
 * handed every paid feature.
 */

/** Slugs `seed_plans.py` creates. Anything else is bespoke — see rule 2. */
export const SEEDED_PLAN_SLUGS: ReadonlySet<string> = new Set([
  'free',
  'starter',
  'standard',
  'professional',
]);

/** Ladder tiers that include Reoon email verification. */
export const EMAIL_VERIFICATION_SLUGS: ReadonlySet<string> = new Set(['standard', 'professional']);

/** Ladder tiers that include Visitor Intelligence (the company lookup). */
export const VISITOR_INTELLIGENCE_SLUGS: ReadonlySet<string> = new Set(['professional']);

/**
 * Does `slug` include a feature granted to `ladderSlugs`?
 *
 * An empty or unknown-because-still-loading slug denies. That is deliberate:
 * callers pass `''` while the agent resolves, and a gate that opened during
 * load would flash paid controls and then snatch them away.
 */
export function planIncludes(slug: string | null | undefined, ladderSlugs: ReadonlySet<string>): boolean {
  const normalized = (slug ?? '').trim().toLowerCase();
  if (!normalized) return false;
  if (ladderSlugs.has(normalized)) return true;
  // Bespoke: off the seeded ladder entirely, so it was provisioned by hand for
  // a deal. The server grants it; matching that here is what keeps the UI from
  // contradicting the API.
  return !SEEDED_PLAN_SLUGS.has(normalized);
}

/** True when this plan includes Reoon email verification. */
export function planIncludesEmailVerification(slug: string | null | undefined): boolean {
  return planIncludes(slug, EMAIL_VERIFICATION_SLUGS);
}

/** True when this plan includes the company lookup / Visitor Intelligence. */
export function planIncludesVisitorIntelligence(slug: string | null | undefined): boolean {
  return planIncludes(slug, VISITOR_INTELLIGENCE_SLUGS);
}
