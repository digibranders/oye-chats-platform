import { describe, expect, it } from 'vitest';
import {
  GAP_WINDOWS,
  allowanceOf,
  canUseDeltaRecrawl,
  charactersAsWords,
  crawlBudgetOf,
  crawlCoverageOf,
  crawlDoneMessage,
  crawlFellShort,
  crawlPreflight,
  creditsForPages,
  crawlUrlFor,
  gapWindowLabel,
  gapWindowParam,
  ingestProgress,
  isWebsiteSource,
  normalizeSiteUrl,
  orderedUrlsForRecrawl,
  parseGapWindow,
  sourceMixLabel,
  planCeiling,
  recrawlBlockedReason,
  recrawlCost,
  recrawlStartPlan,
  rootDomainOf,
  sourceState,
  sourceUnits,
  summarise,
  uploadSkipReason,
  type RecrawlDiff,
} from './knowledge-model';
import type { CrawlDiscovery } from '../../../types/domain';
import type { KnowledgeSource } from '../../../types/domain';

/**
 * The rules on this surface that cost money if they are wrong.
 *
 * Each of these encodes a specific way the console has previously got a
 * customer's bill or a customer's knowledge wrong: charging for a page set it
 * could not see, silently skipping every page past a preview cap, calling a
 * full plan a fault, and pricing a re-crawl off a number that reads zero when
 * discovery times out.
 */

function source(overrides: Partial<KnowledgeSource> & { name: string }): KnowledgeSource {
  return { page_count: 0, chunk_count: 0, ...overrides };
}

function diff(overrides: Partial<RecrawlDiff> = {}): RecrawlDiff {
  return {
    mode: 'full',
    sourceName: 'https://acme.com',
    crawlUrl: 'https://acme.com',
    replaceSource: 'acme.com',
    sitemapTotal: 10,
    existingTotal: 8,
    unchanged: 6,
    newPages: 4,
    removedPages: 2,
    unchangedUrls: ['https://acme.com/a', 'https://acme.com/b', 'https://acme.com/c', 'https://acme.com/d', 'https://acme.com/e', 'https://acme.com/f'],
    newUrls: ['https://acme.com/1', 'https://acme.com/2', 'https://acme.com/3', 'https://acme.com/4'],
    removedUrls: ['https://acme.com/x', 'https://acme.com/y'],
    costPerPage: 5,
    balance: 1000,
    capped: false,
    headPartial: false,
    planMax: -1,
    ...overrides,
  };
}

