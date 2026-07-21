import { useCallback, useEffect, useState } from 'react';
import {
  FileText,
  Link as LinkIcon,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Upload,
  Plus,
} from 'lucide-react';
import { Progress, Card, StatusBadge } from '../../../design-system';
import { getDocuments, getDocumentPages, uploadDocuments } from '../../../services/api';
import { useCrawl } from '../../../context/CrawlContext';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
import { PagesDrawer } from '../PagesDrawer';
import type { StepProps } from '../steps.config';
import type { KnowledgeSource, SourcePage } from '../../../types/domain';

function isUrl(name: string): boolean {
  return name.startsWith('http://') || name.startsWith('https://');
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
 * Step 4 — Knowledge (merged Training + Review). One state-driven surface: shows
 * LIVE training progress (crawl or document ingestion), then becomes the source
 * & page review once training finishes — with an "add more" upload and a
 * "view all pages" drawer.
 */
export function KnowledgeStep(props: StepProps) {
  const { crawl } = useCrawl();
  const { selectedBot } = useBotContext();

  const [sources, setSources] = useState<KnowledgeSource[] | null>(null);
  const [pagesBySource, setPagesBySource] = useState<Record<string, SourcePage[]>>({});
  const [drawerSource, setDrawerSource] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crawlRunning = crawl.status === 'running' || crawl.status === 'cancelling';
  const crawlFailed = crawl.status === 'failed' || crawl.status === 'no_content';

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

  // Load sources once the crawl isn't actively running; poll while empty
  // (documents still ingesting). Re-runs when the crawl finishes.
  useEffect(() => {
    if (!selectedBot || crawlRunning) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const data = await fetchSources();
        if (!cancelled && data.length === 0) timer = window.setTimeout(poll, 3000);
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [selectedBot, crawlRunning, fetchSources]);

  const handleFiles = async (fileList: FileList) => {
    if (!selectedBot || fileList.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      await uploadDocuments(Array.from(fileList), selectedBot.id);
      await fetchSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const reviewReady = (sources?.length ?? 0) > 0;
  const canContinue = reviewReady || (crawl.status !== 'idle' && crawl.pagesCrawled > 0);

  // ── Progress view (training / crawl failed) ──────────────────────
  if (!reviewReady) {
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
        canContinue={canContinue}
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
                This usually takes a few seconds. You can continue as soon as the first page is
                learned.
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

  // ── Review view (trained) ────────────────────────────────────────
  const list = sources ?? [];
  return (
    <StepShell
      title="What your AI learned"
      description="A quick look at your agent's knowledge before you test it."
      onBack={props.onBack}
      onContinue={props.onContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
      canContinue={canContinue}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-[13px] text-[var(--ds-success)]">
          <CheckCircle2 size={16} />
          <span className="font-medium">
            Trained on {list.length} source{list.length === 1 ? '' : 's'}
          </span>
        </div>

        {list.map((source) => {
          const url = isUrl(source.name);
          const pages = pagesBySource[source.name] ?? [];
          return (
            <Card key={source.name} className="overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
                  {url ? <LinkIcon size={15} /> : <FileText size={15} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">
                    {source.name}
                  </p>
                  <p className="text-[12px] text-[var(--ds-text-subtle)]">
                    {url ? 'Website' : 'Document'} · {pageLabel(source)}
                  </p>
                </div>
                <StatusBadge tone="success" dot>
                  Ready
                </StatusBadge>
              </div>

              {url && pages.length > 0 && (
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
        <label className="block cursor-pointer">
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-[var(--ds-border)] px-4 py-3 transition-colors hover:border-[var(--ds-accent)]">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
              {uploading ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-[var(--ds-text)]">
                {uploading ? 'Adding…' : 'Add more knowledge'}
              </p>
              <p className="text-[12px] text-[var(--ds-text-subtle)]">
                Upload PDFs, docs or text to teach your agent more.
              </p>
            </div>
            <Upload size={15} className="ml-auto shrink-0 text-[var(--ds-text-subtle)]" />
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
