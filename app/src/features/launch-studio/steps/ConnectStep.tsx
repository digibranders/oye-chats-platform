import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Upload, Loader2, FileCheck2, Sparkles } from 'lucide-react';
import { Input, Card, Button } from '../../../design-system';
import {
  updateBot,
  uploadDocuments,
  discoverCrawlUrls,
  recordActivationEvent,
} from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useCrawl } from '../../../context/CrawlContext';
import type { StartCrawlOptions } from '../../../context/CrawlContext';
import { StepShell } from '../StepShell';
import type { StepProps } from '../steps.config';
import type { CrawlDiscovery } from '../../../types/domain';

type CrawlOrder = 'shallow' | 'discovered';

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

/**
 * Step 3 — Connect Website. Discovers pages first and shows the page count +
 * credit estimate before crawling (matches the old flow), then confirms →
 * crawl. Or upload documents instead (a real fallback that also lets you proceed).
 */
export function ConnectStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const { crawl, startCrawl } = useCrawl();
  const [url, setUrl] = useState(selectedBot?.website ?? '');
  const [uploadedCount, setUploadedCount] = useState(0);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [estimate, setEstimate] = useState<CrawlDiscovery | null>(null);
  const [crawlCount, setCrawlCount] = useState(0);
  const [crawlOrder, setCrawlOrder] = useState<CrawlOrder>('shallow');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const costPerPage = estimate?.cost_per_page ?? 1;
  const exceeds = Boolean(estimate?.exceeds_balance);
  const affordable = estimate?.max_affordable_pages ?? 0;
  const noBalance = exceeds && affordable === 0;

  const handleFiles = async (fileList: FileList) => {
    if (!selectedBot || fileList.length === 0) return;
    setUploadingDocs(true);
    setError(null);
    try {
      await uploadDocuments(Array.from(fileList), selectedBot.id);
      setUploadedCount((c) => c + fileList.length);
      void recordActivationEvent('documents_uploaded', { botId: selectedBot.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploadingDocs(false);
    }
  };

  // True when this exact site is already crawled/crawling for this agent, so we
  // must NOT re-crawl (idempotent back-navigation).
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

  // Phase 1 → discover (or proceed on the docs path).
  const handleDiscover = async () => {
    const trimmed = url.trim();
    if (!trimmed && uploadedCount > 0) {
      props.onContinue();
      return;
    }
    if (!trimmed || !selectedBot) return;

    // Already trained on this site (e.g. returning from a later step) — just move on.
    if (alreadyCrawled(normalizeUrl(trimmed))) {
      props.onContinue();
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
      // Discovery failed — let them crawl anyway (homepage-link crawl).
      setEstimate({ total_found: 0, capped: false });
      setCrawlCount(0);
    } finally {
      setDiscovering(false);
    }
  };

  // Phase 2 → start the crawl with the chosen scope.
  const handleConfirmCrawl = async () => {
    if (!selectedBot || !estimate) return;
    const site = normalizeUrl(url.trim());
    setStarting(true);
    setError(null);
    try {
      await updateBot(selectedBot.id, { website: site });
      // Idempotent: don't restart a crawl that's already running/done for this site.
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
      props.onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start. Please try again.");
    } finally {
      setStarting(false);
    }
  };

  // ── Confirm phase ────────────────────────────────────────────────
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
                    : "No sitemap found — we'll follow links from your homepage."}
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

  // ── Input phase ──────────────────────────────────────────────────
  const canContinue =
    (url.trim().length > 0 || uploadedCount > 0) && !discovering && !uploadingDocs;

  return (
    <StepShell
      title="Connect your website"
      description="Your AI learns from your website. Drop in your address and we'll do the rest."
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
                  ? `${uploadedCount} document${uploadedCount === 1 ? '' : 's'} added — add more or continue`
                  : 'No website? Upload documents'}
              </p>
              <p className="text-[12px] text-[var(--ds-text-subtle)]">
                PDFs, docs or text — a fallback for sites we can't crawl.
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