describe('sources', () => {
  it('tells a crawled website from an uploaded file', () => {
    expect(isWebsiteSource('https://acme.com/docs')).toBe(true);
    expect(isWebsiteSource('http://acme.com')).toBe(true);
    // A file that merely starts with the letters is still a file.
    expect(isWebsiteSource('https-notes.pdf')).toBe(false);
    expect(isWebsiteSource('handbook.pdf')).toBe(false);
  });

  it('reduces a source name to the registrable host the API expects', () => {
    expect(rootDomainOf('https://www.Acme.com/docs/a?b=1')).toBe('acme.com');
    expect(rootDomainOf('acme.com')).toBe('acme.com');
  });

  it('adds a scheme only when one is missing', () => {
    expect(normalizeSiteUrl('  acme.com ')).toBe('https://acme.com');
    expect(normalizeSiteUrl('http://acme.com')).toBe('http://acme.com');
    expect(crawlUrlFor('acme.com')).toBe('https://acme.com');
    expect(crawlUrlFor('https://acme.com')).toBe('https://acme.com');
  });

  it('counts a website in pages and a document in its own unit', () => {
    expect(sourceUnits(source({ name: 'https://acme.com', page_count: 1 })).label).toBe('1 page');
    expect(sourceUnits(source({ name: 'https://acme.com', page_count: 12 })).label).toBe('12 pages');
    expect(sourceUnits(source({ name: 'guide.pdf', doc_page_count: 4 })).label).toBe('4 pages');
    // No document page count: fall back to passages rather than showing nothing.
    expect(sourceUnits(source({ name: 'guide.txt', chunk_count: 7 })).label).toBe('7 passages');
    // Grouped: the label lands in a `figure` cell beside grouped figures, and a
    // 1,204-page website used to read "1204 pages" next to them.
    expect(sourceUnits(source({ name: 'https://acme.com', page_count: 1204 })).label).toBe(
      '1,204 pages',
    );
  });

  /**
   * The table's only badge used to be the source's *type*, so a failed
   * extraction, a crawl still running and a fully trained source looked
   * identical. Passages are the only thing that makes a source answerable.
   */
  it('derives whether a source is actually answerable', () => {
    expect(sourceState(source({ name: 'guide.pdf', chunk_count: 130 }), null).kind).toBe('trained');
    expect(
      sourceState(source({ name: 'scan.pdf', chunk_count: 0, ingested_at: '2026-08-01' }), null),
    ).toMatchObject({ kind: 'failed', tone: 'danger', label: 'Not indexed' });
  });

  it('reads an in-flight crawl of that site as training, whatever it currently holds', () => {
    const site = source({ name: 'https://www.acme.com/docs', chunk_count: 900 });
    expect(sourceState(site, 'acme.com')).toMatchObject({ kind: 'training', tone: 'neutral' });
    // Another site's crawl says nothing about this source.
    expect(sourceState(site, 'other.com').kind).toBe('trained');
    // A document is never "training" because a crawl is running.
    expect(sourceState(source({ name: 'guide.pdf', chunk_count: 0 }), 'acme.com').kind).toBe(
      'failed',
    );
  });

  it('summarises what a chatbot knows, newest ingest last', () => {
    const result = summarise([
      source({ name: 'https://acme.com', page_count: 10, ingested_at: '2026-08-01T00:00:00Z' }),
      source({ name: 'https://docs.acme.com', page_count: 5, ingested_at: '2026-08-10T00:00:00Z' }),
      source({ name: 'guide.pdf', doc_page_count: 3, ingested_at: '2026-07-01T00:00:00Z' }),
    ]);
    expect(result).toMatchObject({ total: 3, websites: 2, documents: 1, websitePages: 15 });
    expect(result.lastIngestedAt).toBe('2026-08-10T00:00:00.000Z');
  });

  it('reports no last-trained date rather than inventing one', () => {
    expect(summarise([source({ name: 'guide.pdf' })]).lastIngestedAt).toBeNull();
    expect(summarise([]).lastIngestedAt).toBeNull();
  });
});

describe('plan allowances', () => {
  it('treats the -1 sentinel as unlimited, never as a real ceiling', () => {
    const allowance = allowanceOf(4200, -1);
    expect(allowance?.unlimited).toBe(true);
    expect(allowance?.remaining).toBe(Infinity);
    // Nothing fills on an unlimited plan, so no bar can ever read "full".
    expect(allowance?.fraction).toBe(0);
    expect(allowance?.atLimit).toBe(false);
  });

  it('escalates at four fifths and again at the ceiling', () => {
    expect(allowanceOf(79, 100)?.nearLimit).toBe(false);
    expect(allowanceOf(80, 100)?.nearLimit).toBe(true);
    expect(allowanceOf(80, 100)?.atLimit).toBe(false);
    expect(allowanceOf(100, 100)?.atLimit).toBe(true);
    expect(allowanceOf(140, 100)?.remaining).toBe(0);
  });

  /**
   * The expensive direction of the old behaviour. `limitFor` returns 0 for a
   * plan row that simply has no such key, and a zero ceiling used to produce
   * `fraction: 1` and `atLimit: true`, which read as "you have spent an
   * allowance you never had" and locked the flow that adds knowledge.
   */
  it('reports an absent or zero ceiling as unknown, never as spent', () => {
    expect(allowanceOf(0, 0)).toBeNull();
    expect(allowanceOf(12, 0)).toBeNull();
    expect(allowanceOf(12, undefined)).toBeNull();
    expect(allowanceOf(12, null)).toBeNull();
    expect(allowanceOf(12, Number.NaN)).toBeNull();
  });

  it('keeps unknown and unlimited apart, because they read differently', () => {
    expect(planCeiling(undefined)).toBeNull();
    expect(planCeiling(0)).toBeNull();
    expect(planCeiling(-1)).toBe(-1);
    expect(planCeiling(500)).toBe(500);
  });

  it('reads a character count as words for a figure a person can judge', () => {
    expect(charactersAsWords(50_000)).toBe(10_000);
  });
});

