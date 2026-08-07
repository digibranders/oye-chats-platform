import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Globe,
  Upload,
  Loader2,
  FileCheck2,
  Sparkles,
  FileText,
  Link as LinkIcon,
  CheckCircle2,
  AlertTriangle,
  Plus,
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
} from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useCrawl } from '../../../context/CrawlContext';
import type { StartCrawlOptions } from '../../../context/CrawlContext';
import { StepShell } from '../StepShell';
import { PagesDrawer } from '../PagesDrawer';
import type { StepProps } from '../steps.config';
import type { KnowledgeSource, SourcePage, CrawlDiscovery } from '../../../types/domain';

type CrawlOrder = 'shallow' | 'discovered';

function isUrl(name: string): boolean {
  return name.startsWith('http://') || name.startsWith('https://');
}
function normalizeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}
function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 99;
  }
}
function sliceForCrawl(urls: string[], order: CrawlOrder, count: number): string[] {
  const ordered = order === 'shallow' ? [...urls].sort((a, b) => pathDepth(a) - pathDepth(b)) : urls;
  return ordered.slice(0, count);
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
 * Merges website URL entry, discovery estimation, crawl execution, live progress,
 * and knowledge review into one unified state-driven step.
 */
export function TrainStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const { crawl, startCrawl } = useCrawl();

  // Connect / Input states
  const [url, setUrl] = useState(selectedBot?.website ?? '');
  const [uploadedCount, setUploadedCount] = useState(0);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [estimate, setEstimate] = useState<CrawlDiscovery | null>(null);
  const [crawlCount, setCrawlCount] = useState(0);
  const [crawlOrder, setCrawlOrder] = useState<CrawlOrder>('shallow');
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
  const [siteBusy, setSiteBusy] = useState(false);

  const crawlRunning = crawl.status === 'running' || crawl.status === 'cancelling';
  const crawlFailed = crawl.status === 'failed' || crawl.status === 'no_content';

  const costPerPage = estimate?.cost_per_page ?? 1;
  const exceeds = Boolean(estimate?.exceeds_balance);
  const affordable = estimate?.max_affordable_pages ?? 0;
  const noBalance = exceeds && affordable === 0;

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

  const handleDiscover = async () => {
    const trimmed = url.trim();
    if (!trimmed && (uploadedCount > 0 || (sources?.length ?? 0) > 0)) {
      props.onContinue();
      return;
    }
    if (!trimmed || !selectedBot) return;

    if (alreadyCrawled(normalizeUrl(trimmed))) {
      await fetchSources();
      return;
    }

    setDiscovering(true);
    setError(null);
    try {
      const result = await discoverCrawlUrls(normalizeUrl(trimmed), selectedBot.id);
      setEstimate(result);
      setCrawlCount(
        result.exceeds_balance ? (result.max_affordable_pages ?? 0) : (result.total_found ?? 0),
      );
    } catch {
      setEstimate({ total_found: 0, capped: false });
      setCrawlCount(0);
    } finally {
      setDiscovering(false);
    }
  };

  const handleConfirmCrawl = async () => {
    if (!selectedBot || !estimate) return;
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
        if (estimate.total_found > 0) opts.discoveredTotal = estimate.total_found;
        if (estimate.exceeds_balance && estimate.urls?.length && crawlCount > 0) {
          opts.orderedUrls = sliceForCrawl(estimate.urls, crawlOrder, crawlCount);
          opts.maxPages = crawlCount;
        }
        await startCrawl(opts);
        void recordActivationEvent('crawl_started', { botId: selectedBot.id });
      }
      setEstimate(null); // Move to progress/training view
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start. Please try again.");
    } finally {
      setStarting(false);
    }
  };

  const handleDiscoverSite = async () => {
    if (!selectedBot || !siteUrl.trim()) return;
    setSiteBusy(true);
    setError(null);
    try {
      const res = await discoverCrawlUrls(normalizeUrl(siteUrl.trim()), selectedBot.id);
      setSiteEstimate(res);
    } catch {
      setSiteEstimate({ total_found: 0, capped: false });
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
      if (siteEstimate.total_found > 0) opts.discoveredTotal = siteEstimate.total_found;
      await startCrawl(opts);
      setShowAddSite(false);
      setSiteUrl('');
      setSiteEstimate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start training. Please try again.");
    } finally {
      setSiteBusy(false);
    }
  };

  const reviewReady = (sources?.length ?? 0) > 0;
  const inTraining = crawlRunning || (crawl.status !== 'idle' && !reviewReady);

  // ── 1. Estimate / Discovery Confirm Sub-view ──────────────────────
  if (estimate) {
    const pages = estimate.total_found;
    const chosen = exceeds && affordable > 0 ? crawlCount : pages;
    const cost = (chosen || pages || 0) * costPerPage;

    return (
      <StepShell
        title="Ready to train?"
        description="Here's what we'll learn from your website."
        onBack={() => setEstimate(null)}
        onContinue={handleConfirmCrawl}
        isFirst={props.isFirst}
        isLast={props.isLast}
        canContinue={!starting && !noBalance}
        continueLabel={
          starting
            ? 'Starting…'
            : pages > 0
              ? `Train ${(chosen || pages).toLocaleString()} page${(chosen || pages) === 1 ? '' : 's'}`
              : 'Start training'
        }
      >
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
                <Sparkles size={19} />
              </div>
              <div>
                <p className="text-[15px] font-semibold text-[var(--ds-text)]">
                  {pages > 0
                    ? `${pages.toLocaleString()}${estimate.capped ? '+' : ''} page${pages === 1 ? '' : 's'} found`
                    : 'Ready to train your AI'}
                </p>
                <p className="mt-0.5 text-[12px] text-[var(--ds-text-subtle)]">
                  {pages > 0
                    ? `About ${cost.toLocaleString()} credit${cost === 1 ? '' : 's'} · ${costPerPage} per page`
                    : "No sitemap found - we'll follow links from your homepage."}
                </p>
              </div>
            </div>

            {exceeds && affordable > 0 && estimate.urls?.length ? (
              <div className="mt-4 rounded-xl border border-[var(--ds-warning)]/30 bg-[var(--ds-warning-soft)] p-4">
                <p className="text-[12px] text-[var(--ds-text)]">
                  This site needs {(estimate.credits_required_full ?? 0).toLocaleString()} credits, but
                  you have {(estimate.balance ?? 0).toLocaleString()}. Choose how many pages to train:
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={affordable}
                    value={crawlCount}
                    onChange={(e) => setCrawlCount(Number(e.target.value))}
                    className="flex-1 accent-[var(--ds-accent)]"
                    aria-label="Pages to train"
                  />
                  <span className="w-24 text-right text-[12px] font-medium text-[var(--ds-text)]">
                    {crawlCount} × {costPerPage} = {(crawlCount * costPerPage).toLocaleString()}
                  </span>
                </div>
                <div className="mt-3 flex gap-4 text-[12px] text-[var(--ds-text-muted)]">
                  {(['shallow', 'discovered'] as const).map((order) => (
                    <label key={order} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        checked={crawlOrder === order}
                        onChange={() => setCrawlOrder(order)}
                        className="accent-[var(--ds-accent)]"
                      />
                      {order === 'shallow' ? 'Top pages first' : 'Site order'}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            {noBalance && (
              <div className="mt-4 rounded-xl border border-[var(--ds-warning)]/30 bg-[var(--ds-warning-soft)] p-4">
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
          </Card>
          {error && <p className="text-[12px] text-[var(--ds-danger)]">{error}</p>}
        </div>
      </StepShell>
    );
  }

  // ── 2. Live Training Progress Sub-view ────────────────────────────
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
        description="We're reading your content and turning it into knowledge your agent can use."
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

  // ── 3. Knowledge Review Sub-view (Trained) ────────────────────────
  if (reviewReady) {
    const list = sources ?? [];
    return (
      <StepShell
        title="What your AI learned"
        description="A quick look at your agent's knowledge before you test it."
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
                    }}
                    placeholder="docs.yoursite.com"
                    className="pl-9"
                    autoFocus
                  />
                </div>
                {siteEstimate ? (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[12px] text-[var(--ds-text-subtle)]">
                      {siteEstimate.total_found > 0
                        ? `${siteEstimate.total_found.toLocaleString()}${siteEstimate.capped ? '+' : ''} pages · ~${(siteEstimate.total_found * (siteEstimate.cost_per_page ?? 1)).toLocaleString()} credits`
                        : "We'll follow links from the homepage."}
                    </p>
                    <Button size="sm" onClick={handleAddSite} disabled={siteBusy}>
                      {siteBusy ? 'Starting…' : 'Train'}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleDiscoverSite}
                    disabled={siteBusy || !siteUrl.trim()}
                  >
                    {siteBusy ? 'Checking…' : 'Check pages'}
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

  // ── 4. Initial Connect Website Input Sub-view ─────────────────────
  const canContinue =
    (url.trim().length > 0 || uploadedCount > 0) && !discovering && !uploadingDocs;

  return (
    <StepShell
      title="Connect & Train Website"
      description="Point us at your website or upload documents to train your AI chatbot."
      onBack={props.onBack}
      onContinue={handleDiscover}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={canContinue}
      continueLabel={discovering ? 'Analyzing…' : undefined}
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]">
            Website address
          </span>
          <div className="relative">
            <Globe
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
            />
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="yourcompany.com"
              className="pl-9"
              autoFocus
            />
          </div>
        </label>

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
