import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { getIngestStatus } from '../../../services/api';
import { AddKnowledgePanel } from './add/AddKnowledgePanel';
import { AutoRetrainCard } from './AutoRetrainCard';
import { CrawlPageTree } from './CrawlPageTree';
import { IngestionProgress } from './IngestionProgress';
import { KnowledgeGapsCard } from './KnowledgeGapsCard';
import { RecrawlDialog } from './RecrawlDialog';
import { SourcesTable } from './SourcesTable';
import type { RecrawlStatus } from './knowledge-api';
import { allowanceOf, type RecrawlDiff } from './knowledge-model';
import type { Section } from './useKnowledgeData';

/**
 * What breaks silently on this surface.
 *
 * Not the rendering — the gates. Every test here is a thing that, if it
 * regressed, would spend a customer's credits or delete their knowledge without
 * them agreeing to it, or would show them one of the four states in place of
 * another so they could not tell "nothing yet" from "we could not load this"
 * from "your plan does not include this".
 */

const setAutoRecrawlMock = vi.fn();

vi.mock('./knowledge-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./knowledge-api')>();
  return { ...actual, setAutoRecrawl: (...args: unknown[]) => setAutoRecrawlMock(...args) };
});

const discoverCrawlUrls = vi.fn();
const previewUploadCost = vi.fn();
const uploadDocuments = vi.fn();

vi.mock('../../../services/api', () => ({
  getIngestStatus: vi.fn(),
  diffRecrawl: vi.fn(),
  getRecrawlStatus: vi.fn(),
  updateRecrawl: vi.fn(),
  getDocumentPages: vi.fn(),
  getCurrentUser: () => Promise.resolve({ id: 1, website: null }),
  discoverCrawlUrls: (...args: unknown[]) => discoverCrawlUrls(...args),
  previewUploadCost: (...args: unknown[]) => previewUploadCost(...args),
  uploadDocuments: (...args: unknown[]) => uploadDocuments(...args),
}));

const startCrawl = vi.fn();
const cancelCrawl = vi.fn();
let crawlState: Record<string, unknown> = {};

vi.mock('../../../context/CrawlContext', () => ({
  useCrawl: () => ({
    crawl: {
      status: 'idle',
      urls: [],
      pagesCrawled: 0,
      maxPages: null,
      discoveredTotal: null,
      currentUrl: null,
      botId: null,
      error: null,
      cancelInFlight: false,
      ...crawlState,
    },
    startCrawl,
    cancelCrawl,
    dismissCrawl: vi.fn(),
    isActive: false,
    isTerminal: false,
  }),
}));

beforeEach(() => {
  // Each of these tests asserts on whether an API that spends credits was
  // called, so calls must never leak across them.
  vi.clearAllMocks();
  crawlState = {};
});