describe('knowledge-gap window', () => {
  it('offers a window and keeps all-time available', () => {
    expect(GAP_WINDOWS).toContain(null);
    expect(parseGapWindow('7')).toBe(7);
    expect(parseGapWindow('all')).toBeNull();
  });

  it('falls back rather than throwing on a URL nobody typed carefully', () => {
    expect(parseGapWindow(null)).toBe(30);
    expect(parseGapWindow('nonsense')).toBe(30);
    expect(parseGapWindow('365')).toBe(30);
  });

  it('round-trips through the URL', () => {
    for (const window of GAP_WINDOWS) {
      expect(parseGapWindow(gapWindowParam(window))).toBe(window);
    }
    expect(gapWindowLabel(null)).toBe('All time');
    expect(gapWindowLabel(90)).toBe('Last 90 days');
  });
});

describe('re-crawl', () => {
  it('gates delta on the plans whose API will actually run it', () => {
    expect(canUseDeltaRecrawl('standard')).toBe(true);
    expect(canUseDeltaRecrawl('professional')).toBe(true);
    expect(canUseDeltaRecrawl('enterprise')).toBe(true);
    expect(canUseDeltaRecrawl('free')).toBe(false);
    expect(canUseDeltaRecrawl('starter')).toBe(false);
    // A bespoke contract slug gets what the server gives it: a full re-crawl.
    expect(canUseDeltaRecrawl('acme-custom-2026')).toBe(false);
  });

  it('prices the pages that will be fetched, not the sitemap total', () => {
    // Discovery timed out: sitemap_total is 0 while ten pages are still read.
    const cost = recrawlCost(diff({ sitemapTotal: 0 }));
    expect(cost.pages).toBe(10);
    expect(cost.credits).toBe(50);
  });

  it('refuses a full re-crawl when discovery found nothing', () => {
    expect(recrawlBlockedReason(diff({ sitemapTotal: 0 }), false)).toMatch(/could not see any pages/);
    expect(recrawlBlockedReason(diff(), false)).toBeNull();
    // Delta reconciles against stored URLs at ingest time, so it is unaffected.
    expect(recrawlBlockedReason(diff({ mode: 'delta', sitemapTotal: 0 }), false)).toBeNull();
    // An explicit preview failure proceeds by rediscovery, deliberately.
    expect(recrawlBlockedReason(diff({ sitemapTotal: 0 }), true)).toBeNull();
  });

  it('sends the exact page list only when the preview is complete', () => {
    const urls = orderedUrlsForRecrawl(diff());
    expect(urls).toHaveLength(10);
    expect(urls).toContain('https://acme.com/1');
  });

  it('rediscovers rather than under-refreshing a truncated preview', () => {
    // Counts say 900 new pages; the bucket only lists four of them.
    expect(orderedUrlsForRecrawl(diff({ newPages: 900 }))).toBeNull();
    expect(orderedUrlsForRecrawl(diff({ unchanged: 900 }))).toBeNull();
    expect(orderedUrlsForRecrawl(diff({ capped: true }))).toBeNull();
  });

  it('rediscovers when there is nothing to send', () => {
    expect(
      orderedUrlsForRecrawl(
        diff({ unchanged: 0, newPages: 0, unchangedUrls: [], newUrls: [] }),
      ),
    ).toBeNull();
  });
});

describe('starting a re-train', () => {
  const target = {
    crawlUrl: 'https://acme.com',
    replaceSource: 'acme.com',
    mode: 'full' as const,
  };

  /**
   * The progress denominator. Without it the bar falls back to the plan's
   * `effective_max_pages`, which on an unlimited plan is `balance / cost`, so a
   * 47-page site reported "3 of 9,800" and never visibly moved.
   */
  it('sizes the progress bar by the pages it is actually sending', () => {
    const plan = recrawlStartPlan(target, diff());
    expect(plan.orderedUrls).toHaveLength(10);
    expect(plan.discoveredTotal).toBe(10);
  });

  it('claims no denominator when the crawler will enumerate the site itself', () => {
    // A capped preview sends no URL list, so its size is not ours to state.
    expect(recrawlStartPlan(target, diff({ capped: true })).discoveredTotal).toBeNull();
    expect(recrawlStartPlan(target, null).discoveredTotal).toBeNull();
    expect(recrawlStartPlan(target, null).orderedUrls).toBeNull();
  });

  it('carries the target through when there is no preview to derive it from', () => {
    const plan = recrawlStartPlan({ ...target, mode: 'delta' }, null);
    expect(plan.crawlUrl).toBe('https://acme.com');
    expect(plan.replaceSource).toBe('acme.com');
    expect(plan.mode).toBe('delta');
    // Nothing is known about what changed, so nothing is asserted about it.
    expect(plan.expectedNewPages).toBeNull();
  });

  it('passes the expected change count on a previewed delta run only', () => {
    expect(recrawlStartPlan(target, diff({ mode: 'delta' })).expectedNewPages).toBe(4);
    expect(recrawlStartPlan(target, diff()).expectedNewPages).toBeNull();
  });
});

