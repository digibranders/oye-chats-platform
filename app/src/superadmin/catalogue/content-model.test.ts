import { describe, expect, it } from 'vitest';
import { changedBlobs, parseBlob, serialiseContent } from './content-model';
import type { PricingContent } from './types';

const content: PricingContent = {
  faq: [{ q: 'Is it free?', a: 'There is a free tier.' }],
  feature_matrix: [],
  topup_packs: [],
  credit_costs: [],
};

describe('parsing a content blob', () => {
  it('refuses anything that is not an array, which the endpoint would also refuse', () => {
    expect(parseBlob('{"q":"x"}')).toEqual({ ok: false, error: 'This blob has to be a JSON array.' });
    expect(parseBlob('"text"').ok).toBe(false);
    expect(parseBlob('[]')).toEqual({ ok: true, value: [] });
  });

  it('reports a syntax error rather than silently sending nothing', () => {
    const result = parseBlob('[{');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it('enforces the same 200-item cap the endpoint does', () => {
    expect(parseBlob(JSON.stringify(new Array(200).fill(1))).ok).toBe(true);
    expect(parseBlob(JSON.stringify(new Array(201).fill(1))).ok).toBe(false);
  });
});

describe('what gets published', () => {
  it('sends nothing when nothing was edited', () => {
    const drafts = serialiseContent(content);
    expect(changedBlobs(drafts, drafts)).toEqual([]);
  });

  it('sends only the blobs that changed, so the rest are left alone', () => {
    const original = serialiseContent(content);
    const drafts = { ...original, faq: '[]' };
    expect(changedBlobs(drafts, original)).toEqual(['faq']);
  });

  it('ignores a difference that is only surrounding whitespace', () => {
    const original = serialiseContent(content);
    const drafts = { ...original, faq: `\n${original.faq}\n` };
    expect(changedBlobs(drafts, original)).toEqual([]);
  });

  it('renders a missing blob as an empty array rather than as null', () => {
    expect(serialiseContent(null).faq).toBe('[]');
  });
});