function mount(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function section<T>(data: T, overrides: Partial<Section<T>> = {}): Section<T> {
  return { data, loading: false, error: null, forbidden: false, retry: vi.fn(), ...overrides };
}

// ── Sources ────────────────────────────────────────────────────────────────

const SOURCES = [
  {
    name: 'https://acme.com',
    page_count: 42,
    chunk_count: 900,
    ingested_at: '2026-08-10T09:00:00Z',
  },
  { name: 'handbook.pdf', doc_page_count: 12, chunk_count: 130, ingested_at: '2026-08-01T09:00:00Z' },
];

function sourcesTable(overrides: Partial<Parameters<typeof SourcesTable>[0]> = {}) {
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const onRecrawl = vi.fn();
  const onRetry = vi.fn();
  const utils = mount(
    <SourcesTable
      sources={SOURCES}
      loading={false}
      error={null}
      onRetry={onRetry}
      canUseDelta
      busySource={null}
      crawlRunning={false}
      crawlingDomain={null}
      query=""
      onQueryChange={vi.fn()}
      kind="all"
      onKindChange={vi.fn()}
      onViewPages={vi.fn()}
      onRecrawl={onRecrawl}
      onDelete={onDelete}
      {...overrides}
    />,
  );
  return { ...utils, onDelete, onRecrawl, onRetry };
}

describe('SourcesTable — the four states', () => {
  it('shows a skeleton, not an empty table, while it loads', () => {
    sourcesTable({ sources: [], loading: true });
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/nothing to answer from/i)).not.toBeInTheDocument();
  });

  it('says what an empty knowledge base means, not just that it is empty', () => {
    sourcesTable({ sources: [] });
    expect(screen.getByText(/nothing to answer from yet/i)).toBeInTheDocument();
    expect(screen.getByText(/upload a document/i)).toBeInTheDocument();
  });

  it('offers a way back from a failure instead of a dead table', async () => {
    const user = userEvent.setup();
    const { onRetry } = sourcesTable({ sources: [], error: 'The network dropped.' });
    expect(screen.getByRole('alert')).toHaveTextContent('The network dropped.');
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('SourcesTable — deleting indexed knowledge', () => {
  it('is reachable by keyboard and states what is destroyed before it happens', async () => {
    const user = userEvent.setup();
    const { onDelete } = sourcesTable();

    screen.getByRole('button', { name: 'Actions for https://acme.com' }).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: /remove/i }));

    const dialog = await screen.findByRole('alertdialog');
    // The consequence in full: what goes, and that the money does not come back.
    expect(dialog).toHaveTextContent('900');
    expect(dialog).toHaveTextContent(/indexed passage/i);
    expect(dialog).toHaveTextContent(/credits already spent on it are not returned/i);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes nothing when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    const { onDelete } = sourcesTable();

    await user.click(screen.getByRole('button', { name: 'Actions for handbook.pdf' }));
    await user.click(await screen.findByRole('menuitem', { name: /remove/i }));
    await user.click(await screen.findByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes only after the confirmation is accepted', async () => {
    const user = userEvent.setup();
    const { onDelete } = sourcesTable();

    await user.click(screen.getByRole('button', { name: 'Actions for handbook.pdf' }));
    await user.click(await screen.findByRole('menuitem', { name: /remove/i }));
    await user.click(await screen.findByRole('button', { name: /remove it/i }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(onDelete.mock.calls[0][0].name).toBe('handbook.pdf');
  });

  // These two were one test that opened the document's menu, pressed Escape,
  // then opened the website's. That sequence is what made the file
  // order-dependent: Base UI marks the rest of the page `inert` while a menu is
  // open and clears it when the close finishes, and in jsdom — where no
  // animation ever runs — the marker outlived the popup. The second trigger was
  // then inside inert content, so clicking it did nothing and the re-train item
  // never appeared. It failed every run of this file alone and passed in the
  // full suite, which is slow enough for the marker to clear in time.
  //
  // Neither assertion needs two menus in one mount. Escape-closes-a-menu is the
  // menu's own contract and is covered in `ui.test.tsx`.
  it('offers no re-train on a document', async () => {
    const user = userEvent.setup();
    sourcesTable({ crawlRunning: true });

    await user.click(screen.getByRole('button', { name: 'Actions for handbook.pdf' }));
    // Wait for the menu itself: without this the query below would pass just as
    // happily against a menu that never opened.
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: /re-train/i })).not.toBeInTheDocument();
  });

  it('offers a re-train on a website, but never mid-crawl', async () => {
    const user = userEvent.setup();
    const { onRecrawl } = sourcesTable({ crawlRunning: true });

    await user.click(screen.getByRole('button', { name: 'Actions for https://acme.com' }));
    const full = await screen.findByRole('menuitem', { name: /re-train every page/i });
    expect(full).toHaveAttribute('aria-disabled', 'true');
    await user.click(full);
    expect(onRecrawl).not.toHaveBeenCalled();
  });
});

/**
 * The state of an ingestion, which this table did not carry at all.
 *
 * Its only badge said *Website* or *Document* — a type — so a source that failed
 * to extract, one still being read, and one fully trained were identical apart
 * from an em dash in a column hidden below `md`. "Did that upload work?" is the
 * central question on this page.
 */