describe('crawl pre-flight', () => {
  const budget = crawlBudgetOf({
    total_found: 120,
    capped: false,
    urls: [],
    cost_per_page: 5,
    balance: 300,
    max_affordable_pages: 60,
    plan_max: 100,
  });

  it('reads the plan ceiling from the server, and unlimited as no ceiling', () => {
    expect(budget.perCrawlLimit).toBe(100);
    expect(crawlBudgetOf({ total_found: 1, capped: false, plan_max: -1 }).perCrawlLimit).toBeNull();
    expect(crawlBudgetOf({ total_found: 1, capped: false }).perCrawlLimit).toBeNull();
  });

  it('keeps a zero page cost as zero, and still never divides by it', () => {
    // The trial's first website training is free and so is every re-crawl.
    // Clamping the price up to 1 quoted the customer a number the server was
    // never going to charge, which is the whole deterrent this removes. The
    // division the clamp used to protect is guarded at the division instead:
    // at zero, every page found is affordable.
    const free = crawlBudgetOf({ total_found: 4, capped: false, cost_per_page: 0, balance: 50 });
    expect(free.costPerPage).toBe(0);
    expect(free.affordablePages).toBe(4);
    expect(Number.isFinite(free.affordablePages)).toBe(true);
  });

  it('blocks a selection the plan will refuse, and says how many to drop', () => {
    const result = crawlPreflight(budget, 130);
    expect(result.blocked).toBe(true);
    expect(result.message).toMatch(/Deselect 30/);
  });

  it('still warns about a credit shortfall on a capped site', () => {
    // The cap upsell must not shadow this: a shortfall the customer can act on
    // right now outranks a pitch to upgrade.
    const budget = crawlBudgetOf({
      total_found: 100,
      capped: true,
      plan_max: 100,
      balance: 50,
      cost_per_page: 5,
    });
    const result = crawlPreflight(budget, 100, 'trial');
    expect(result.blocked).toBe(false);
    expect(result.message).toContain('Your credits cover 10 of these 100 pages');
  });

  it('upsells on the cap the trial actually hits, in the shape the server reports it', () => {
    // `/crawl/discover` truncates its listing AT the plan ceiling, so a capped
    // plan can never report more pages than it allows. The reachable signal is
    // `capped`, and the honest sentence is "more than 100", not a page count
    // the server deliberately does not compute. It does not block: the 100
    // pages they can train are worth training now.
    const budget = crawlBudgetOf({ total_found: 100, capped: true, plan_max: 100, balance: 5000, cost_per_page: 5 });
    const result = crawlPreflight(budget, 100, 'trial');
    expect(result.blocked).toBe(false);
    expect(result.message).toContain('at least 100 pages');
    expect(result.message).toContain('your trial trains in one go');
    expect(result.message).toContain('Upgrade');
  });

  it('says the same thing without naming the trial on a paid tier', () => {
    const budget = crawlBudgetOf({ total_found: 100, capped: true, plan_max: 100, balance: 5000, cost_per_page: 5 });
    const result = crawlPreflight(budget, 100, 'standard');
    expect(result.blocked).toBe(false);
    expect(result.message).toContain('at least 100 pages');
    expect(result.message).not.toContain('your trial');
  });

  it('stays silent when the site fits inside the cap', () => {
    const budget = crawlBudgetOf({ total_found: 40, capped: false, plan_max: 100, balance: 500, cost_per_page: 5 });
    expect(crawlPreflight(budget, 40, 'trial').message).toBeNull();
  });

  it('warns without blocking when credits cover only part of the selection', () => {
    const result = crawlPreflight(budget, 90);
    expect(result.blocked).toBe(false);
    expect(result.message).toMatch(/cover 60 of these 90/);
  });

  it('says nothing when the crawl is fully covered', () => {
    expect(crawlPreflight(budget, 50)).toEqual({ blocked: false, message: null });
  });

  it('blocks an empty selection', () => {
    expect(crawlPreflight(budget, 0).blocked).toBe(true);
  });
});

