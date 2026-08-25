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
import { DataTable, type Column } from '../../../design-system/components/DataTable';
import { useAgent } from '../../../context/AgentContext';
import { useCrawl } from '../../../context/CrawlContext';
import type { StartCrawlOptions } from '../../../context/CrawlContext';
import { useUpgradeModal } from '../../../context/UpgradeModalContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getDocuments, getDocumentPages, deleteDocument, getKnowledgeState } from '../../../services/api';
import type { KnowledgeSource, SourcePage } from '../../../types/domain';
import { PagesDrawer } from '../../launch-studio/PagesDrawer';
import { AddKnowledgePanel } from './AddKnowledgePanel';

import { AutoRecrawlCard } from './AutoRecrawlCard';
import { RecrawlMenu } from './RecrawlMenu';
import { RecrawlDiffModal } from './RecrawlDiffModal';
import {
  asApiError,
  crawlUrlFor,
  fetchRecrawlDiff,
  rootDomainOf,
  type RecrawlDiff,
  type RecrawlMode,
} from './recrawl-api';
import {
  formatRelativeDate,
  isUrlSource,
  lastUpdatedIso,
  totalWebsitePages,
  unitLabelOf,
} from './knowledge-utils';

/**
 * Plan slugs that unlock delta ("updated pages only") recrawl. Mirrors
 * `plan_service._DELTA_RECRAWL_PLAN_SLUGS`, which is a bare membership test.
 * NOT the `planIncludes` ladder in `lib/planGates`, whose rule 2 hands an
 * unrecognised (bespoke) slug the feature. A bespoke contract slug gets a full
 * recrawl here exactly as the server gives it one, so the UI can't promise a
 * cheaper crawl than the API will run.
 */
const DELTA_RECRAWL_SLUGS: ReadonlySet<string> = new Set([
  'standard',
  'professional',
  'enterprise',
]);

/**
 * KnowledgePage - the agent's "Knowledge" tab. Answers one question: *what does
 * my AI know?* It lists every learned source (websites + documents), summarises
 * coverage, and lets the user add or remove knowledge. All crawl lifecycle is
 * owned by the shared CrawlContext; this page reads it and refreshes when a
 * crawl finishes.
 */
