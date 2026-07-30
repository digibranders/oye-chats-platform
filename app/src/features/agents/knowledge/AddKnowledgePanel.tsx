import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Globe,
  Loader2,
  Lock,
  Search,
  StopCircle,
  Upload,
  UploadCloud,
  Zap,
} from 'lucide-react';
import { Button, Card, Input, Progress, cn } from '../../../design-system';
import { discoverCrawlUrls, uploadDocuments } from '../../../services/api';
import { useCrawl } from '../../../context/CrawlContext';
import type { StartCrawlOptions } from '../../../context/CrawlContext';
import { useUpgradeModal } from '../../../context/UpgradeModalContext';
import type { CrawlDiscovery, CrawlStatus, KnowledgeSource } from '../../../types/domain';
import {
  SUPPORTED_EXTENSIONS,
  filterUploadFiles,
  hostOf,
  normalizeUrl,
} from './knowledge-utils';

type AddMode = 'website' | 'files';

export interface AddKnowledgePanelProps {
  /** The agent whose knowledge base is being extended. */
  agentId: number;
  agentName: string;
  /** Existing sources - used to warn when a site is already added. */
  existingSources: readonly KnowledgeSource[];
  /** Called after a source is added so the parent can refresh its list. */
  onChanged: () => void | Promise<void>;
  /** Softer heading when the agent has no knowledge yet. */
  isEmpty?: boolean;
  /** True when the workspace is at/over its `documents` plan limit - the
   * upload sub-flow is replaced with an upgrade prompt instead of the dropzone. */
  documentsLocked?: boolean;
  /** True when the workspace is at/over its `page_scraping` plan limit - the
   * website sub-flow is replaced with an upgrade prompt instead of the crawl form. */
  pagesLocked?: boolean;
}

/**
 * AddKnowledgePanel - the single "teach your AI more" surface. Two ways in:
 * crawl a website (discover page count, then ingest) or upload documents. Live
 * crawl progress is read from the shared CrawlContext so it stays in sync with
 * the global crawl indicator.
 */
