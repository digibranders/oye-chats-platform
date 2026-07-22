import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BookOpen,
  FileText,
  Globe,
  Layers,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  Button,
  EmptyState,
  PageContainer,
  QuotaMeter,
  SectionHeader,
  Skeleton,
  StatusBadge,
} from '../../../design-system';
import { MetricCard } from '../../../design-system/components/MetricCard';
import { InsightCard } from '../../../design-system/components/InsightCard';
import { DataTable, type Column } from '../../../design-system/components/DataTable';
import { useAgent } from '../../../context/AgentContext';
import { useCrawl } from '../../../context/CrawlContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getDocuments, getDocumentPages, deleteDocument } from '../../../services/api';
import type { KnowledgeSource, SourcePage } from '../../../types/domain';
import { PagesDrawer } from '../../launch-studio/PagesDrawer';
import { AddKnowledgePanel } from './AddKnowledgePanel';
import {
  formatRelativeDate,
  isUrlSource,
  lastUpdatedIso,
  totalWebsitePages,
  unitLabelOf,
} from './knowledge-utils';

/**
 * KnowledgePage — the agent's "Knowledge" tab. Answers one question: *what does
 * my AI know?* It lists every learned source (websites + documents), summarises
 * coverage, and lets the user add or remove knowledge. All crawl lifecycle is
 * owned by the shared CrawlContext; this page reads it and refreshes when a
 * crawl finishes.
 */