describe('upload ingestion', () => {
  it('reads an ARQ state as something a customer understands', () => {
    expect(ingestProgress('queued').active).toBe(true);
    expect(ingestProgress('in_progress').active).toBe(true);
    expect(ingestProgress('complete')).toMatchObject({ phase: 'done', active: false });
    expect(ingestProgress('failed').phase).toBe('failed');
  });

  it('does not call an aged-out job a failure', () => {
    // ARQ drops finished job records; a late poll means "we cannot see it",
    // never "your upload broke".
    expect(ingestProgress('not_found').phase).toBe('unknown');
    expect(ingestProgress(null).phase).toBe('unknown');
  });

  it('explains a skipped file in the customer’s terms, and says it is free', () => {
    expect(uploadSkipReason('extraction_failed')).toMatch(/scanned PDF/);
    expect(uploadSkipReason('extraction_failed')).toMatch(/no charge/);
    expect(uploadSkipReason('oversize_file')).toMatch(/10 MB/);
    expect(uploadSkipReason(undefined)).toBeNull();
    // An unrecognised reason is passed through rather than swallowed.
    expect(uploadSkipReason('something_new')).toBe('something_new');
  });
});

describe('crawl coverage — what the chatbot can actually answer from', () => {
  /** A `done` crawl's `result_payload`, as the worker writes it. */
  function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      message: 'Crawling and ingestion completed successfully',
      pages_processed: 400,
      pages_ingested: 400,
      pages_failed: 0,
      pages_discovered: 400,
      pages_dropped: 0,
      aborted: false,
      abort_reason: null,
      ...overrides,
    };
  }

  it('reports the pages indexed, not the pages fetched', () => {
    // The whole defect in one assertion. A Starter customer's 400-page crawl
    // stops on the character quota around page 25; `pages_processed` still
    // says 400 because the crawler really did read them.
    const coverage = crawlCoverageOf(
      payload({ pages_ingested: 25, aborted: true, abort_reason: 'knowledge_quota' }),
    );
    expect(coverage).not.toBeNull();
    expect(coverage?.ingested).toBe(25);
    expect(coverage?.processed).toBe(400);
    expect(crawlFellShort(coverage!)).toBe(true);
    expect(crawlDoneMessage(coverage!).body).toContain('25 pages of the 400');
  });

  it('congratulates only a crawl that actually covered the site', () => {
    const coverage = crawlCoverageOf(payload());
    expect(crawlFellShort(coverage!)).toBe(false);
    expect(crawlDoneMessage(coverage!)).toMatchObject({ tone: 'success', title: undefined });
    expect(crawlDoneMessage(coverage!).body).toBe('Finished. This chatbot read 400 pages.');
  });

  it('counts a page the content hash proved unchanged as covered', () => {
    // A delta re-crawl of a site nothing has changed on stores nothing and is
    // still complete coverage. `pages_ingested` includes those pages, so this
    // must not read as a shortfall.
    const coverage = crawlCoverageOf(payload({ pages_processed: 120, pages_ingested: 120 }));
    expect(crawlFellShort(coverage!)).toBe(false);
  });

  it('names the limit that stopped it, because the remedies differ', () => {
    const credits = crawlDoneMessage(
      crawlCoverageOf(payload({ pages_ingested: 30, aborted: true, abort_reason: 'credits' }))!,
    );
    expect(credits.tone).toBe('warning');
    expect(credits.title).toMatch(/credits ran out/i);
    expect(credits.body).toMatch(/Add credits/);

    const quota = crawlDoneMessage(
      crawlCoverageOf(
        payload({ pages_ingested: 30, aborted: true, abort_reason: 'knowledge_quota' }),
      )!,
    );
    expect(quota.title).toMatch(/knowledge base is full/i);
    expect(quota.body).toMatch(/Move up a plan/);

    // Never the JavaScript advice: a quota has nothing to do with rendering,
    // and that sentence sent people to debug a site that was working.
    expect(credits.body).not.toMatch(/JavaScript/i);
    expect(quota.body).not.toMatch(/JavaScript/i);
  });

  it('does not raise a warning over pages the plan cap never let it fetch', () => {
    // `pages_dropped` is URLs discovery enqueued and the crawl never reached: a
    // per-crawl page cap, but equally a robots-blocked path. The cap is stated
    // on this screen before a customer spends anything, and a brass banner on
    // an otherwise clean crawl is how a reader learns to ignore brass banners.
    const coverage = crawlCoverageOf(
      payload({ pages_processed: 100, pages_ingested: 100, pages_discovered: 340, pages_dropped: 240 }),
    );
    expect(crawlFellShort(coverage!)).toBe(false);
    expect(crawlDoneMessage(coverage!).tone).toBe('success');
  });

  it('counts those pages in the denominator once there IS a shortfall', () => {
    // Once the crawl stopped early, the honest comparison is against the whole
    // site rather than against the slice it happened to fetch first.
    const coverage = crawlCoverageOf(
      payload({
        pages_processed: 100,
        pages_ingested: 60,
        pages_discovered: 340,
        pages_dropped: 240,
        aborted: true,
        abort_reason: 'credits',
      }),
    );
    expect(crawlDoneMessage(coverage!).body).toContain('60 pages of the 340');
  });

  it('falls back rather than announcing zero for a payload it cannot read', () => {
    // The result lands a beat after the terminal status, and a worker older
    // than these keys never sends them. `null` tells the caller to keep using
    // the count it already has.
    expect(crawlCoverageOf(null)).toBeNull();
    expect(crawlCoverageOf({ pages_processed: 12 })).toBeNull();
    expect(crawlCoverageOf('done')).toBeNull();
    expect(crawlCoverageOf([])).toBeNull();
  });

  it('never renders a shortfall out of a payload that disagrees with itself', () => {
    const coverage = crawlCoverageOf(payload({ pages_processed: 3, pages_ingested: 10 }));
    expect(coverage?.processed).toBe(10);
    expect(crawlFellShort(coverage!)).toBe(false);
  });
});