describe('SourcesTable — what a source is doing', () => {
  const FAILED = [{ name: 'scan.pdf', chunk_count: 0, ingested_at: '2026-08-01T09:00:00Z' }];

  it('separates a trained source from one that produced no passages', () => {
    sourcesTable();
    expect(screen.getAllByText('Trained')).toHaveLength(2);

    cleanup();
    sourcesTable({ sources: FAILED });
    expect(screen.getByText('Not indexed')).toBeInTheDocument();
  });

  it('reads an in-flight crawl of that site as training, not as what it held before', () => {
    sourcesTable({ crawlingDomain: 'acme.com' });

    expect(screen.getByText('Training')).toBeInTheDocument();
    // The document is untouched by a website crawl.
    expect(screen.getByText('Trained')).toBeInTheDocument();
  });

  it('filters by type without asking the server again', () => {
    sourcesTable({ kind: 'documents' });

    expect(screen.getByText('handbook.pdf')).toBeInTheDocument();
    expect(screen.queryByText('https://acme.com')).not.toBeInTheDocument();
  });

  it('says a filter found nothing, rather than that there is nothing', () => {
    sourcesTable({ query: 'nothing-matches-this' });

    expect(screen.getByText('No source matches')).toBeInTheDocument();
    expect(
      screen.queryByText('This chatbot has nothing to answer from yet'),
    ).not.toBeInTheDocument();
  });

  /**
   * A customer who crawled a site and wants nine of its documents gone used to
   * do it nine times, each behind its own confirmation.
   */
  it('removes a whole selection behind one confirmation that names the cost', async () => {
    const user = userEvent.setup();
    const { onDelete } = sourcesTable();

    await user.click(screen.getByRole('checkbox', { name: 'Select https://acme.com' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select handbook.pdf' }));
    await user.click(screen.getByRole('button', { name: 'Remove 2' }));

    const dialog = await screen.findByRole('alertdialog');
    // 900 + 130 passages, named — not "2 items".
    expect(dialog).toHaveTextContent(/1,030 indexed passages/);
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Remove 2' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
  });
});

// ── Knowledge gaps ─────────────────────────────────────────────────────────

const GAPS = [
  { question: 'Do you ship to Ireland?', count: 12, last_asked: '2026-08-18T09:00:00Z' },
  { question: 'What is your refund window?', count: 3, last_asked: null },
];

describe('KnowledgeGapsCard', () => {
  it('passes the window the endpoint has always accepted', async () => {
    const user = userEvent.setup();
    const onWindowChange = vi.fn();
    mount(
      <KnowledgeGapsCard section={section(GAPS)} window={30} onWindowChange={onWindowChange} />,
    );
    await user.click(screen.getByRole('radio', { name: '7d' }));
    expect(onWindowChange).toHaveBeenCalledWith(7);
    await user.click(screen.getByRole('radio', { name: 'All' }));
    expect(onWindowChange).toHaveBeenCalledWith(null);
  });

  it('distinguishes "nothing in this window" from "nothing ever"', () => {
    const { unmount } = mount(
      <KnowledgeGapsCard section={section([])} window={7} onWindowChange={vi.fn()} />,
    );
    expect(screen.getByText(/nothing went unanswered in the last 7 days/i)).toBeInTheDocument();
    unmount();

    mount(<KnowledgeGapsCard section={section([])} window={null} onWindowChange={vi.fn()} />);
    expect(screen.getByText(/no unanswered questions on record/i)).toBeInTheDocument();
  });

  it('shows a loading state rather than an empty answer', () => {
    mount(
      <KnowledgeGapsCard
        section={section([], { loading: true })}
        window={30}
        onWindowChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/nothing went unanswered/i)).not.toBeInTheDocument();
  });

  it('separates a failure from an emptiness', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    mount(
      <KnowledgeGapsCard
        section={section([], { error: 'That did not load.', retry })}
        window={30}
        onWindowChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('That did not load.');
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
  });

  it('says whose permission is missing when the seat cannot see this', () => {
    mount(
      <KnowledgeGapsCard
        section={section([], { forbidden: true })}
        window={30}
        onWindowChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/not yours to see/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

// ── Page picker ────────────────────────────────────────────────────────────

const CRAWL_URLS = [
  'https://acme.com/',
  'https://acme.com/pricing',
  'https://acme.com/blog/one',
  'https://acme.com/blog/two',
];

function PageTreeHarness({ onChange }: { onChange: (next: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([...CRAWL_URLS]);
  return (
    <CrawlPageTree
      urls={CRAWL_URLS}
      selected={selected}
      onSelectionChange={(next) => {
        setSelected(next);
        onChange(next);
      }}
    />
  );
}

describe('CrawlPageTree', () => {
  it('is fully operable from the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<PageTreeHarness onChange={onChange} />);

    // Tab reaches the select-all checkbox first; Space is the platform's own
    // activation key for a checkbox, and it clears every page.
    await user.tab();
    expect(screen.getByRole('checkbox', { name: /clear every page/i })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith([]);

    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(CRAWL_URLS);
  });

  it('toggles a whole section from its folder, in discovery order', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<PageTreeHarness onChange={onChange} />);

    await user.click(screen.getByRole('checkbox', { name: /^blog and everything under it/i }));
    expect(onChange).toHaveBeenLastCalledWith(['https://acme.com/', 'https://acme.com/pricing']);
  });

  it('reports a folder as partly selected rather than as either extreme', async () => {
    const user = userEvent.setup();
    mount(<PageTreeHarness onChange={vi.fn()} />);

    await user.click(screen.getByRole('checkbox', { name: 'one' }));
    const folder = screen.getByRole('checkbox', { name: /^blog and everything under it/i });
    expect(folder).toHaveAttribute('data-indeterminate');
  });

  it('collapses a section without changing what is selected', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<PageTreeHarness onChange={onChange} />);

    const toggle = screen.getByRole('button', { name: /collapse blog/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(screen.queryByRole('checkbox', { name: 'one' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── Ingestion progress ─────────────────────────────────────────────────────

describe('IngestionProgress', () => {
  it('carries in-flight work as motion, with no percentage it does not know', () => {
    mount(<IngestionProgress title="Reading your documents" />);
    const bar = screen.getByRole('progressbar', { name: 'Reading your documents' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    // No status badge, because this design language has no hue for "in progress".
    expect(screen.queryByText(/processing/i)).not.toBeInTheDocument();
  });

  it('shows a real proportion when the work has a known size', () => {
    mount(<IngestionProgress title="Reading your website" done={5} total={20} />);
    expect(screen.getByRole('progressbar', { name: 'Reading your website' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    expect(screen.getByText('5 of 20 pages')).toBeInTheDocument();
  });

  it('says the work continues in the background when there is no job to watch', () => {
    mount(<IngestionProgress title="Reading your documents" jobId={null} />);
    expect(screen.getByText(/carries on in the background/i)).toBeInTheDocument();
  });

  it('announces every job, not just the first one the panel watched', async () => {
    vi.mocked(getIngestStatus).mockResolvedValue({ status: 'complete' } as never);
    const onFinished = vi.fn();
    // Rendered directly rather than through `mount`, because this test rerenders
    // and the providers have to survive that.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const ui = (jobId: string): ReactElement => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IngestionProgress title="Reading your documents" jobId={jobId} onFinished={onFinished} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(ui('job-1'));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));

    // The panel stays mounted between uploads; the second document is a new
    // job, and it has to refresh the source list too.
    rerender(ui('job-2'));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(2));
  });
});

// ── Re-crawl ───────────────────────────────────────────────────────────────

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
    unchangedUrls: [],
    newUrls: ['https://acme.com/new'],
    removedUrls: [],
    costPerPage: 5,
    balance: 1000,
    capped: true,
    headPartial: false,
    planMax: -1,
    ...overrides,
  };
}

function recrawlDialog(overrides: Partial<Parameters<typeof RecrawlDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const utils = mount(
    <RecrawlDialog
      open
      onOpenChange={vi.fn()}
      sourceName="https://acme.com"
      mode="full"
      diff={diff()}
      loading={false}
      previewError={null}
      planLocked={false}
      starting={false}
      startError={null}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { ...utils, onConfirm };
}

describe('RecrawlDialog — spending credits', () => {
  it('names the exact cost on the button that spends it', () => {
    recrawlDialog();
    // 6 unchanged + 4 new = 10 pages at 5 credits.
    expect(
      screen.getByRole('button', { name: 'Re-train 10 pages for 50 credits' }),
    ).toBeEnabled();
  });

  it('will not start a full re-crawl when discovery saw nothing', () => {
    const { onConfirm } = recrawlDialog({
      diff: diff({ sitemapTotal: 0, unchanged: 0, newPages: 0, newUrls: [] }),
    });
    expect(screen.getByText(/could not see any pages/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^re-train/i })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('sends the customer to top up rather than to a disabled button', () => {
    recrawlDialog({ diff: diff({ balance: 10 }) });
    expect(screen.getByRole('link', { name: /top up credits/i })).toHaveAttribute(
      'href',
      '/billing',
    );
    expect(screen.queryByRole('button', { name: /re-train \d/i })).not.toBeInTheDocument();
  });

  it('shows the plan lock with what the feature does, not a bare upsell', () => {
    recrawlDialog({ planLocked: true, diff: null });
    expect(screen.getByText(/Standard and above/i)).toBeInTheDocument();
    expect(screen.getByText(/charges only for changed pages/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-train/i })).not.toBeInTheDocument();
  });

  it('lets an unpreviewed re-crawl go ahead, and says the counts are unknown', () => {
    recrawlDialog({
      previewError: 'The comparison timed out.',
      diff: diff({ sitemapTotal: 0, unchanged: 0, newPages: 0, newUrls: [] }),
    });
    expect(screen.getByText(/The comparison timed out\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^re-train/i })).toBeEnabled();
  });

  /**
   * The page used to answer a failed preview with a synthetic all-zero diff
   * carrying an invented `balance: 0`, and every figure here rendered from it:
   * "Unchanged 0 · New 0 · Gone 0 · Cost 0 credits", the hint "0 pages × 1
   * credits · balance 0", and an enabled "Re-train 0 pages for 0 credits" over
   * a `force_reingest` that re-reads and re-bills every stored page. A promise
   * of nothing over a bill of 2,000 credits.
   */
  it('quotes no figure at all when the comparison failed', () => {
    recrawlDialog({ previewError: 'The comparison timed out.', diff: null });

    expect(screen.getByText(/could not compare the pages/i)).toBeInTheDocument();
    expect(screen.getByText(/every page found will be read and charged/i)).toBeInTheDocument();
    // The action stays available: a hiccup on a courtesy preview must not stop
    // a customer refreshing their own site. It just makes no numeric promise.
    const confirm = screen.getByRole('button', { name: /^re-train/i });
    expect(confirm).toBeEnabled();
    expect(confirm).toHaveAccessibleName('Re-train every page, charged');

    expect(screen.queryByText(/0 credits/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 pages/)).not.toBeInTheDocument();
    expect(screen.queryByText(/balance 0/)).not.toBeInTheDocument();
    // And no cost well to read a price out of.
    expect(screen.queryByText(/^Cost$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Unchanged$/)).not.toBeInTheDocument();
  });

  it('does not price a diff the customer has just been told is stale', () => {
    // Same guard, reached from the other side: a stale diff still in state when
    // a later preview fails must not be quoted either.
    recrawlDialog({ previewError: 'The comparison timed out.', diff: diff() });
    expect(screen.queryByRole('button', { name: /re-train 10 pages/i })).not.toBeInTheDocument();
    expect(screen.queryByText('50 credits')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Cost$/)).not.toBeInTheDocument();
  });

  it('keeps the requested mode when no preview arrived to carry it', () => {
    recrawlDialog({ mode: 'delta', diff: null, previewError: 'The comparison timed out.' });
    expect(screen.getByRole('button', { name: 'Re-train changed pages' })).toBeEnabled();
    expect(screen.getByText(/unchanged pages will still be skipped/i)).toBeInTheDocument();
  });

  it('does not promise a delta price it cannot know', () => {
    recrawlDialog({ diff: diff({ mode: 'delta' }) });
    expect(screen.getByRole('button', { name: 'Re-train changed pages' })).toBeInTheDocument();
    expect(screen.getByText(/worst case/i)).toBeInTheDocument();
  });

  it('warns that a removed-page count is a floor when liveness was partial', () => {
    recrawlDialog({ diff: diff({ headPartial: true }) });
    // The caveat now sits on the "Gone" row itself rather than as a fourth
    // Alert restating the arithmetic beneath the figures.
    expect(screen.getByText(/At least this many/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is deleted by this preview/i)).toBeInTheDocument();
  });
});

// ── Auto-retrain ───────────────────────────────────────────────────────────

function status(overrides: Partial<RecrawlStatus> = {}): RecrawlStatus {
  return {
    enabled: true,
    featureAvailable: true,
    cadenceDays: 7,
    nextRecrawlAt: '2026-08-26T09:00:00Z',
    lastRecrawlAt: '2026-08-19T09:00:00Z',
    lastRecrawlStatus: 'ok',
    pageCount: 2,
    history: [{ ranAt: '2026-08-19T09:00:00Z', status: 'ok', unchanged: 40, changed: 2, failed: 0 }],
    ...overrides,
  };
}

describe('AutoRetrainCard', () => {
  /**
   * A schedule that is off, on a chatbot with nothing trained, cannot run.
   * It used to render the full dashboard anyway — four definition rows reading
   * "—", an explanatory alert, and a reserved empty run table — which made this
   * dormant card 622px, taller than the Add-knowledge panel above it and the
   * largest single thing on the page.
   */
  it('stays small while it has nothing it could possibly refresh', () => {
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(
          status({ enabled: false, pageCount: 0, history: [], lastRecrawlAt: null, nextRecrawlAt: null }),
        )}
        planName="Standard"
      />,
    );

    // The switch and the reason are the whole card.
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.getByText(/no trained websites to refresh yet/i)).toBeInTheDocument();
    // Not four em dashes and a table that cannot have rows.
    expect(screen.queryByRole('table', { name: /recent weekly retrains/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Next check')).not.toBeInTheDocument();
    expect(screen.queryByText(/no runs yet/i)).not.toBeInTheDocument();
  });

  it('does not reserve a run table for a schedule that is switched off', () => {
    // Off, but it has a website, so the definition list still has something to
    // say. The table does not: nothing will run until the switch goes on.
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(status({ enabled: false, pageCount: 2, history: [] }))}
        planName="Standard"
      />,
    );
    expect(screen.getByText('Pages in the set')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /recent weekly retrains/i })).not.toBeInTheDocument();
  });

  it('keeps showing history for a schedule that ran before it was switched off', () => {
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(status({ enabled: false, pageCount: 2 }))}
        planName="Standard"
      />,
    );
    expect(screen.getByRole('table', { name: /recent weekly retrains/i })).toBeInTheDocument();
  });

  it('still reserves the run table once the schedule can actually run', () => {
    // The original reason for always rendering it: a newly-enabled schedule
    // must not silently grow by 250px after its first run.
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(status({ enabled: true, pageCount: 2, history: [] }))}
        planName="Standard"
      />,
    );
    expect(screen.getByRole('table', { name: /recent weekly retrains/i })).toBeInTheDocument();
    expect(screen.getByText(/no runs yet/i)).toBeInTheDocument();
  });

  /**
   * The count is pages, not websites. `sources_count` is
   * `count(distinct document_name) where source='crawl'`, and a crawled PAGE
   * is one Document named by its own URL — the same query
   * `_load_crawl_urls_for_bot` runs to decide what the weekly job re-reads. So
   * the number was right and the noun was wrong: one website of 20 pages read
   * "20 trained websites", which also contradicted this card's own subtitle
   * ("Only pages that changed are re-read").
   */
  it('counts what the weekly job actually re-reads: pages, not websites', () => {
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(status({ enabled: true, pageCount: 20 }))}
        planName="Standard"
      />,
    );
    expect(screen.getByText('20 pages')).toBeInTheDocument();
    expect(screen.queryByText(/trained websites?/i)).not.toBeInTheDocument();
  });

  it('counts one page as one page', () => {
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(status({ enabled: true, pageCount: 1 }))}
        planName="Standard"
      />,
    );
    expect(screen.getByText('1 page')).toBeInTheDocument();
  });

  it('shows the run history the backend has always written', () => {
    mount(
      <AutoRetrainCard agentId={7} section={section<RecrawlStatus | null>(status())} planName="Standard" />,
    );
    const table = screen.getByRole('table', { name: /recent weekly retrains/i });
    expect(within(table).getByText('40')).toBeInTheDocument();
  });

  it('locks with an explanation on a plan that does not include it', () => {
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(status({ featureAvailable: false }))}
        planName="Free"
      />,
    );
    expect(
      screen.getByText('Weekly auto-retrain is on Standard and above'),
    ).toBeInTheDocument();
    // The lock explains what it buys, and it names the plan the reader is on.
    expect(screen.getByText(/Your Free plan re-trains when you ask it to/i)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('confirms before turning the weekly refresh off, and says what stops', async () => {
    const user = userEvent.setup();
    setAutoRecrawlMock.mockResolvedValue(status({ enabled: false }));
    mount(
      <AutoRetrainCard agentId={7} section={section<RecrawlStatus | null>(status())} planName="Standard" />,
    );

    await user.click(screen.getByRole('switch', { name: /weekly auto-retrain/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/stops picking up website changes/i);
    expect(setAutoRecrawlMock).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /leave it on/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(setAutoRecrawlMock).not.toHaveBeenCalled();
  });

  it('turns it off only once the consequence has been accepted', async () => {
    const user = userEvent.setup();
    setAutoRecrawlMock.mockResolvedValue(status({ enabled: false }));
    mount(
      <AutoRetrainCard agentId={7} section={section<RecrawlStatus | null>(status())} planName="Standard" />,
    );

    await user.click(screen.getByRole('switch', { name: /weekly auto-retrain/i }));
    await user.click(await screen.findByRole('button', { name: /turn it off/i }));
    await waitFor(() => expect(setAutoRecrawlMock).toHaveBeenCalledWith(7, false));
  });

  it('turns it on without a confirmation — nothing is lost by refreshing', async () => {
    const user = userEvent.setup();
    setAutoRecrawlMock.mockResolvedValue(status({ enabled: true }));
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(status({ enabled: false }))}
        planName="Standard"
      />,
    );
    await user.click(screen.getByRole('switch', { name: /weekly auto-retrain/i }));
    await waitFor(() => expect(setAutoRecrawlMock).toHaveBeenCalledWith(7, true));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows a failure to load with a way back', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(null, { error: 'Could not reach it.', retry })}
        planName="Standard"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach it.');
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
  });

  it('says the seat cannot change it, rather than showing a dead switch', () => {
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(null, { forbidden: true })}
        planName="Standard"
      />,
    );
    expect(screen.getByText(/not yours to change/i)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('shows a loading state instead of an off switch it has not read yet', () => {
    mount(
      <AutoRetrainCard
        agentId={7}
        section={section<RecrawlStatus | null>(null, { loading: true })}
        planName="Standard"
      />,
    );
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/Standard and above/i)).not.toBeInTheDocument();
  });
});

// ── Adding knowledge ───────────────────────────────────────────────────────

function addPanel(overrides: Partial<Parameters<typeof AddKnowledgePanel>[0]> = {}) {
  const onChanged = vi.fn();
  const utils = mount(
    <AddKnowledgePanel
      agentId={7}
      agentName="Acme Support"
      agentWebsite="https://acme.com"
      sources={[]}
      documentAllowance={allowanceOf(1, 5)}
      pagesTrainedHere={10}
      pageLimit={500}
      characterAllowance={allowanceOf(1_000, 50_000)}
      planName="Starter"
      planLoading={false}
      empty
      onChanged={onChanged}
      {...overrides}
    />,
  );
  return { ...utils, onChanged };
}

const DISCOVERY = {
  url: 'https://acme.com',
  total_found: 4,
  capped: false,
  plan_max: 100,
  urls: [
    'https://acme.com/',
    'https://acme.com/pricing',
    'https://acme.com/blog/one',
    'https://acme.com/blog/two',
  ],
  cost_per_page: 5,
  balance: 1000,
  max_affordable_pages: 200,
  credits_required_full: 20,
  exceeds_balance: false,
};

describe('AddKnowledgePanel — the website flow', () => {
  /**
   * Two scopes, two sentences. There is no workspace-wide page counter in the
   * entitlements payload, so the only honest numerator is this chatbot's own
   * stored pages, which does not belong in a bar against the account's
   * ceiling. It used to be exactly that bar.
   */
  it('states this chatbot’s pages and the plan’s ceiling as separate facts', () => {
    addPanel();
    expect(screen.getByText(/trained on this chatbot so far/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Starter allows 500 website pages across this workspace/i),
    ).toBeInTheDocument();
    // No meter, because no numerator shares that ceiling's scope.
    expect(screen.queryByRole('meter', { name: 'Website pages' })).not.toBeInTheDocument();
  });

  it('says nothing about the plan while the plan is still resolving', () => {
    // The entitlements provider serves a Free placeholder until the real plan
    // lands, so quoting it would show a paying customer a Free plan's ceiling.
    addPanel({ pagesTrainedHere: 20, pageLimit: 20, planLoading: true });
    expect(screen.queryByText(/across this workspace/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /check pages/i })).toBeInTheDocument();
  });

  /**
   * The lock this replaces. `limitFor` returns 0 for a plan row with no
   * `page_scraping` key, `allowanceOf` read that as a spent allowance, and the
   * whole flow was swapped for "no website pages left", a customer who had
   * spent nothing could not train their chatbot at all.
   */
  it('never takes the training controls away over a ceiling it does not know', () => {
    addPanel({ pageLimit: null });
    expect(screen.getByRole('button', { name: /check pages/i })).toBeEnabled();
    expect(screen.queryByText(/no website pages left/i)).not.toBeInTheDocument();
    expect(screen.getByText(/charged in credits on Starter/i)).toBeInTheDocument();
  });

  it('reads an unlimited ceiling as unlimited, not as a full one', () => {
    addPanel({ pagesTrainedHere: 4_200, pageLimit: -1 });
    expect(screen.getByRole('button', { name: /check pages/i })).toBeEnabled();
    expect(screen.getByText(/charged in credits on Starter/i)).toBeInTheDocument();
  });

  it('reports the crawl budget the server sent, which nothing used to read', async () => {
    const user = userEvent.setup();
    discoverCrawlUrls.mockResolvedValue(DISCOVERY);
    addPanel();

    await user.click(screen.getByRole('button', { name: /check pages/i }));
    expect(await screen.findByText('Your plan allows per crawl')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('200 pages')).toBeInTheDocument();
    expect(screen.getByText('4 pages · 20 credits')).toBeInTheDocument();
  });

  it('will not start a crawl until the cost has been accepted', async () => {
    const user = userEvent.setup();
    discoverCrawlUrls.mockResolvedValue(DISCOVERY);
    addPanel();

    await user.click(screen.getByRole('button', { name: /check pages/i }));
    await user.click(await screen.findByRole('button', { name: /train on 4 pages/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/4 pages × 5 credits = 20 credits/i);
    expect(dialog).toHaveTextContent(/balance of 1,000/i);
    expect(startCrawl).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(startCrawl).not.toHaveBeenCalled();
  });

  it('crawls exactly the pages that were ticked, in discovery order', async () => {
    const user = userEvent.setup();
    discoverCrawlUrls.mockResolvedValue(DISCOVERY);
    startCrawl.mockResolvedValue({});
    addPanel();

    await user.click(screen.getByRole('button', { name: /check pages/i }));
    await user.click(await screen.findByRole('checkbox', { name: 'pricing' }));
    await user.click(screen.getByRole('button', { name: /train on 3 pages/i }));
    await user.click(await screen.findByRole('button', { name: /start training/i }));

    await waitFor(() => expect(startCrawl).toHaveBeenCalled());
    const options = startCrawl.mock.calls[0][0];
    expect(options.orderedUrls).toEqual([
      'https://acme.com/',
      'https://acme.com/blog/one',
      'https://acme.com/blog/two',
    ]);
    expect(options.discoveredTotal).toBe(3);
  });
});

describe('AddKnowledgePanel — the document flow', () => {
  function file(name: string): File {
    return new File(['hello'], name, { type: 'text/plain' });
  }

  async function pickDocuments(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('radio', { name: 'Documents' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [file('handbook.txt')]);
  }

  /**
   * `limitFor('documents')` returns 0 for a plan row that never carried the
   * key, and that zero used to render "no documents left, this plan covers 0
   * documents across this workspace" with the file drop removed from the page.
   */
  it('keeps uploading available when the plan states no document ceiling', async () => {
    const user = userEvent.setup();
    addPanel({ documentAllowance: null });
    await user.click(screen.getByRole('radio', { name: 'Documents' }));

    expect(screen.queryByText(/no documents left/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Starter states no document limit/i)).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('still locks on a ceiling the plan really did state and really is spent', async () => {
    const user = userEvent.setup();
    addPanel({ documentAllowance: allowanceOf(5, 5) });
    await user.click(screen.getByRole('radio', { name: 'Documents' }));

    expect(screen.getByText(/no documents left/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see plans/i })).toHaveAttribute('href', '/billing');
  });

  it('prices an upload before it charges for it, and waits to be told to go', async () => {
    const user = userEvent.setup();
    previewUploadCost.mockResolvedValue({
      per_file: [{ filename: 'handbook.txt', words: 400, credits: 12 }],
      total_credits: 12,
      current_balance: 900,
      sufficient: true,
    });
    addPanel();
    await pickDocuments(user);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/charges 12 credits/i);
    expect(dialog).toHaveTextContent('handbook.txt');
    expect(uploadDocuments).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /upload for 12 credits/i }));
    await waitFor(() => expect(uploadDocuments).toHaveBeenCalled());
  });

  it('never uploads unpriced — a failed quote is not a confirmation', async () => {
    const user = userEvent.setup();
    previewUploadCost.mockResolvedValue(null);
    addPanel();
    await pickDocuments(user);

    expect(await screen.findByText(/could not price these documents/i)).toBeInTheDocument();
    expect(uploadDocuments).not.toHaveBeenCalled();
  });

  it('answers an unaffordable upload on the page, not with a dead button', async () => {
    const user = userEvent.setup();
    previewUploadCost.mockResolvedValue({
      per_file: [{ filename: 'handbook.txt', words: 400, credits: 12 }],
      total_credits: 12,
      current_balance: 2,
      sufficient: false,
    });
    addPanel();
    await pickDocuments(user);

    expect(await screen.findByText(/not enough credits/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /top up/i })).toHaveAttribute('href', '/billing');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(uploadDocuments).not.toHaveBeenCalled();
  });

  it('says a scanned document was skipped rather than charging for nothing', async () => {
    const user = userEvent.setup();
    previewUploadCost.mockResolvedValue({
      per_file: [{ filename: 'scan.pdf', words: 0, credits: 0, reason: 'extraction_failed' }],
      total_credits: 0,
      current_balance: 900,
      sufficient: true,
    });
    addPanel();
    await pickDocuments(user);

    expect(await screen.findByText(/nothing to upload here/i)).toBeInTheDocument();
    expect(uploadDocuments).not.toHaveBeenCalled();
  });
});
