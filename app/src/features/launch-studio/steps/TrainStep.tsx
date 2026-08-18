import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Globe,
  Upload,
  Loader2,
  FileCheck2,
  FileText,
  Link as LinkIcon,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Plus,
  Search,
  X,
  ChevronDown,
} from 'lucide-react';
import { Input, Card, Button, Progress, StatusBadge, cn } from '../../../design-system';
import {
  updateBot,
  uploadDocuments,
  discoverCrawlUrls,
  recordActivationEvent,
  getDocuments,
  getDocumentPages,
  getCurrentUser,
} from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useCrawl } from '../../../context/CrawlContext';
import type { StartCrawlOptions } from '../../../context/CrawlContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { useUpgradeModal } from '../../../context/UpgradeModalContext';
import { CrawlPageTree, canonicalCrawlUrls } from '../../agents/knowledge/CrawlPageTree';
import { totalWebsitePages } from '../../agents/knowledge/knowledge-utils';
import { StepShell } from '../StepShell';
import { PagesDrawer } from '../PagesDrawer';
import { resolveWebsitePrefill } from '../../../lib/websitePrefill';
import type { StepProps } from '../steps.config';
import type { KnowledgeSource, SourcePage, CrawlDiscovery } from '../../../types/domain';

function isUrl(name: string): boolean {
  return name.startsWith('http://') || name.startsWith('https://');
}
function normalizeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * The most pages a single crawl may train on, given what the plan still allows.
 *
 * Two independent ceilings apply and the tighter one wins:
 *  - `planPagesLeft`. What is left of the workspace's `page_scraping`
 *    allowance (`Infinity` on an unlimited plan).
 *  - `result.plan_max`, the server's own per-crawl ceiling for this plan,
 *    returned by `/crawl/discover`. `-1` (paid tiers) means "no per-crawl cap;
 *    spend is governed by credits", so it is NOT a constraint.
 *
 * This is not cosmetic: `POST /crawl` rejects `max_pages > plan_max` outright
 * with a 400, and silently truncates an over-long `ordered_urls` to the plan
 * ceiling. Capping here is what stops a customer ticking 47 pages on a 20-page
 * plan and discovering the shortfall only after the credits are spent.
 */
function crawlPageCap(result: CrawlDiscovery, planPagesLeft: number): number {
  const perCrawl =
    typeof result.plan_max === 'number' && result.plan_max > 0 ? result.plan_max : Infinity;
  return Math.min(planPagesLeft, perCrawl);
}

/**
 * The page set to pre-tick after a scan: every discovered page, trimmed to what
 * the plan allows and (when the balance cannot cover the whole site) to what
 * the credits actually buy.
 *
 * Trimming happens in DISCOVERY order (see `canonicalCrawlUrls`), which puts the
 * seed URL first and follows the site's own sitemap priority, so a part-funded
 * crawl keeps the pages that matter rather than an alphabetical prefix.
 */
function seedSelection(result: CrawlDiscovery, planPagesLeft: number): string[] {
  const canonical = canonicalCrawlUrls(result.urls ?? []);
  const affordable =
    result.exceeds_balance && typeof result.max_affordable_pages === 'number'
      ? Math.max(result.max_affordable_pages, 0)
      : Infinity;
  const cap = Math.min(crawlPageCap(result, planPagesLeft), affordable);
  return Number.isFinite(cap) ? canonical.slice(0, cap) : canonical;
}