describe('the free-training allowance', () => {
  /**
   * The allowance comes off the TOP of a crawl, so a selection's price is not
   * `pages x costPerPage`. That multiplication quoted a trial customer 405
   * credits for 81 pages when the first 25 were free and the charge was 280 —
   * on the button they were about to press.
   */
  const withAllowance = (over: Partial<CrawlDiscovery> = {}): CrawlDiscovery => ({
    total_found: 81,
    capped: false,
    cost_per_page: 5,
    balance: 500,
    free_pages: 25,
    ...over,
  });

  it('charges only the pages past the allowance', () => {
    const budget = crawlBudgetOf(withAllowance());
    expect(creditsForPages(budget, 81)).toBe(280); // (81 - 25) x 5
  });

  it('charges nothing for a selection that fits inside it', () => {
    const budget = crawlBudgetOf(withAllowance());
    expect(creditsForPages(budget, 25)).toBe(0);
    expect(creditsForPages(budget, 10)).toBe(0);
  });

  it('never returns a negative charge', () => {
    const budget = crawlBudgetOf(withAllowance({ free_pages: 100 }));
    expect(creditsForPages(budget, 3)).toBe(0);
  });

  it('reads an absent allowance as none, not as unlimited', () => {
    // An older server omits the field. Treating that as unlimited would quote
    // pages as free that the ledger is about to charge for.
    const budget = crawlBudgetOf(withAllowance({ free_pages: undefined }));
    expect(budget.freePages).toBe(0);
    expect(creditsForPages(budget, 81)).toBe(405);
  });

  it('counts the free pages as affordable, not just what the balance buys', () => {
    // 25 free + 500/5 = 125, capped at the 81 actually found.
    const budget = crawlBudgetOf(withAllowance({ max_affordable_pages: undefined }));
    expect(budget.affordablePages).toBe(81);
  });

  it('still affords the free pages on an empty balance', () => {
    const budget = crawlBudgetOf(
      withAllowance({ balance: 0, max_affordable_pages: undefined }),
    );
    expect(budget.affordablePages).toBe(25);
    expect(creditsForPages(budget, 25)).toBe(0);
  });
});

describe('sourceMixLabel', () => {
  /**
   * The Sources tile read "1 websites · 0 documents" on a chatbot with one
   * website. A count the customer reads under a big number has to agree with
   * that number in grammar as well as arithmetic.
   */
  it('inflects each noun by its own count', () => {
    expect(sourceMixLabel({ websites: 1, documents: 0 })).toBe('1 website · 0 documents');
    expect(sourceMixLabel({ websites: 2, documents: 1 })).toBe('2 websites · 1 document');
    expect(sourceMixLabel({ websites: 0, documents: 0 })).toBe('0 websites · 0 documents');
  });

  it('formats large counts with the locale separator', () => {
    expect(sourceMixLabel({ websites: 1200, documents: 1 })).toBe('1,200 websites · 1 document');
  });
});
