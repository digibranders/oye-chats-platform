import { useCallback, useEffect, useState } from 'react';
import {
  FileText,
  Link as LinkIcon,
  CheckCircle2,
  Upload,
  Loader2,
  Plus,
  ExternalLink,
} from 'lucide-react';
import { Card, StatusBadge, Skeleton, EmptyState } from '../../../design-system';
import { getDocuments, getDocumentPages, uploadDocuments } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { StepShell } from '../StepShell';
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
 * Step 5 — Knowledge Review. Shows the REAL sources the agent learned from
 * (getDocuments), the pages under each website (getDocumentPages), and lets the
 * user add more documents before testing.
 */
export function ReviewStep(props: StepProps) {
  const { selectedBot } = useBotContext();
  const [sources, setSources] = useState<KnowledgeSource[] | null>(null);
  const [pagesBySource, setPagesBySource] = useState<Record<string, SourcePage[]>>({});
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedBot) return;
    try {
      const data = await getDocuments(selectedBot.id);
      setSources(data);
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
    } catch {
      setSources([]);
    }
  }, [selectedBot]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleFiles = async (fileList: FileList) => {
    if (!selectedBot || fileList.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      await uploadDocuments(Array.from(fileList), selectedBot.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const loading = Boolean(selectedBot) && sources === null;
  const list = sources ?? [];

  return (
    <StepShell
      title="What your AI learned"
      description="A quick look at your agent's knowledge before you test it."
      onBack={props.onBack}
      onContinue={props.onContinue}
      isFirst={props.isFirst}
      isLast={props.isLast}
    >
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {list.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No sources yet"
              description="Add a document below, or go back to connect a website."
            />
          ) : (
            <>
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
                        {pages.slice(0, 10).map((page, idx) => (
                          <li
                            key={`${page.url}-${idx}`}
                            className="group grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 pl-14"
                          >
                            <div className="min-w-0">
                              <span className="block truncate font-mono text-[12px] leading-snug text-[var(--ds-accent-text)]">
                                {toPath(page.url)}
                              </span>
                              {page.title && (
                                <span className="mt-0.5 block truncate text-[11px] leading-snug text-[var(--ds-text-subtle)]">
                                  {page.title}
                                </span>
                              )}
                            </div>
                            <a
                              href={page.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${page.url}`}
                              className="rounded p-1 text-[var(--ds-text-subtle)] opacity-0 transition-opacity hover:text-[var(--ds-accent-text)] group-hover:opacity-100"
                            >
                              <ExternalLink size={12} />
                            </a>
                          </li>
                        ))}
                        {pages.length > 10 && (
                          <li className="px-4 py-2.5 pl-14 text-[12px] text-[var(--ds-text-subtle)]">
                            + {pages.length - 10} more page{pages.length - 10 === 1 ? '' : 's'}
                          </li>
                        )}
                      </ul>
                    )}
                  </Card>
                );
              })}
            </>
          )}

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
      )}
    </StepShell>
  );
}