export function AddKnowledgePanel({
  agentId,
  agentName,
  existingSources,
  onChanged,
  isEmpty = false,
  documentsLocked = false,
  pagesLocked = false,
}: AddKnowledgePanelProps): ReactElement {
  const { crawl, startCrawl, cancelCrawl } = useCrawl();
  const { openUpgradeModal } = useUpgradeModal();
  const [mode, setMode] = useState<AddMode>('website');

  // ── Website sub-flow ──────────────────────────────────────────────
  const [siteUrl, setSiteUrl] = useState('');
  const [estimate, setEstimate] = useState<CrawlDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [websiteError, setWebsiteError] = useState<string | null>(null);
  // JavaScript mode renders SPA sites (Next.js/React) before extracting text.
  const [useJs, setUseJs] = useState(false);
  // Two-step inline confirm for cancelling an in-progress crawl.
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // ── Upload sub-flow ───────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);

  // A crawl belongs to this agent when it's unscoped or explicitly ours. Kept
  // permissive so an in-progress crawl still surfaces here before it's scoped.
  const crawlOwned = crawl.botId === null || crawl.botId === agentId;
  const crawlRunning =
    crawlOwned && (crawl.status === 'running' || crawl.status === 'cancelling');
  // Strict ownership: only a crawl explicitly scoped to THIS agent. Terminal UI
  // that attributes learned pages to this agent gates on this, so a completed
  // unscoped crawl started elsewhere can't claim work (or clear inputs) here.
  const crawlIsOurs = crawl.botId === agentId;

  // Clear the website inputs once our crawl finishes cleanly, so the field is
  // ready for the next site. Reacts to a status transition - not a render-time
  // derivation - and is guarded so it can't loop.
  useEffect(() => {
    if (crawlIsOurs && crawl.status === 'done') {
      setSiteUrl('');
      setEstimate(null);
      setWebsiteError(null);
    }
  }, [crawl.status, crawlIsOurs]);

  const alreadyAddedHost = useMemo(() => {
    const trimmed = siteUrl.trim();
    if (!trimmed) return null;
    const host = hostOf(normalizeUrl(trimmed));
    const match = existingSources.find(
      (s) => (s.name.startsWith('http') ? hostOf(s.name) : '') === host,
    );
    return match ? host : null;
  }, [siteUrl, existingSources]);

  async function handleDiscover(): Promise<void> {
    const trimmed = siteUrl.trim();
    if (!trimmed || discovering) return;
    setDiscovering(true);
    setWebsiteError(null);
    setEstimate(null);
    try {
      const result = await discoverCrawlUrls(normalizeUrl(trimmed), agentId);
      setEstimate(result);
    } catch (err) {
      // Discovery is best-effort - the user can still crawl. Surface a gentle
      // note and fall back to a zero-count estimate that means "follow links".
      setEstimate({ total_found: 0, capped: false });
      setWebsiteError(
        err instanceof Error ? err.message : "We couldn't count the pages, but you can still add this site.",
      );
    } finally {
      setDiscovering(false);
    }
  }

  async function handleCrawl(): Promise<void> {
    const trimmed = siteUrl.trim();
    if (!trimmed) return;
    setWebsiteError(null);
    setCancelConfirm(false);
    setCancelError(null);
    try {
      const opts: StartCrawlOptions = {
        url: normalizeUrl(trimmed),
        botId: agentId,
        botName: agentName,
        useJs,
      };
      if (estimate && estimate.total_found > 0) opts.discoveredTotal = estimate.total_found;
      await startCrawl(opts);
    } catch (err) {
      setWebsiteError(
        err instanceof Error ? err.message : "We couldn't start training. Please try again.",
      );
    }
  }

  async function handleCancel(): Promise<void> {
    setCancelConfirm(false);
    setCancelError(null);
    try {
      await cancelCrawl();
    } catch (err) {
      setCancelError(
        err instanceof Error ? err.message : "We couldn't stop training. Please try again.",
      );
    }
  }

  async function handleFiles(fileList: FileList | File[]): Promise<void> {
    const { accepted, rejected } = filterUploadFiles(fileList);
    setUploadError(rejected.length ? rejected.join(' · ') : null);
    if (accepted.length === 0) return;
    setUploading(true);
    setUploadNote(null);
    try {
      await uploadDocuments(accepted, agentId);
      setUploadNote(
        `Added ${accepted.length} document${accepted.length === 1 ? '' : 's'}. Your AI is learning from it now.`,
      );
      await onChanged();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-[var(--ds-border)] p-5">
        <h2 className="text-[15px] font-semibold text-[var(--ds-text)]">
          {isEmpty ? 'Teach your AI' : 'Add more knowledge'}
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
          Crawl a website or upload documents. Everything you add becomes something your AI can
          answer from.
        </p>

        {/* Source-type switch */}
        <div
          role="group"
          aria-label="Choose how to add knowledge"
          className="mt-4 inline-flex rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-0.5"
        >
          {(
            [
              { key: 'website', label: 'Website', icon: Globe },
              { key: 'files', label: 'Documents', icon: FileText },
            ] as const
          ).map((tab) => {
            const selected = mode === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                aria-pressed={selected}
                onClick={() => setMode(tab.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                  selected
                    ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                    : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
                )}
              >
                <tab.icon size={14} aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-5">
        {mode === 'website' ? (
          pagesLocked ? (
            <LockedAddCard
              icon={Globe}
              title="Page limit reached"
              description="You've used all the website pages included on your plan. Upgrade to train more pages."
              onUpgrade={() =>
                openUpgradeModal({
                  title: 'Page limit reached',
                  description:
                    "You've used all the website pages included on your plan. Upgrade to train more pages.",
                })
              }
            />
          ) : (
          <div className="space-y-4">
            <div>
              <label
                htmlFor="knowledge-site-url"
                className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]"
              >
                Website address
              </label>
              <div className="relative">
                <Globe
                  size={16}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ds-text-subtle)]"
                />
                <Input
                  id="knowledge-site-url"
                  type="text"
                  inputMode="url"
                  value={siteUrl}
                  onChange={(e) => {
                    setSiteUrl(e.target.value);
                    setEstimate(null);
                    setWebsiteError(null);
                  }}
                  placeholder="example.com"
                  className="pl-9"
                  disabled={crawlRunning}
                />
              </div>
              {alreadyAddedHost && (
                <p className="mt-2 text-[12px] text-[var(--ds-text-subtle)]">
                  <span className="font-medium text-[var(--ds-text-muted)]">{alreadyAddedHost}</span>{' '}
                  is already in your knowledge base. Crawling again refreshes its pages.
                </p>
              )}
            </div>

            {/* JavaScript-mode toggle - renders SPA sites before extracting text. */}
            <button
              type="button"
              role="switch"
              aria-checked={useJs}
              onClick={() => {
                setUseJs((v) => !v);
                setEstimate(null);
              }}
              disabled={crawlRunning}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-60',
                useJs
                  ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                  : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] hover:border-[var(--ds-border-strong)]',
              )}
            >
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                  useJs
                    ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]'
                    : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]',
                )}
              >
                <Zap size={15} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-[var(--ds-text)]">
                  JavaScript mode
                </span>
                <span className="mt-0.5 block text-[12px] text-[var(--ds-text-muted)]">
                  Turn on for Next.js, React and other single-page-app sites.
                </span>
              </span>
              <span
                className={cn(
                  'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                  useJs ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-border-strong)]',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-4 w-4 rounded-full bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-sm)] transition-all',
                    useJs ? 'left-[18px]' : 'left-0.5',
                  )}
                />
              </span>
            </button>

            {/* Discovery estimate */}
            {estimate && !crawlRunning && (
              <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3 text-[13px] text-[var(--ds-text-muted)]">
                {estimate.total_found > 0 ? (
                  <>
                    Found{' '}
                    <span className="font-semibold text-[var(--ds-text)]">
                      {estimate.total_found.toLocaleString()}
                      {estimate.capped ? '+' : ''} page{estimate.total_found === 1 ? '' : 's'}
                    </span>
                    {typeof estimate.cost_per_page === 'number' && (
                      <>
                        {' '}· about{' '}
                        <span className="font-medium text-[var(--ds-text)]">
                          {(estimate.total_found * estimate.cost_per_page).toLocaleString()} credits
                        </span>
                      </>
                    )}
                    .
                  </>
                ) : (
                  <>We&apos;ll follow links from the homepage to learn what we can.</>
                )}
              </div>
            )}

            {/* Live crawl progress */}
            {crawlRunning ? (
              <div className="space-y-3">
                <CrawlProgress
                  pages={crawl.urls}
                  done={crawl.pagesCrawled}
                  total={crawl.discoveredTotal}
                  status={crawl.status}
                />
                {cancelConfirm ? (
                  <div
                    role="group"
                    aria-label="Confirm stopping training"
                    className="space-y-3 rounded-lg border border-[var(--ds-warning-soft)] bg-[var(--ds-warning-soft)] px-4 py-3"
                  >
                    <div className="text-[13px] text-[var(--ds-text)]">
                      <p className="font-medium">Stop training?</p>
                      <p className="mt-0.5 text-[var(--ds-text-muted)]">
                        Pages already discovered are discarded, and you won&apos;t be charged for a
                        training run that didn&apos;t finish.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void handleCancel()}
                        disabled={crawl.status === 'cancelling' || crawl.cancelInFlight}
                      >
                        <StopCircle size={14} aria-hidden="true" /> Stop training
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setCancelConfirm(false)}>
                        Keep training
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCancelConfirm(true)}
                    disabled={crawl.status === 'cancelling' || crawl.cancelInFlight}
                  >
                    {crawl.status === 'cancelling' || crawl.cancelInFlight ? (
                      <>
                        <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Stopping…
                      </>
                    ) : (
                      <>
                        <StopCircle size={14} aria-hidden="true" /> Cancel training
                      </>
                    )}
                  </Button>
                )}
                {cancelError && (
                  <StatusNote tone="danger" icon={AlertCircle}>
                    {cancelError}
                  </StatusNote>
                )}
              </div>
            ) : crawlIsOurs && crawl.status === 'done' ? (
              <StatusNote tone="success" icon={CheckCircle2}>
                Finished - your AI learned {crawl.pagesCrawled} page
                {crawl.pagesCrawled === 1 ? '' : 's'}.
              </StatusNote>
            ) : crawlIsOurs && (crawl.status === 'failed' || crawl.status === 'no_content') ? (
              <StatusNote tone="danger" icon={AlertCircle}>
                {crawl.error ||
                  (crawl.status === 'no_content'
                    ? "We couldn't read any content from that site. Try a different URL or upload documents instead."
                    : "We couldn't finish reading that site.")}
              </StatusNote>
            ) : null}

            {websiteError && (
              <StatusNote tone="danger" icon={AlertCircle}>
                {websiteError}
              </StatusNote>
            )}

            <div className="flex items-center gap-2">
              {estimate ? (
                <Button onClick={handleCrawl} disabled={crawlRunning || !siteUrl.trim()}>
                  {crawlRunning ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Crawling…
                    </>
                  ) : (
                    <>
                      <Globe size={16} /> Add this website
                    </>
                  )}
                </Button>
              ) : (
                <Button
                  onClick={handleDiscover}
                  disabled={discovering || crawlRunning || !siteUrl.trim()}
                >
                  {discovering ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Checking pages…
                    </>
                  ) : (
                    <>
                      <Search size={16} /> Check pages
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
          )
        ) : documentsLocked ? (
          <LockedAddCard
            icon={FileText}
            title="Document limit reached"
            description="You've used all the documents included on your plan. Upgrade to add more."
            onUpgrade={() =>
              openUpgradeModal({
                title: 'Document limit reached',
                description:
                  "You've used all the documents included on your plan. Upgrade to add more.",
              })
            }
          />
        ) : (
          <div className="space-y-4">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
              }}
              className={cn(
                'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
                dragging
                  ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                  : 'border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]',
              )}
            >
              <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
                <UploadCloud size={24} aria-hidden="true" />
              </span>
              <p className="text-[13px] font-medium text-[var(--ds-text)]">
                Drag and drop documents here
              </p>
              <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">
                {SUPPORTED_EXTENSIONS.join(', ').toUpperCase()} · up to 10 MB each
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={SUPPORTED_EXTENSIONS.join(',')}
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  if (e.target.files) void handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? (
                  <>
                    <Loader2 size={15} className="animate-spin" /> Adding…
                  </>
                ) : (
                  <>
                    <Upload size={15} /> Browse files
                  </>
                )}
              </Button>
            </div>

            {uploadNote && (
              <StatusNote tone="success" icon={CheckCircle2}>
                {uploadNote}
              </StatusNote>
            )}
            {uploadError && (
              <StatusNote tone="danger" icon={AlertCircle}>
                {uploadError}
              </StatusNote>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Local presentational helpers ────────────────────────────────────

/** Replaces a sub-flow (website or files) when its plan quota is exhausted. */
function LockedAddCard({
  icon: Icon,
  title,
  description,
  onUpgrade,
}: {
  icon: typeof Globe;
  title: string;
  description: string;
  onUpgrade: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-6 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-[14px] font-semibold text-[var(--ds-text)]">{title}</p>
        <p className="text-[13px] text-[var(--ds-text-muted)]">{description}</p>
      </div>
      <Button onClick={onUpgrade}>
        <Lock size={13} aria-hidden="true" />
        Upgrade plan
      </Button>
    </div>
  );
}

function CrawlProgress({
  pages,
  done,
  total,
  status,
}: {
  pages: string[];
  done: number;
  total: number | null;
  status: CrawlStatus;
}): ReactElement {
  const percent =
    status === 'done'
      ? 100
      : total && total > 0
        ? Math.min(99, Math.round((done / total) * 100))
        : done > 0
          ? 60
          : 20;
  return (
    <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-4">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text)]">
        <Loader2 size={15} className="animate-spin text-[var(--ds-accent)]" aria-hidden="true" />
        Reading your site
        {total ? (
          <span className="ml-auto tabular-nums text-[var(--ds-text-muted)]">
            {done} of {total} pages
          </span>
        ) : done > 0 ? (
          <span className="ml-auto tabular-nums text-[var(--ds-text-muted)]">
            {done} page{done === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
      <Progress value={percent} label="Training progress" />
      {pages.length > 0 && (
        <p className="mt-3 truncate text-[12px] text-[var(--ds-text-subtle)]">
          Latest: {pages[pages.length - 1]}
        </p>
      )}
    </div>
  );
}

function StatusNote({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'success' | 'danger';
  icon: typeof CheckCircle2;
  children: ReactNode;
}): ReactElement {
  const styles =
    tone === 'success'
      ? 'border-[var(--ds-success-soft)] bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
      : 'border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]';
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[13px]', styles)}>
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0">{children}</p>
    </div>
  );
}