function toPath(url: string): string {
  try {
    return new URL(url).pathname || url;
  } catch {
    return url;
  }
}
function pageLabel(source: KnowledgeSource): string {
  if (isUrl(source.name)) {
    const n = source.page_count ?? 0;
    return `${n} page${n === 1 ? '' : 's'}`;
  }
  const n = source.doc_page_count ?? source.chunk_count ?? 0;
  const unit = source.doc_page_count != null ? 'page' : 'section';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Step 3 - Setup & Train (Combined Connect Website + Knowledge).
 *
 * Merges website URL entry, an explicit site scan, per-page selection, crawl
 * execution, live progress, and knowledge review into one state-driven step.
 *
 * The flow is: URL → **Scan website** → pick pages in `CrawlPageTree` →
 * **Train your chatbot** → live progress. Scanning is a deliberate, named
 * action rather than something Continue does silently, and the tree IS the
 * review, which is why there is no separate "ready to train?" confirmation.
 * The page picker is the same component the Knowledge tab uses
 * (`CrawlPageTree` / `AddKnowledgePanel`), so both surfaces behave identically.
 *
 * The URL field prefills from the agent's website, falling back to the account
 * website captured at signup - see `resolveWebsitePrefill`.
 */
export function TrainStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const { crawl, startCrawl } = useCrawl();
  const { limitFor, withinLimit, remaining } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();

  // Connect / Input states
  const [url, setUrl] = useState(() => resolveWebsitePrefill(selectedBot?.website, null));
  const [clientWebsite, setClientWebsite] = useState<string | null>(null);
  // Has the user typed in the URL field? A ref, not state: it gates the
  // prefill effect below and must never re-trigger it.
  const urlEdited = useRef(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [estimate, setEstimate] = useState<CrawlDiscovery | null>(null);
  // Pages the user has ticked in the tree. Sent as `ordered_urls` so exactly
  // these are fetched and billed.
  const [selectedUrls, setSelectedUrls] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Knowledge / Review states
  const [sources, setSources] = useState<KnowledgeSource[] | null>(null);
  const [pagesBySource, setPagesBySource] = useState<Record<string, SourcePage[]>>({});
  const [drawerSource, setDrawerSource] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState(false);

  // Add-a-website sub-flow in review state
  const [showAddSite, setShowAddSite] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [siteEstimate, setSiteEstimate] = useState<CrawlDiscovery | null>(null);
  const [siteSelectedUrls, setSiteSelectedUrls] = useState<string[]>([]);
  const [siteBusy, setSiteBusy] = useState(false);

  const crawlRunning = crawl.status === 'running' || crawl.status === 'cancelling';
  const crawlFailed = crawl.status === 'failed' || crawl.status === 'no_content';

  const websitePrefill = resolveWebsitePrefill(selectedBot?.website, clientWebsite);

  // The account's website, captured at signup. Read once on mount so the field
  // can be prefilled for an agent created moments ago in step 2, which has no
  // website of its own yet. Purely a convenience: a failed read leaves the
  // field empty rather than surfacing an error the user cannot act on.
  useEffect(() => {
    let cancelled = false;
    void getCurrentUser()
      .then((user) => {
        if (!cancelled) setClientWebsite(user.website ?? null);
      })
      .catch(() => {
        /* No prefill - the user types the URL, exactly as before. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // `selectedBot` and the account profile both resolve asynchronously, so the
  // prefill cannot be a one-shot `useState` initialiser - on a fresh load of
  // this route it would be computed from `undefined` and never correct itself.
  // Re-sync whenever the resolved value changes, but never over the top of
  // something the user typed.
  useEffect(() => {
    if (urlEdited.current || !websitePrefill) return;
    setUrl(websitePrefill);
  }, [websitePrefill]);

  const costPerPage = estimate?.cost_per_page ?? 1;
  const exceeds = Boolean(estimate?.exceeds_balance);
  const affordable = estimate?.max_affordable_pages ?? 0;
  const noBalance = exceeds && affordable === 0;

  // Discovery returned an explicit, selectable page list. When it didn't
  // (sitemap-less site) the crawl falls back to following links and there is
  // nothing to tick - so no tree, and the estimate stays site-wide.
  const hasPageList = (estimate?.urls?.length ?? 0) > 0;
  const selectedCount = selectedUrls.length;
  // What this crawl will actually fetch and bill: the ticked pages when the
  // user has a list, otherwise whatever the link-follow finds.
  const chargeablePages = hasPageList ? selectedCount : (estimate?.total_found ?? 0);
  const estimatedCost = chargeablePages * costPerPage;
  // Selected beyond what the balance covers. The backend trains as many as the
  // credits allow, in order, so this warns rather than blocks - unlike
  // `noBalance`, where nothing can be trained at all.
  const overAffordable = hasPageList && !noBalance && selectedCount > affordable;

  // ── Plan page allowance ──────────────────────────────────────────
  // `page_scraping` is not populated server-side as usage, so "used" is derived
  // from this agent's already-crawled page counts - the same derivation the
  // Knowledge tab uses (`KnowledgePage` → `AddKnowledgePanel.pagesLocked`).
  const pagesUsed = totalWebsitePages(sources ?? []);
  const pagesLimit = limitFor('page_scraping');
  const pagesLocked = !withinLimit('page_scraping', pagesUsed);
  const planPagesLeft = remaining('page_scraping', pagesUsed);
  const pageCap = estimate ? crawlPageCap(estimate, planPagesLeft) : planPagesLeft;
  const overPlanCap = hasPageList && Number.isFinite(pageCap) && selectedCount > pageCap;

  // Same derivations for the "add another site" sub-flow in the review state,
  // so both entry points price and cap a crawl identically.
  const siteHasPageList = (siteEstimate?.urls?.length ?? 0) > 0;
  const siteSelectedCount = siteSelectedUrls.length;
  const siteChargeablePages = siteHasPageList ? siteSelectedCount : (siteEstimate?.total_found ?? 0);
  const siteCost = siteChargeablePages * (siteEstimate?.cost_per_page ?? 1);
  const siteCap = siteEstimate ? crawlPageCap(siteEstimate, planPagesLeft) : planPagesLeft;
  const siteOverPlanCap =
    siteHasPageList && Number.isFinite(siteCap) && siteSelectedCount > siteCap;

  const fetchSources = useCallback(async (): Promise<KnowledgeSource[]> => {
    if (!selectedBot) return [];
    const data = await getDocuments(selectedBot.id);
    setSources(data);
    if (data.length > 0) {
      const urlSources = data.filter((s) => isUrl(s.name));
      const entries = await Promise.all(
        urlSources.map(async (s) => {
          try {
            const res = await getDocumentPages(s.name, selectedBot.id);
            return [s.name, res.pages] as const;
          } catch {
            return [s.name, [] as SourcePage[]] as const;
          }
        }),
      );
      setPagesBySource(Object.fromEntries(entries));
    }
    return data;
  }, [selectedBot]);

  // Load sources when crawl is done or already trained
  useEffect(() => {
    if (!selectedBot || crawlRunning) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const data = await fetchSources();
        if (!cancelled && data.length === 0 && (crawl.status !== 'idle' || uploadedCount > 0)) {
          timer = window.setTimeout(poll, 3000);
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [selectedBot, crawlRunning, crawl.status, uploadedCount, fetchSources]);

  const handleFiles = async (fileList: FileList) => {
    if (!selectedBot || fileList.length === 0) return;
    setUploadingDocs(true);
    setUploading(true);
    setError(null);
    try {
      await uploadDocuments(Array.from(fileList), selectedBot.id);
      setUploadedCount((c) => c + fileList.length);
      void recordActivationEvent('documents_uploaded', { botId: selectedBot.id });
      await fetchSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploadingDocs(false);
      setUploading(false);
    }
  };

  const alreadyCrawled = (site: string): boolean => {
    if (!selectedBot) return false;
    const sameSite = selectedBot.website === site;
    const inSession =
      crawl.botId === selectedBot.id && (crawl.status === 'running' || crawl.status === 'done');
    const trained =
      Boolean(selectedBot.crawl_completed_at) ||
      (selectedBot.indexed_chunk_count ?? 0) > 0 ||
      selectedBot.last_crawl_status === 'done';
    return sameSite && (inSession || trained);
  };

  /**
   * Scan the site: ask the backend which pages exist so the user can choose
   * among them. A named, explicit action - it costs nothing and charges
   * nothing, so it is safe to press, unlike the Train CTA it precedes.
   */
  const handleScan = async () => {
    const trimmed = url.trim();
    if (!trimmed || !selectedBot) return;

    // Already trained on this exact site: nothing to scan or re-buy - drop
    // straight into the knowledge review.
    if (alreadyCrawled(normalizeUrl(trimmed))) {
      await fetchSources();
      return;
    }

    setDiscovering(true);
    setError(null);
    setEstimate(null);
    setSelectedUrls([]);
    try {
      const result = await discoverCrawlUrls(normalizeUrl(trimmed), selectedBot.id);
      setEstimate(result);
      setSelectedUrls(seedSelection(result, planPagesLeft));
    } catch (err) {
      // Scanning is best-effort - the crawl can still follow links from the
      // homepage. Fall back to a zero-count estimate and say so.
      setEstimate({ total_found: 0, capped: false });
      setSelectedUrls([]);
      setError(
        err instanceof Error
          ? err.message
          : "We couldn't list the pages, but you can still train on this site.",
      );
    } finally {
      setDiscovering(false);
    }
  };

  /**
   * The commitment point: this is the click that spends credits. Trains on
   * exactly the ticked pages and lands the user on the live progress view.
   */
  const handleStartCrawl = async () => {
    if (!selectedBot || !estimate) return;
    if (hasPageList && selectedCount === 0) {
      setError('Select at least one page to train on.');
      return;
    }
    const site = normalizeUrl(url.trim());
    setStarting(true);
    setError(null);
    try {
      await updateBot(selectedBot.id, { website: site });
      if (!alreadyCrawled(site)) {
        const opts: StartCrawlOptions = {
          url: site,
          botId: selectedBot.id,
          botName: selectedBot.name,
        };
        if (hasPageList) {
          // Crawl exactly the ticked pages, in discovery order. `discoveredTotal`
          // sizes the progress bar and the credit pre-flight to the SELECTION,
          // not the whole site - otherwise a user who deselects pages watches a
          // progress bar counting up to a total that will never arrive.
          opts.orderedUrls = selectedUrls;
          opts.discoveredTotal = selectedCount;
          opts.maxPages = selectedCount;
        } else if (estimate.total_found > 0) {
          opts.discoveredTotal = estimate.total_found;
        }
        await startCrawl(opts);
        void recordActivationEvent('crawl_started', { botId: selectedBot.id });
      }
      // Clearing the estimate drops through to the live progress view.
      setEstimate(null);
      setSelectedUrls([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start. Please try again.");
    } finally {
      setStarting(false);
    }
  };

  /** Footer CTA. Trains when a scan is on screen; otherwise advances the step. */
  const handlePrimary = () => {
    if (estimate) {
      void handleStartCrawl();
      return;
    }
    props.onContinue();
  };

  const handleDiscoverSite = async () => {
    if (!selectedBot || !siteUrl.trim()) return;
    setSiteBusy(true);
    setError(null);
    try {
      const res = await discoverCrawlUrls(normalizeUrl(siteUrl.trim()), selectedBot.id);
      setSiteEstimate(res);
      setSiteSelectedUrls(seedSelection(res, planPagesLeft));
    } catch {
      setSiteEstimate({ total_found: 0, capped: false });
      setSiteSelectedUrls([]);
    } finally {
      setSiteBusy(false);
    }
  };

  const handleAddSite = async () => {
    if (!selectedBot || !siteEstimate) return;
    setSiteBusy(true);
    setError(null);
    try {
      const site = normalizeUrl(siteUrl.trim());
      const opts: StartCrawlOptions = { url: site, botId: selectedBot.id, botName: selectedBot.name };
      if (siteHasPageList) {
        opts.orderedUrls = siteSelectedUrls;
        opts.discoveredTotal = siteSelectedUrls.length;
        opts.maxPages = siteSelectedUrls.length;
      } else if (siteEstimate.total_found > 0) {
        opts.discoveredTotal = siteEstimate.total_found;
      }
      await startCrawl(opts);
      setShowAddSite(false);
      setSiteUrl('');
      setSiteEstimate(null);
      setSiteSelectedUrls([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start training. Please try again.");
    } finally {
      setSiteBusy(false);
    }
  };

  const reviewReady = (sources?.length ?? 0) > 0;
  const inTraining = crawlRunning || (crawl.status !== 'idle' && !reviewReady);

  // ── 1. Live Training Progress Sub-view ────────────────────────────
  // `crawl.discoveredTotal` is the SELECTED page count (set in
  // `handleStartCrawl`), so "3 of 6 pages" tracks what the user chose to buy.
  if (inTraining && !reviewReady) {
    const pages = crawl.urls;
    const done = crawl.pagesCrawled;
    const total = crawl.discoveredTotal ?? (pages.length || null);
    const percent =
      crawl.status === 'done'
        ? 100
        : total && total > 0
          ? Math.min(99, Math.round((done / total) * 100))
          : done > 0
            ? 60
            : crawlRunning
              ? 20
              : 12;

    return (
      <StepShell
        title="Teaching your AI"
        description="We're reading your content and turning it into knowledge your chatbot can use."
        onBack={props.onBack}
        onContinue={props.onContinue}
        isFirst={props.isFirst}
        isLast={props.isLast}
        canContinue={done > 0 || reviewReady}
      >
        {crawlFailed ? (
          <Card className="flex items-start gap-3 p-5">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[var(--ds-warning)]" />
            <div>
              <p className="text-[13px] font-medium text-[var(--ds-text)]">
                {crawl.status === 'no_content'
                  ? "We couldn't read any content from that site"
                  : "We couldn't finish reading your site"}
              </p>
              <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">
                {crawl.error ||
                  'Some sites render with JavaScript we can’t read. Go back and try a different URL, or upload documents instead.'}
              </p>
            </div>
          </Card>
        ) : (
          <div className="space-y-4">
            <Card className="p-5">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text)]">
                <Loader2 size={15} className="animate-spin text-[var(--ds-accent)]" />
                {crawl.status === 'idle' ? 'Processing your content…' : 'Training in progress'}
                {total ? (
                  <span className="ml-auto text-[var(--ds-text-muted)]">
                    {done} of {total} pages
                  </span>
                ) : done > 0 ? (
                  <span className="ml-auto text-[var(--ds-text-muted)]">
                    {done} page{done === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>
              <Progress value={percent} label="Training progress" />
              <p className="mt-3 text-[12px] text-[var(--ds-text-subtle)]">
                This usually takes a few seconds. You can continue as soon as the first page is learned.
              </p>
            </Card>

            {pages.length > 0 && (
              <Card className="divide-y divide-[var(--ds-border)]">
                <div className="px-4 py-2.5 text-[12px] font-medium text-[var(--ds-text-muted)]">
                  Discovered {pages.length} page{pages.length === 1 ? '' : 's'}
                </div>
                {pages.slice(0, 8).map((page) => (
                  <div key={page} className="flex items-center gap-3 px-4 py-2">
                    <FileText size={14} className="shrink-0 text-[var(--ds-text-subtle)]" />
                    <span className="truncate text-[13px] text-[var(--ds-text)]">{page}</span>
                  </div>
                ))}
              </Card>
            )}
          </div>
        )}
      </StepShell>
    );
  }

  // ── 2. Knowledge Review Sub-view (Trained) ────────────────────────
  if (reviewReady) {
    const list = sources ?? [];
    return (
      <StepShell
        title="What your AI learned"
        description="A quick look at your chatbot's knowledge before you test it."
        onBack={props.onBack}
        onContinue={props.onContinue}
        isFirst={props.isFirst}
        isLast={props.isLast}
        canContinue={true}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-[13px] text-[var(--ds-success)]">
            <CheckCircle2 size={16} />
            <span className="font-medium">
              Trained on {list.length} source{list.length === 1 ? '' : 's'}
            </span>
          </div>

          {crawlRunning && (
            <Card className="flex items-center gap-3 p-4">
              <Loader2 size={16} className="shrink-0 animate-spin text-[var(--ds-accent)]" />
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                Adding pages from{' '}
                <span className="font-medium text-[var(--ds-text)]">
                  {crawl.rootUrl || 'your new site'}
                </span>
                … {crawl.pagesCrawled}
                {crawl.discoveredTotal ? ` of ${crawl.discoveredTotal}` : ''} pages
              </p>
            </Card>
          )}

          {list.map((source) => {
            const urlSource = isUrl(source.name);
            const pages = pagesBySource[source.name] ?? [];
            const collapsible = urlSource && pages.length > 0;
            const isOpen = collapsible && (expanded[source.name] ?? list.length === 1);
            const toggle = () =>
              setExpanded((prev) => ({
                ...prev,
                [source.name]: !(prev[source.name] ?? list.length === 1),
              }));

            const header = (
              <>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
                  {urlSource ? <LinkIcon size={15} /> : <FileText size={15} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">
                    {source.name}
                  </p>
                  <p className="text-[12px] text-[var(--ds-text-subtle)]">
                    {urlSource ? 'Website' : 'Document'} · {pageLabel(source)}
                  </p>
                </div>
                <StatusBadge tone="success" dot>
                  Ready
                </StatusBadge>
              </>
            );

            return (
              <Card key={source.name} className="overflow-hidden">
                {collapsible ? (
                  <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--ds-bg-hover)]"
                  >
                    {header}
                    <ChevronDown
                      size={16}
                      className={cn(
                        'shrink-0 text-[var(--ds-text-subtle)] transition-transform',
                        isOpen && 'rotate-180',
                      )}
                    />
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-3">{header}</div>
                )}

                {isOpen && (
                  <ul className="divide-y divide-[var(--ds-border)] border-t border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]/40">
                    {pages.slice(0, 6).map((page, idx) => (
                      <li key={`${page.url}-${idx}`} className="px-4 py-2 pl-14">
                        <span className="block truncate font-mono text-[12px] leading-snug text-[var(--ds-accent-text)]">
                          {toPath(page.url)}
                        </span>
                        {page.title && (
                          <span className="mt-0.5 block truncate text-[11px] leading-snug text-[var(--ds-text-subtle)]">
                            {page.title}
                          </span>
                        )}
                      </li>
                    ))}
                    <li className="px-4 py-2 pl-14">
                      <button
                        type="button"
                        onClick={() => setDrawerSource(source.name)}
                        className="text-[12px] font-medium text-[var(--ds-accent-text)] hover:underline"
                      >
                        View all {pages.length} page{pages.length === 1 ? '' : 's'}
                      </button>
                    </li>
                  </ul>
                )}
              </Card>
            );
          })}

          {/* Add more knowledge */}
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
              Add more knowledge
            </p>

            {showAddSite ? (
              <Card className="space-y-3 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-[var(--ds-text)]">Add a website</span>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddSite(false);
                      setSiteUrl('');
                      setSiteEstimate(null);
                      setSiteSelectedUrls([]);
                    }}
                    aria-label="Cancel"
                    className="text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-text)]"
                  >
                    <X size={15} />
                  </button>
                </div>
                <div className="relative">
                  <Globe
                    size={16}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
                  />
                  <Input
                    value={siteUrl}
                    onChange={(e) => {
                      setSiteUrl(e.target.value);
                      setSiteEstimate(null);
                      setSiteSelectedUrls([]);
                    }}
                    placeholder="docs.yoursite.com"
                    className="pl-9"
                    autoFocus
                  />
                </div>
                {siteEstimate ? (
                  <div className="space-y-3">
                    {siteHasPageList && (
                      <CrawlPageTree
                        urls={siteEstimate.urls ?? []}
                        selected={siteSelectedUrls}
                        onSelectionChange={setSiteSelectedUrls}
                        disabled={siteBusy}
                      />
                    )}
                    {siteOverPlanCap && (
                      <p className="text-[12px] text-[var(--ds-warning)]">
                        Your plan covers {siteCap.toLocaleString()} more page
                        {siteCap === 1 ? '' : 's'}. Deselect{' '}
                        {(siteSelectedCount - siteCap).toLocaleString()} to continue.
                      </p>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[12px] text-[var(--ds-text-subtle)]">
                        {siteHasPageList ? (
                          <>
                            <span className="font-medium text-[var(--ds-text)]">
                              {siteSelectedCount.toLocaleString()}
                            </span>{' '}
                            of {siteEstimate.total_found.toLocaleString()} pages ·{' '}
                            <span className="font-medium text-[var(--ds-text)]">
                              {siteCost.toLocaleString()} credits
                            </span>
                          </>
                        ) : siteEstimate.total_found > 0 ? (
                          `${siteEstimate.total_found.toLocaleString()}${siteEstimate.capped ? '+' : ''} pages · ~${siteCost.toLocaleString()} credits`
                        ) : (
                          "We'll follow links from the homepage."
                        )}
                      </p>
                      <Button
                        size="sm"
                        onClick={handleAddSite}
                        disabled={
                          siteBusy ||
                          siteOverPlanCap ||
                          (siteHasPageList && siteSelectedCount === 0)
                        }
                      >
                        {siteBusy ? 'Starting…' : 'Train'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleDiscoverSite}
                    disabled={siteBusy || !siteUrl.trim()}
                  >
                    {siteBusy ? (
                      'Scanning…'
                    ) : (
                      <>
                        <Search size={14} /> Scan website
                      </>
                    )}
                  </Button>
                )}
              </Card>
            ) : (
              <button
                type="button"
                onClick={() => setShowAddSite(true)}
                className="flex w-full items-center gap-3 rounded-xl border border-dashed border-[var(--ds-border)] px-4 py-3 text-left transition-colors hover:border-[var(--ds-accent)]"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
                  <Globe size={15} />
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-[var(--ds-text)]">Add a website</p>
                  <p className="text-[12px] text-[var(--ds-text-subtle)]">
                    Train on another site or subdomain.
                  </p>
                </div>
              </button>
            )}

            <label className="block cursor-pointer">
              <div className="flex items-center gap-3 rounded-xl border border-dashed border-[var(--ds-border)] px-4 py-3 transition-colors hover:border-[var(--ds-accent)]">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
                  {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-[var(--ds-text)]">
                    {uploading ? 'Adding…' : 'Upload documents'}
                  </p>
                  <p className="text-[12px] text-[var(--ds-text-subtle)]">PDFs, docs or text.</p>
                </div>
                <Plus size={15} className="ml-auto shrink-0 text-[var(--ds-text-subtle)]" />
              </div>
              <input
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.txt,.md,image/*"
                className="hidden"
                disabled={uploading}
                onChange={(event) => {
                  if (event.target.files) handleFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </label>
          </div>

          {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}
        </div>

        {drawerSource && (
          <PagesDrawer
            source={drawerSource}
            pages={pagesBySource[drawerSource] ?? []}
            onClose={() => setDrawerSource(null)}
          />
        )}
      </StepShell>
    );
  }

  // ── 3. Scan & Select Sub-view (the step's entry point) ────────────
  // One screen: enter a URL, scan it, tick the pages, commit. The tree is the
  // review, so there is no separate confirmation screen between here and the
  // crawl - which makes the footer CTA the moment credits are spent, and the
  // cost sits directly above it.
  const hasDocuments = uploadedCount > 0 || (sources?.length ?? 0) > 0;
  const canScan = Boolean(url.trim()) && !discovering && !starting && !pagesLocked;
  const canContinue = estimate
    ? !starting &&
      !noBalance &&
      !overPlanCap &&
      (!hasPageList || selectedCount > 0)
    : hasDocuments && !uploadingDocs && !discovering;

  return (
    <StepShell
      title="Connect & Train Website"
      description="Point us at your website or upload documents to train your AI chatbot."
      onBack={props.onBack}
      onContinue={handlePrimary}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={canContinue}
      continueLabel={
        estimate ? (starting ? 'Starting…' : 'Train your chatbot') : undefined
      }
    >
      <div className="space-y-4">
        {pagesLocked ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-8 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
              <Globe size={18} aria-hidden="true" />
            </span>
            <div className="max-w-sm space-y-1">
              <p className="text-[14px] font-semibold text-[var(--ds-text)]">Page limit reached</p>
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                You&apos;ve used all {pagesLimit.toLocaleString()} website pages included on your
                plan. Upgrade to train more pages, or upload documents below.
              </p>
            </div>
            <Button
              onClick={() =>
                openUpgradeModal({
                  title: 'Page limit reached',
                  description:
                    "You've used all the website pages included on your plan. Upgrade to train more pages.",
                })
              }
            >
              <Lock size={13} aria-hidden="true" />
              Upgrade plan
            </Button>
          </Card>
        ) : (
          <>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]">
                Website address
              </span>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Globe
                    size={16}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
                  />
                  <Input
                    value={url}
                    onChange={(event) => {
                      urlEdited.current = true;
                      setUrl(event.target.value);
                      // A new address invalidates the pages found for the old one.
                      setEstimate(null);
                      setSelectedUrls([]);
                    }}
                    placeholder="yourcompany.com"
                    className="pl-9"
                    autoFocus
                  />
                </div>
                <Button variant="outline" onClick={handleScan} disabled={!canScan}>
                  {discovering ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Scanning…
                    </>
                  ) : (
                    <>
                      <Search size={16} /> Scan website
                    </>
                  )}
                </Button>
              </div>
              {!estimate && !discovering && (
                <p className="mt-1.5 text-[12px] text-[var(--ds-text-subtle)]">
                  Scan to see every page we found and pick the ones to train on. Scanning is free.
                </p>
              )}
            </label>

            {/* Scan results: what we found, then which pages to train on. */}
            {estimate && !discovering && (
              <div className="space-y-3">
                <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3 text-[13px] text-[var(--ds-text-muted)]">
                  {estimate.total_found > 0 ? (
                    <>
                      Found{' '}
                      <span className="font-semibold text-[var(--ds-text)]">
                        {estimate.total_found.toLocaleString()}
                        {estimate.capped ? '+' : ''} page
                        {estimate.total_found === 1 ? '' : 's'}
                      </span>
                      {hasPageList ? '. Choose which to train on below.' : '.'}
                    </>
                  ) : (
                    <>
                      No sitemap found - we&apos;ll follow links from your homepage to learn what we
                      can.
                    </>
                  )}
                </div>

                {hasPageList && (
                  <CrawlPageTree
                    urls={estimate.urls ?? []}
                    selected={selectedUrls}
                    onSelectionChange={setSelectedUrls}
                    disabled={starting}
                  />
                )}

                {overPlanCap && (
                  <div className="rounded-xl border border-[var(--ds-warning)]/30 bg-[var(--ds-warning-soft)] p-4">
                    <p className="text-[12px] text-[var(--ds-text)]">
                      Your plan covers {pageCap.toLocaleString()} more page
                      {pageCap === 1 ? '' : 's'}, but {selectedCount.toLocaleString()} are selected.
                      Deselect {(selectedCount - pageCap).toLocaleString()} to continue, or upgrade
                      for more.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() =>
                        openUpgradeModal({
                          title: 'Page limit reached',
                          description:
                            "You've selected more pages than your plan allows. Upgrade to train them all.",
                        })
                      }
                    >
                      <Lock size={13} aria-hidden="true" />
                      Upgrade plan
                    </Button>
                  </div>
                )}

                {overAffordable && !overPlanCap && (
                  <p className="text-[12px] text-[var(--ds-warning)]">
                    You&apos;ve selected more pages than your credits cover (about{' '}
                    {affordable.toLocaleString()} affordable). We&apos;ll train as many as your
                    balance allows, in order.
                  </p>
                )}

                {noBalance && (
                  <div className="rounded-xl border border-[var(--ds-warning)]/30 bg-[var(--ds-warning-soft)] p-4">
                    <p className="text-[12px] text-[var(--ds-text)]">
                      You need credits to train on this site. Top up to continue.
                    </p>
                    <Link to="/workspace/billing" className="mt-2 inline-block">
                      <Button variant="outline" size="sm">
                        Top up credits
                      </Button>
                    </Link>
                  </div>
                )}

                {/* The price of the CTA below, always reflecting the selection. */}
                <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div>
                    <p className="text-[13px] font-semibold text-[var(--ds-text)]">
                      {hasPageList
                        ? `${selectedCount.toLocaleString()} of ${estimate.total_found.toLocaleString()} page${estimate.total_found === 1 ? '' : 's'} selected`
                        : 'Training on your website'}
                    </p>
                    <p className="mt-0.5 text-[12px] text-[var(--ds-text-subtle)]">
                      {chargeablePages > 0
                        ? `About ${estimatedCost.toLocaleString()} credit${estimatedCost === 1 ? '' : 's'} · ${costPerPage} per page`
                        : `${costPerPage} credit${costPerPage === 1 ? '' : 's'} per page we learn`}
                    </p>
                  </div>
                </Card>
              </div>
            )}
          </>
        )}

        <div className="flex items-center gap-3 text-[12px] text-[var(--ds-text-subtle)]">
          <span className="h-px flex-1 bg-[var(--ds-border)]" />
          or
          <span className="h-px flex-1 bg-[var(--ds-border)]" />
        </div>

        <label className="block cursor-pointer">
          <Card className="flex items-center gap-3 p-4 transition-colors hover:border-[var(--ds-accent)]">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
              {uploadingDocs ? (
                <Loader2 size={17} className="animate-spin" />
              ) : uploadedCount > 0 ? (
                <FileCheck2 size={17} className="text-[var(--ds-success)]" />
              ) : (
                <Upload size={17} />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-[var(--ds-text)]">
                {uploadedCount > 0
                  ? `${uploadedCount} document${uploadedCount === 1 ? '' : 's'} added - add more or continue`
                  : 'No website? Upload documents'}
              </p>
              <p className="text-[12px] text-[var(--ds-text-subtle)]">
                PDFs, docs or text - a fallback for sites we can't crawl.
              </p>
            </div>
          </Card>
          <input
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.txt,.md,image/*"
            className="hidden"
            disabled={uploadingDocs}
            onChange={(event) => {
              if (event.target.files) handleFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </label>

        {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}
      </div>
    </StepShell>
  );
}