export function KnowledgePage(): ReactElement {
  const { agent, loading: agentLoading } = useAgent();
  const agentId = agent?.id ?? null;
  const { crawl } = useCrawl();
  const { entitlements, limitFor, withinLimit } = useEntitlements();

  const [sources, setSources] = useState<KnowledgeSource[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [pagesBySource, setPagesBySource] = useState<Record<string, SourcePage[]>>({});
  const [drawerSource, setDrawerSource] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Tracks the currently-active agent so in-flight fetches issued for a previous
  // agent can detect they're stale and skip writing to state.
  const activeAgentIdRef = useRef<number | null>(agentId);
  // Row name whose delete-trigger should regain focus after a cancelled confirm.
  const restoreFocusRef = useRef<string | null>(null);
  // Live map of each row's delete-trigger button, for focus restoration.
  const deleteTriggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Re-fetch WITHOUT clearing the current list, so mutations update in place
  // instead of flashing the whole table back to a skeleton.
  const refresh = useCallback(async (): Promise<void> => {
    if (agentId == null) return;
    const requestedFor = agentId;
    try {
      const data = await getDocuments(agentId);
      // Drop the result if the user switched agents while this was in flight.
      if (activeAgentIdRef.current !== requestedFor) return;
      setSources(data ?? []);
    } catch (err) {
      if (activeAgentIdRef.current !== requestedFor) return;
      setActionError(
        err instanceof Error ? err.message : "We couldn't refresh your knowledge sources.",
      );
    }
  }, [agentId]);

  // Initial / agent-switch load. The reset lives inside the async task (not the
  // effect body) so no state is set synchronously during the effect.
  useEffect(() => {
    activeAgentIdRef.current = agentId;
    if (agentId == null) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      setSources(null);
      setLoadError(null);
      setActionError(null);
      try {
        const data = await getDocuments(agentId);
        if (!cancelled) setSources(data ?? []);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "We couldn't load what your AI knows.",
          );
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // When a crawl for THIS agent reaches a terminal state, pull the fresh source
  // list so newly-learned pages appear.
  const crawlOwned = crawl.botId === null || crawl.botId === agentId;
  useEffect(() => {
    if (!crawlOwned) return;
    if (crawl.status === 'done' || crawl.status === 'cancelled') {
      void refresh();
    }
  }, [crawl.status, crawlOwned, refresh]);

  const openPages = useCallback(
    async (source: string): Promise<void> => {
      setDrawerSource(source);
      // A cached entry (even an empty array) means we loaded successfully — skip
      // the refetch. A failed load leaves the key unset so reopening retries.
      if (agentId == null || pagesBySource[source]) return;
      try {
        const res = await getDocumentPages(source, agentId);
        setPagesBySource((prev) => ({ ...prev, [source]: res.pages ?? [] }));
      } catch (err) {
        // Leave the key unset so reopening the drawer retries the fetch, and
        // surface the failure instead of silently showing an empty list.
        setActionError(
          err instanceof Error ? err.message : "We couldn't load this source's pages.",
        );
      }
    },
    [agentId, pagesBySource],
  );

  const handleDelete = useCallback(
    async (name: string): Promise<void> => {
      if (agentId == null) return;
      setDeleting(name);
      setActionError(null);
      try {
        await deleteDocument(name, agentId);
        setSources((prev) => (prev ? prev.filter((s) => s.name !== name) : prev));
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : "We couldn't remove this source. Please try again.",
        );
      } finally {
        setDeleting(null);
        setConfirmingDelete(null);
      }
    },
    [agentId],
  );

  // When a delete confirmation is cancelled, its Remove/Cancel buttons unmount;
  // return focus to that row's trigger so it doesn't fall to <body>.
  useEffect(() => {
    if (confirmingDelete !== null) return;
    const pending = restoreFocusRef.current;
    if (pending === null) return;
    restoreFocusRef.current = null;
    deleteTriggerRefs.current.get(pending)?.focus();
  }, [confirmingDelete]);

  const cancelConfirm = useCallback((name: string): void => {
    restoreFocusRef.current = name;
    setConfirmingDelete(null);
  }, []);

  const stats = useMemo(() => {
    const list = sources ?? [];
    const websites = list.filter((s) => isUrlSource(s.name)).length;
    const documents = list.length - websites;
    return {
      total: list.length,
      websites,
      documents,
      websitePages: totalWebsitePages(list),
      lastUpdated: formatRelativeDate(lastUpdatedIso(list)),
    };
  }, [sources]);

  // ── Plan quotas ──────────────────────────────────────────────────
  // `documents` is a usage-populated key (backend counts uploaded files) —
  // prefer it, falling back to what this page already loaded. `page_scraping`
  // is NOT populated server-side, so "used" is always derived from the sum of
  // this agent's crawled page counts (`stats.websitePages`) — never fabricated.
  const documentsUsed = entitlements.usage.documents ?? stats.documents;
  const documentsLimit = limitFor('documents');
  const documentsAtLimit = !withinLimit('documents', documentsUsed);

  const pagesUsed = stats.websitePages;
  const pagesLimit = limitFor('page_scraping');
  const pagesAtLimit = !withinLimit('page_scraping', pagesUsed);

  const columns = useMemo<Column<KnowledgeSource>[]>(
    () => [
      {
        key: 'name',
        header: 'Source',
        render: (row) => <SourceCell source={row} />,
      },
      {
        // Display-only column — the real field is unused; `render` supplies the cell.
        key: 'doc_page_count',
        header: 'Type',
        width: '8rem',
        render: (row) => (
          <span className="text-[var(--ds-text-muted)]">
            {isUrlSource(row.name) ? 'Website' : 'Document'}
          </span>
        ),
      },
      {
        key: 'page_count',
        header: 'Size',
        width: '8rem',
        render: (row) => (
          <span className="tabular-nums text-[var(--ds-text-muted)]">{unitLabelOf(row)}</span>
        ),
      },
      {
        key: 'ingested_at',
        header: 'Added',
        width: '9rem',
        render: (row) => (
          <span className="text-[var(--ds-text-subtle)]">{formatRelativeDate(row.ingested_at)}</span>
        ),
      },
      {
        // Display-only column for row actions.
        key: 'chunk_count',
        header: 'Actions',
        align: 'right',
        width: '13rem',
        render: (row) =>
          confirmingDelete === row.name ? (
            <div
              role="group"
              aria-label={`Confirm removing ${row.name}`}
              className="flex items-center justify-end gap-2"
            >
              <Button
                variant="danger"
                size="sm"
                autoFocus
                onClick={() => void handleDelete(row.name)}
                disabled={deleting === row.name}
              >
                {deleting === row.name ? 'Removing…' : 'Remove'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => cancelConfirm(row.name)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-1">
              {isUrlSource(row.name) && (
                <Button variant="ghost" size="sm" onClick={() => void openPages(row.name)}>
                  View pages
                </Button>
              )}
              <Button
                ref={(el) => {
                  if (el) deleteTriggerRefs.current.set(row.name, el);
                  else deleteTriggerRefs.current.delete(row.name);
                }}
                variant="ghost"
                size="icon"
                aria-label={`Remove ${row.name}`}
                onClick={() => setConfirmingDelete(row.name)}
              >
                <Trash2 size={16} aria-hidden="true" />
              </Button>
            </div>
          ),
      },
    ],
    [confirmingDelete, deleting, handleDelete, openPages, cancelConfirm],
  );

  // ── Render ────────────────────────────────────────────────────────
  const loading = agentLoading || (agentId != null && sources === null && loadError === null);

  return (
    <PageContainer
      title="Knowledge"
      description="Everything your AI can answer from — the websites and documents it has learned."
    >
      {loading ? (
        <LoadingState />
      ) : loadError ? (
        <EmptyState
          icon={BookOpen}
          title="We couldn't load your knowledge"
          description={loadError}
          action={
            <Button variant="outline" onClick={() => void refresh()}>
              Try again
            </Button>
          }
        />
      ) : agentId == null ? (
        <EmptyState
          icon={BookOpen}
          title="Agent not found"
          description="We couldn't find this agent. Pick an agent from the list and try again."
        />
      ) : (
        <div className="space-y-6">
          {stats.total > 0 && (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <MetricCard label="Sources" value={stats.total.toLocaleString()} icon={Layers} />
                <MetricCard
                  label="Website pages"
                  value={stats.websitePages.toLocaleString()}
                  icon={Globe}
                />
                <MetricCard
                  label="Documents"
                  value={stats.documents.toLocaleString()}
                  icon={FileText}
                />
                <MetricCard label="Last updated" value={stats.lastUpdated} icon={Sparkles} />
              </div>

              <InsightCard
                tone="success"
                icon={Sparkles}
                title={`Your AI answers from ${stats.total} source${stats.total === 1 ? '' : 's'}`}
                body="Visitors get answers grounded in this knowledge. Add more sources any time to widen what your AI can confidently cover — and remove anything that's out of date."
              />
            </>
          )}

          <section aria-labelledby="knowledge-quotas-heading" className="space-y-3">
            <SectionHeader
              title={<span id="knowledge-quotas-heading">Plan limits</span>}
              description="How much of your plan's knowledge capacity is in use."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <QuotaMeter label="Documents" used={documentsUsed} limit={documentsLimit} />
                {/* The `documents` limit is workspace-scoped, so this count spans
                    every agent — not just the rows visible on this agent's page. */}
                <p className="text-[11px] text-[var(--ds-text-subtle)]">
                  Across all agents in your workspace
                </p>
              </div>
              <div className="space-y-1">
                <QuotaMeter label="Website pages" used={pagesUsed} limit={pagesLimit} />
                <p className="text-[11px] text-[var(--ds-text-subtle)]">This agent</p>
              </div>
            </div>
          </section>

          {actionError && (
            <div
              role="alert"
              className="rounded-lg border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-4 py-3 text-[13px] text-[var(--ds-danger)]"
            >
              {actionError}
            </div>
          )}

          <section aria-labelledby="knowledge-sources-heading" className="space-y-4">
            <SectionHeader
              title={<span id="knowledge-sources-heading">Sources</span>}
              description="Websites and documents your AI has learned from."
            />
            {stats.total === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="Your AI hasn't learned anything yet"
                description="Add your first website or document below. As soon as it's processed, your AI can answer questions about it."
              />
            ) : (
              <DataTable
                columns={columns}
                rows={sources ?? []}
                rowKey={(row) => row.name}
                caption="Your AI's knowledge sources"
              />
            )}
          </section>

          <AddKnowledgePanel
            agentId={agentId}
            agentName={agent?.name ?? 'your agent'}
            existingSources={sources ?? []}
            onChanged={refresh}
            isEmpty={stats.total === 0}
            documentsLocked={documentsAtLimit}
            pagesLocked={pagesAtLimit}
          />
        </div>
      )}

      {drawerSource && (
        <PagesDrawer
          source={drawerSource}
          pages={pagesBySource[drawerSource] ?? []}
          onClose={() => setDrawerSource(null)}
        />
      )}
    </PageContainer>
  );
}

// ── Local presentational helpers ────────────────────────────────────

function SourceCell({ source }: { source: KnowledgeSource }): ReactElement {
  const isWebsite = isUrlSource(source.name);
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
        {isWebsite ? <Globe size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="truncate text-[13px] font-medium text-[var(--ds-text)]"
          title={source.name}
        >
          {source.name}
        </span>
        <StatusBadge tone="success" dot>
          Ready
        </StatusBadge>
      </div>
    </div>
  );
}

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[92px] w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