export function KnowledgePage(): ReactElement {
  const { agent, loading: agentLoading } = useAgent();
  const agentId = agent?.id ?? null;
  const agentName = agent?.name ?? null;
  const { crawl, startCrawl } = useCrawl();
  const { entitlements, limitFor, withinLimit, planSlug } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();

  // Delta ("updated pages only") re-crawl is a Standard+ perk. The menu still
  // surfaces the option to lower tiers for discoverability; clicks route to the
  // upgrade flow instead of the diff endpoint. The backend re-enforces the gate.
  // Every paid tier from Standard up must be listed or it is wrongly shown an
  // upgrade badge for a mode its own API already runs. Enterprise especially:
  // it is the agency tier with pooled credits across many client sites, so
  // falling back to a full recrawl would re-embed and charge for every page of
  // every site on the plan sold with the largest ingestion volume.
  const canUseDeltaRecrawl = DELTA_RECRAWL_SLUGS.has(planSlug);

  const [sources, setSources] = useState<KnowledgeSource[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // True when a plan lapse to Free deactivated this bot's knowledge (there are
  // inactive chunks). Drives the "re-crawl / upgrade to reactivate" banner. A
  // brand-new Free bot has no inactive chunks, so it never shows.
  const [knowledgeDeactivated, setKnowledgeDeactivated] = useState(false);

  const refreshKnowledgeState = useCallback(async (): Promise<void> => {
    if (agentId == null) {
      setKnowledgeDeactivated(false);
      return;
    }
    try {
      const state = await getKnowledgeState(agentId);
      setKnowledgeDeactivated(Boolean(state?.deactivated));
    } catch {
      // Non-fatal: the banner is a nudge, never block the page on it.
    }
  }, [agentId]);

  // ── Re-crawl lifecycle ────────────────────────────────────────────
  const [recrawlLoadingFor, setRecrawlLoadingFor] = useState<string | null>(null);
  const [recrawlDiff, setRecrawlDiff] = useState<RecrawlDiff | null>(null);
  const [recrawlDiffError, setRecrawlDiffError] = useState<string | null>(null);
  const [recrawlStarting, setRecrawlStarting] = useState(false);
  // Bumped when a crawl finishes so AutoRecrawlCard reloads its last-run summary.
  const [recrawlReloadToken, setRecrawlReloadToken] = useState(0);

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
      void refreshKnowledgeState();
    } catch (err) {
      if (activeAgentIdRef.current !== requestedFor) return;
      setActionError(
        err instanceof Error ? err.message : "We couldn't refresh your knowledge sources.",
      );
    }
  }, [agentId, refreshKnowledgeState]);

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
        if (!cancelled) {
          setSources(data ?? []);
          void refreshKnowledgeState();
        }
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
  }, [agentId, refreshKnowledgeState]);

  // When a crawl for THIS agent reaches a terminal state, pull the fresh source
  // list so newly-learned pages appear.
  const crawlOwned = crawl.botId === null || crawl.botId === agentId;
  const crawlRunning = crawlOwned && (crawl.status === 'running' || crawl.status === 'cancelling');
  useEffect(() => {
    if (!crawlOwned) return;
    if (crawl.status === 'done' || crawl.status === 'cancelled') {
      void refresh();
      // Surface the fresh last-run summary in the auto-recrawl card.
      setRecrawlReloadToken((n) => n + 1);
    }
  }, [crawl.status, crawlOwned, refresh]);

  // ── Re-crawl actions ──────────────────────────────────────────────
  const closeRecrawlModal = useCallback((): void => {
    setRecrawlDiff(null);
    setRecrawlDiffError(null);
  }, []);

  // Fetch the pre-recrawl diff for a source, then open the cost-preview modal.
  // On a plan-gated delta request we route to the upgrade flow; on a soft
  // failure we still open the modal so the user can proceed without the preview.
  const requestRecrawl = useCallback(
    async (name: string, mode: RecrawlMode): Promise<void> => {
      if (agentId == null) return;
      const crawlUrl = crawlUrlFor(name);
      const replaceSource = rootDomainOf(name);
      setRecrawlLoadingFor(name);
      setActionError(null);
      setRecrawlDiff(null);
      setRecrawlDiffError(null);
      try {
        const data = await fetchRecrawlDiff(crawlUrl, replaceSource, agentId, mode);
        setRecrawlDiff({ mode, docName: name, crawlUrl, replaceSource, ...data });
      } catch (err) {
        const apiErr = asApiError(err);
        const detail = typeof apiErr.detail === 'object' ? apiErr.detail : undefined;
        if (
          apiErr.status === 403 &&
          detail?.error === 'feature_not_available' &&
          detail?.feature === 'delta_recrawl'
        ) {
          openUpgradeModal({
            title: 'Updated-pages-only re-train',
            description:
              'Re-training only the pages that changed is available on the Standard plan. Upgrade to unlock it.',
          });
          return;
        }
        if (apiErr.status === 429) {
          setActionError(
            'Too many training requests - please wait a few minutes before training again.',
          );
          return;
        }
        // Network/auth failure - still let the user proceed with a plain confirm.
        setRecrawlDiff({
          mode,
          docName: name,
          crawlUrl,
          replaceSource,
          sitemapTotal: 0,
          unchanged: 0,
          newPages: 0,
          removedPages: 0,
          unchangedUrls: [],
          newUrls: [],
          removedUrls: [],
          costPerPage: 1,
          creditsRequiredFull: 0,
          balance: 0,
          exceedsBalance: false,
          capped: true,
        });
        setRecrawlDiffError(
          apiErr.message ??
            (typeof apiErr.detail === 'string' ? apiErr.detail : "We couldn't preview the changes."),
        );
      } finally {
        setRecrawlLoadingFor(null);
      }
    },
    [agentId, openUpgradeModal],
  );

  // Confirm the previewed re-crawl. Prefer the diff's exact URL list (more
  // reliable + faster than re-running the recursive crawler) unless the diff
  // was capped/truncated/errored, in which case the backend re-discovers.
  const confirmRecrawl = useCallback(async (): Promise<void> => {
    const diff = recrawlDiff;
    if (diff == null || agentId == null) return;

    // Guard (money): a full re-crawl where discovery SUCCEEDED but found zero
    // pages (HTTP 200, sitemap_total=0) means the sitemap was temporarily
    // unavailable - we don't know the site's page set, and with force_reingest
    // this would silently re-scrape+re-bill every stale stored URL. Refuse.
    // Mirrors the modal's block; this is the non-UI safety net. The explicit
    // preview-failure path (recrawlDiffError set) is exempt: it deliberately
    // proceeds with ordered_urls omitted so the backend re-discovers. Delta is
    // unaffected - it reconciles against stored URLs at ingest time.
    if (diff.mode === 'full' && diff.sitemapTotal === 0 && recrawlDiffError === null) {
      setActionError(
        "No pages discovered - the site's sitemap may be temporarily unavailable; try again shortly.",
      );
      return;
    }

    // The preview buckets are capped at 500 URLs while the counts are full, so
    // if either bucket was truncated the union is only a partial slice of the
    // real crawl set. Passing a partial list as authoritative would silently
    // skip every page beyond the cap (under-refresh). In that case - or when
    // discovery itself was capped - omit ordered_urls so the backend re-crawls
    // the whole site by discovery (an empty/omitted list means "crawl all").
    const listsTruncated =
      diff.newUrls.length < diff.newPages || diff.unchangedUrls.length < diff.unchanged;
    const orderedUrls =
      diff.capped || listsTruncated
        ? null
        : Array.from(new Set([...diff.newUrls, ...diff.unchangedUrls])).filter(Boolean);
    setRecrawlStarting(true);
    setActionError(null);
    try {
      const opts: StartCrawlOptions = {
        url: diff.crawlUrl,
        botId: agentId,
        botName: agentName,
        // NOTE: JS-rendering mode isn't persisted on the source record
        // (KnowledgeSource carries no per-source JS flag, and we may only edit
        // files under features/agents/knowledge/), so a SPA source originally
        // crawled with useJs:true re-crawls HTTP-only here and may return empty.
        // Carry the flag through once the source record exposes it.
        useJs: false,
        replaceSource: diff.replaceSource,
        mode: diff.mode,
        orderedUrls: orderedUrls && orderedUrls.length > 0 ? orderedUrls : null,
        expectedNewPages: diff.mode === 'delta' ? diff.newPages : null,
      };
      await startCrawl(opts);
      closeRecrawlModal();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "We couldn't start the re-train. Please try again.",
      );
    } finally {
      setRecrawlStarting(false);
    }
  }, [recrawlDiff, recrawlDiffError, agentId, agentName, startCrawl, closeRecrawlModal]);

  const handleGetCredits = useCallback((): void => {
    closeRecrawlModal();
    openUpgradeModal({
      title: 'Not enough credits',
      description: 'Upgrade your plan or buy a top-up to run this full re-train.',
    });
  }, [closeRecrawlModal, openUpgradeModal]);

  const openPages = useCallback(
    async (source: string): Promise<void> => {
      setDrawerSource(source);
      // A cached entry (even an empty array) means we loaded successfully - skip
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
  // `documents` is a usage-populated key (backend counts uploaded files) -
  // prefer it, falling back to what this page already loaded. `page_scraping`
  // is NOT populated server-side, so "used" is always derived from the sum of
  // this agent's crawled page counts (`stats.websitePages`) - never fabricated.
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
        // Display-only column - the real field is unused; `render` supplies the cell.
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
                <>
                  <Button variant="ghost" size="sm" onClick={() => void openPages(row.name)}>
                    View pages
                  </Button>
                  <RecrawlMenu
                    canUseDelta={canUseDeltaRecrawl}
                    loading={recrawlLoadingFor === row.name}
                    disabled={crawlRunning}
                    onFullRecrawl={() => void requestRecrawl(row.name, 'full')}
                    onDeltaRecrawl={() => void requestRecrawl(row.name, 'delta')}
                    onUpgrade={() =>
                      openUpgradeModal({
                        title: 'Updated-pages-only re-train',
                        description:
                          'Re-training only the pages that changed is available on the Standard plan. Upgrade to unlock it.',
                      })
                    }
                  />
                </>
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
    [
      confirmingDelete,
      deleting,
      handleDelete,
      openPages,
      cancelConfirm,
      canUseDeltaRecrawl,
      recrawlLoadingFor,
      crawlRunning,
      requestRecrawl,
      openUpgradeModal,
    ],
  );

  // ── Render ────────────────────────────────────────────────────────
  const loading = agentLoading || (agentId != null && sources === null && loadError === null);

  return (
    <PageContainer>
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
          title="Chatbot not found"
          description="We couldn't find this chatbot. Pick a chatbot from the list and try again."
        />
      ) : (
        <div className="space-y-6">
          {knowledgeDeactivated && (
            <div
              className="flex items-start gap-3 rounded-2xl border border-[var(--ds-info)] bg-[var(--ds-info-soft)] p-4"
              role="status"
            >
              <span
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ds-info)] text-white"
                aria-hidden="true"
              >
                <Sparkles size={16} />
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-[var(--ds-text)]">
                  Your knowledge is paused on Free
                </p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
                  Your assistant kept its data but stopped answering from it when your plan moved to
                  Free. Re-crawl your website or upload documents below to reactivate it on Free.
                  Upgrade to restore all of your previous knowledge instantly.
                </p>
              </div>
            </div>
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
                    every agent - not just the rows visible on this agent's page. */}
                <p className="text-[11px] text-[var(--ds-text-subtle)]">
                  Across all chatbots in your workspace
                </p>
              </div>
              <div className="space-y-1">
                <QuotaMeter label="Website pages" used={pagesUsed} limit={pagesLimit} />
                <p className="text-[11px] text-[var(--ds-text-subtle)]">This chatbot</p>
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
            agentName={agent?.name ?? 'your chatbot'}
            agentWebsite={agent?.website ?? null}
            existingSources={sources ?? []}
            onChanged={refresh}
            isEmpty={stats.total === 0}
            documentsLocked={documentsAtLimit}
            pagesLocked={pagesAtLimit}
          />

          <AutoRecrawlCard
            botId={agentId}
            reloadToken={recrawlReloadToken}
            onUpgrade={() =>
              openUpgradeModal({
                title: 'Weekly auto-retrain',
                description:
                  'Automatically refresh your trained websites every week on the Standard plan. Upgrade to enable it.',
              })
            }
          />
        </div>
      )}

      {recrawlDiff && (
        <RecrawlDiffModal
          open
          diff={recrawlDiff}
          error={recrawlDiffError}
          starting={recrawlStarting}
          onConfirm={() => void confirmRecrawl()}
          onGetCredits={handleGetCredits}
          onClose={closeRecrawlModal}
        />
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
