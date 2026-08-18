/**
 * `canonicalCrawlUrls` decides what a capped crawl actually buys.
 *
 * The array it returns is submitted as `ordered_urls`, and the backend
 * truncates it to what the plan and credit balance allow, deducting per page
 * "in order". So its ORDER is a spending decision, not a display one.
 */
import { describe, expect, it } from 'vitest';

import { canonicalCrawlUrls } from './CrawlPageTree';

describe('canonicalCrawlUrls', () => {
  it('keeps discovery order rather than the tree’s folders-first sort', () => {
    /* The tree sorts folders before leaves, then alphabetically, so `/blog`
       (a folder) would outrank the `/about` and `/pricing` leaves. On a site
       whose budget covers only the first few pages, that spends the whole
       allowance on blog posts and leaves an agent that cannot answer a pricing
       question. */
    const discovered = [
      'https://x.com/',
      'https://x.com/pricing',
      'https://x.com/about',
      'https://x.com/blog/post-a',
      'https://x.com/blog/post-b',
    ];

    expect(canonicalCrawlUrls(discovered)).toEqual(discovered);
  });

  it('puts the seed URL first, ahead of any folder', () => {
    const out = canonicalCrawlUrls([
      'https://x.com/',
      'https://x.com/blog/post-a',
      'https://x.com/pricing',
    ]);

    expect(out[0]).toBe('https://x.com/');
  });

  it('still collapses trailing-slash duplicates', () => {
    /* The whole reason this function exists: a typed `https://x.com` plus a
       sitemap `https://x.com/` are one page, and shipping both made the panel
       read "18 of 17 selected". */
    const out = canonicalCrawlUrls(['https://x.com', 'https://x.com/', 'https://x.com/pricing']);

    expect(out).toHaveLength(2);
    expect(out).toContain('https://x.com/pricing');
  });

  it('drops an exact repeat without disturbing order', () => {
    const out = canonicalCrawlUrls([
      'https://x.com/a',
      'https://x.com/b',
      'https://x.com/a',
    ]);

    expect(out).toEqual(['https://x.com/a', 'https://x.com/b']);
  });

  it('returns nothing for no input', () => {
    expect(canonicalCrawlUrls([])).toEqual([]);
  });
});
