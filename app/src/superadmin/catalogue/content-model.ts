import type { JsonValue, PricingContent } from './types';

/**
 * The public pricing page's four copy blobs, and the rules for editing them.
 *
 * `PricingContentRequest` types each one as a bounded untyped list, because the
 * item shape belongs to the marketing site rather than to the API. So the only
 * things worth validating are the two the endpoint really enforces — it is an
 * array, and it is not longer than the cap — plus the one the endpoint leaves to
 * the caller: send only what changed, since `set_pricing_content` upserts
 * exactly the keys it is handed and leaves the rest alone.
 */

export const MAX_PRICING_ITEMS = 200;

export interface BlobSpec {
  key: keyof PricingContent;
  label: string;
  description: string;
}

export const CONTENT_BLOBS: readonly BlobSpec[] = [
  {
    key: 'faq',
    label: 'FAQ',
    description: 'The question-and-answer list under the pricing table.',
  },
  {
    key: 'feature_matrix',
    label: 'Feature matrix',
    description: 'The plan comparison grid. Nothing here is read by entitlements — it is copy about them.',
  },
  {
    key: 'topup_packs',
    label: 'Top-up packs (displayed)',
    description:
      'The packs advertised on the site. Stored as pricing_topup_packs — a different key from the topup_packs the checkout sells from, so the two can disagree.',
  },
  {
    key: 'credit_costs',
    label: 'Credit costs (displayed)',
    description:
      'The "what a credit buys" table. Also copy: the charged figures live in the credit pricing tab and are not derived from this.',
  },
];

export type ContentDrafts = Record<keyof PricingContent, string>;

export function serialiseContent(content: PricingContent | null): ContentDrafts {
  const out = {} as ContentDrafts;
  for (const blob of CONTENT_BLOBS) out[blob.key] = JSON.stringify(content?.[blob.key] ?? [], null, 2);
  return out;
}

export function parseBlob(raw: string): { ok: true; value: JsonValue[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'That is not valid JSON.' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'This blob has to be a JSON array.' };
  if (parsed.length > MAX_PRICING_ITEMS)
    return { ok: false, error: `At most ${MAX_PRICING_ITEMS} items — the endpoint refuses a longer list.` };
  return { ok: true, value: parsed as JsonValue[] };
}

/** Which blobs the operator actually edited. Only these are sent. */
export function changedBlobs(drafts: ContentDrafts, original: ContentDrafts): (keyof PricingContent)[] {
  return CONTENT_BLOBS.filter((blob) => drafts[blob.key].trim() !== original[blob.key].trim()).map(
    (blob) => blob.key,
  );
}
