import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Columns,
  ErrorState,
  LockedState,
  Page,
  PageHeader,
  Skeleton,
  Stack,
  StatRow,
  buttonClass,
  formatDate,
  formatNumber,
} from '../../../ui';
import { deleteDocument } from '../../../services/api';
import { useAgent } from '../../../context/AgentContext';
import { useCrawl, type StartCrawlOptions } from '../../../context/CrawlContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { agentHealth } from '../../home/agentHealth';
import type { Bot, KnowledgeSource } from '../../../types/domain';
import { AgentHealthStrip } from '../AgentHealthStrip';
import { AddKnowledgePanel } from './add/AddKnowledgePanel';
import { agentPath } from '../../../shell/nav';
import { AutoRetrainCard } from './AutoRetrainCard';
import { PagesDrawer } from './PagesDrawer';
import { RecrawlDialog } from './RecrawlDialog';
import { SourcesTable } from './SourcesTable';
import { errorMessage, fetchRecrawlDiff, isPlanLocked } from './knowledge-api';
import {
  allowanceOf,
  canUseDeltaRecrawl,
  crawlUrlFor,
  planCeiling,
  recrawlStartPlan,
  rootDomainOf,
  summarise,
  type SourceKind,
  type RecrawlDiff,
  type RecrawlMode,
  type RecrawlTarget,
} from './knowledge-model';
import { useKnowledgeData } from './useKnowledgeData';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * A chatbot's knowledge.
 *
 * It answers one question first — **what can this chatbot actually answer?** —
 * and only then what was last done to it. That order is the correction the page
 * it replaces needed most: it led with a plan-limits panel, and it rendered a
 * source's state as a hardcoded green "Ready" badge on every row regardless of
 * anything the server said.
 *
 * **Two panes, because the loop on this page is two-way.** The customer looks at
 * what the chatbot has read, decides what is missing, and adds it — and the
 * panel that adds sat *above* the table of what exists, roughly 600px away, so
 * the loop was a scroll each way and on a chatbot with fifteen sources the
 * table's first row was below the fold on every visit. Sources take the wide
 * column; the add panel is a form, and a form at 896px puts its label a screen
 * from its control.
 *
 * **"What your plan includes" is gone from here.** It was 70 lines and ~260px of
 * a full-width card describing *workspace-wide* allowances on a *per-chatbot*
 * page, with a "See plans" link that appeared twice inside the same card — and
 * the add panel stated the same document quota twice more, so a customer on this
 * page read it four times. The three quotas are `Meter`s inside the add panel
 * now, in the flow that is actually about to spend them; the workspace-wide view
 * of them belongs under `/billing`.
 *
 * Four things this closes that the backend has always supported and no screen
 * ever showed: the ingestion job behind an upload (`GET /ingest/status/{id}`,
 * which had no client function at all), the window on the knowledge-gap list,
 * the knowledge-base character quota, and the crawl allowance — stated before a
 * crawl is started rather than as a 403 after one fails.
 */
export function KnowledgePage() {
  const { t } = useTranslation();
  const { agent, loading, error, refresh } = useAgent();

  if (agent) {
    // Keyed on the chatbot, so switching remounts rather than rendering one
    // chatbot's sources under another's name for a frame.
    return <KnowledgeContent key={agent.id} agent={agent} />;
  }

  if (loading) {
    return (
      <Page width="wide">
        <PageHeader title={t('agents.knowledge') || 'Knowledge'} />
        <Stack>
          <Card>
            <CardBody className="flex items-center gap-3">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-64" />
            </CardBody>
          </Card>
          <Card>
            <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-6 w-16" />
                </div>
              ))}
            </CardBody>
          </Card>
        </Stack>
      </Page>
    );
  }

  if (error?.status === 403) {
    return (
      <Page width="wide">
        <PageHeader title={t('agents.knowledge') || 'Knowledge'} />
        <LockedState
          title={t('agents.thisChatbotIsNotYours') || 'This chatbot is not yours to see'}
          description={t('agents.askAnOwnerOrAdmin') || 'Ask an owner or admin of this workspace for access.'}
          action={
            <Link to="/chatbots" className={buttonClass('secondary', 'md')}>
              {t('agents.backToYourChatbots') || 'Back to your chatbots'}
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader title={t('agents.knowledge') || 'Knowledge'} />
      <Card>
        <ErrorState
          title={error ? t('agents.weCouldNotLoadThis') || 'We could not load this chatbot' : t('agents.chatbotNotFound') || 'Chatbot not found'}
          description={
            error
              ? error.message || t('agents.somethingWentWrongWhileLoading') || 'Something went wrong while loading this workspace.'
              : t('agents.thisChatbotDoesNotExist2') || 'This chatbot does not exist in this workspace.'
          }
          onRetry={() => void refresh()}
        />
      </Card>
    </Page>
  );
}

function KnowledgeContent({ agent }: { agent: Bot }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // The source search and type filter live in the URL for the same reason the
  // chatbot list's do: "open Knowledge, filter to documents" should be a link.
  const sourceQuery = params.get('q') ?? '';
  const sourceKindParam = params.get('kind');
  const sourceKind: SourceKind =
    sourceKindParam === 'websites' || sourceKindParam === 'documents' ? sourceKindParam : 'all';
  const { entitlements, planSlug, planName, loading: planLoading } = useEntitlements();
  const { crawl, startCrawl } = useCrawl();
  const knowledge = useKnowledgeData(agent.id);
  const { refresh: refreshAgent } = useAgent();

  const [drawerSource, setDrawerSource] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── Re-crawl ─────────────────────────────────────────────────────────────
  // The target lives on the state, not on the diff. It is known from the source
  // row the moment the customer clicks, and a preview that never arrives must
  // not take the URL, the replace key or the requested mode down with it.
  const [recrawl, setRecrawl] = useState<
    | (RecrawlTarget & {
        sourceName: string;
        diff: RecrawlDiff | null;
        loading: boolean;
        previewError: string | null;
        planLocked: boolean;
        starting: boolean;
        startError: string | null;
      })
    | null
  >(null);

  const sources = knowledge.sources.data;
  const summary = useMemo(() => summarise(sources), [sources]);
  const health = agentHealth(agent);
  const indexed = Number(agent.indexed_chunk_count ?? 0);

  const crawlOwned = crawl.botId === null || crawl.botId === agent.id;
  const crawlRunning = crawlOwned && (crawl.status === 'running' || crawl.status === 'cancelling');
  /**
   * The site being read right now, so its row in the table can say "Training"
   * instead of reporting whatever it held when the run started.
   */
  const crawlingDomain =
    crawlRunning && crawl.rootUrl ? rootDomainOf(crawl.rootUrl) : null;

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (value === null || value === '') updated.delete(key);
          else updated.set(key, value);
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );


  // Depends on `refreshAll`, never on the whole `knowledge` object: that object
  // is rebuilt on every render, so a callback keyed on it would change identity
  // every render — and this one is passed to children that call it from an
  // effect, which turns a changing identity into a refetch loop.
  const { refreshAll } = knowledge;
  const refreshEverything = useCallback(() => {
    // The chatbot record too: the passage count and the health line read the
    // `Bot`, not the source list, so refetching sources alone left a stale
    // "nothing to answer from" on screen that no amount of clicking could clear.
    void refreshAgent();
    refreshAll();
  }, [refreshAgent, refreshAll]);

  const usage = entitlements.usage as Record<string, number | undefined>;
  const limits = entitlements.limits as unknown as Record<string, number | undefined>;

  // Every allowance below reads the widened `limits` view rather than
  // `limitFor`, which collapses a missing plan key to `0`. That collapse is the
  // server's deny-by-default for enforcement and a lie when rendered: "we do
  // not know your allowance" and "your allowance is spent" are different
  // sentences, and only the first survives a key the plan row never carried.
  // `allowanceOf` returns `null` for an absent ceiling, and no flow locks on it.
  //
  // Workspace-wide on BOTH sides. `usage.documents` counts every uploaded file
  // on the account (`_build_usage`), `limits.documents` is the account's
  // ceiling, and `DocumentsFlow` labels the meter as workspace-wide. The old
  // `?? summary.documents` fallback swapped the numerator to THIS chatbot's own
  // sources whenever the server omitted the counter, so the same bar compared a
  // chatbot against a workspace without saying which it was doing.
  const documentAllowance = allowanceOf(usage.documents ?? 0, limits.documents);

  // No meter for website pages, deliberately. `usage.page_scraping` is never
  // populated server-side (`_build_usage` leaves it to callers that need it),
  // so the only numerator available is this chatbot's stored pages, all time,
  // while `limits.page_scraping` is the ACCOUNT's per-period ceiling. They
  // share neither scope nor period, and pairing them told a workspace that had
  // spent nothing that it had nothing left. Both are passed as what they are.
  const pageLimit = planCeiling(limits.page_scraping);

  // `knowledge_characters` is in the entitlements payload, both the plan limit
  // and a real usage counter, but not in the `LimitKey` union, which lives
  // outside this surface. Read through the same widened view.
  const characterAllowance = allowanceOf(usage.knowledge_characters ?? 0, limits.knowledge_characters);

  const requestRecrawl = useCallback(
    async (source: KnowledgeSource, mode: RecrawlMode) => {
      setActionError(null);
      const target: RecrawlTarget = {
        crawlUrl: crawlUrlFor(source.name),
        replaceSource: rootDomainOf(source.name),
        mode,
      };
      if (mode === 'delta' && !canUseDeltaRecrawl(planSlug)) {
        setRecrawl({
          ...target,
          sourceName: source.name,
          diff: null,
          loading: false,
          previewError: null,
          planLocked: true,
          starting: false,
          startError: null,
        });
        return;
      }

      const { crawlUrl, replaceSource } = target;
      setRecrawl({
        ...target,
        sourceName: source.name,
        diff: null,
        loading: true,
        previewError: null,
        planLocked: false,
        starting: false,
        startError: null,
      });

      try {
        const data = await fetchRecrawlDiff(crawlUrl, replaceSource, agent.id, mode);
        setRecrawl((current) =>
          current === null
            ? current
            : {
                ...current,
                loading: false,
                diff: { ...data, mode, sourceName: source.name, crawlUrl, replaceSource },
              },
        );
      } catch (cause) {
        if (isPlanLocked(cause, 'delta_recrawl')) {
          setRecrawl((current) =>
            current === null ? current : { ...current, loading: false, planLocked: true },
          );
          return;
        }
        // The preview is a courtesy, not a gate: a network hiccup must not be
        // the reason a customer cannot refresh their own website. So the run
        // stays available and the backend rediscovers the site itself, but the
        // diff stays NULL.
        //
        // It used to be filled with a synthetic all-zero comparison, including
        // an invented `balance: 0` that was never read from anywhere, and the
        // dialog priced the run off it: "Cost 0 credits", "0 pages × 1 credits",
        // and an enabled "Re-train 0 pages for 0 credits" over a
        // `force_reingest` that re-reads and re-bills every stored page. On a
        // 400-page site at 5 credits that button promised 0 and spent 2,000.
        setRecrawl((current) =>
          current === null
            ? current
            : {
                ...current,
                loading: false,
                diff: null,
                previewError: errorMessage(cause, t('agents.weCouldNotCompareThe') || 'We could not compare the pages.'),
              },
        );
      }
    },
    [agent.id, planSlug, t],
  );

  const confirmRecrawl = useCallback(async () => {
    const current = recrawl;
    // A failed preview leaves no diff and the run still goes ahead, so the gate
    // is the plan lock and the dialog's own state, never the presence of counts.
    if (current === null || current.planLocked || current.loading) return;
    setRecrawl({ ...current, starting: true, startError: null });
    try {
      const plan = recrawlStartPlan(current, current.diff);
      const options: StartCrawlOptions = {
        url: plan.crawlUrl,
        botId: agent.id,
        botName: agent.name ?? null,
        // A source record carries no per-source JavaScript flag, so a site
        // originally trained with JS rendering re-trains HTTP-only here. Named
        // rather than hidden: it is the difference between a full refresh and
        // an empty one on a single-page site.
        useJs: false,
        replaceSource: plan.replaceSource,
        mode: plan.mode,
        orderedUrls: plan.orderedUrls,
        // The denominator the progress bar was missing. Without it the bar fell
        // back to `crawl.maxPages`, the server's `effective_max_pages`, which
        // on an unlimited plan is `balance / cost_per_page`, so re-training a
        // 47-page site read "3 of 9,800 pages" and never appeared to move.
        discoveredTotal: plan.discoveredTotal,
        expectedNewPages: plan.expectedNewPages,
      };
      await startCrawl(options);
      setRecrawl(null);
    } catch (cause) {
      setRecrawl((state) =>
        state === null
          ? state
          : {
              ...state,
              starting: false,
              startError: errorMessage(cause, t('agents.weCouldNotStartThe3') || 'We could not start the re-train. Please try again.'),
            },
      );
    }
  }, [recrawl, agent.id, agent.name, startCrawl, t]);

  const removeSource = useCallback(
    async (source: KnowledgeSource) => {
      setActionError(null);
      try {
        await deleteDocument(source.name, agent.id);
        refreshEverything();
      } catch (cause) {
        setActionError(
          errorMessage(cause, t('agents.weCouldNotRemoveThat') || 'We could not remove that source. Nothing has been deleted.'),
        );
      }
    },
    [agent.id, refreshEverything, t],
  );

  if (knowledge.sources.forbidden) {
    return (
      <Page width="wide">
        <PageHeader title={t('agents.knowledge') || 'Knowledge'} />
        <LockedState
          title={t('agents.thisChatbotsKnowledgeIsNot') || 'This chatbot\'s knowledge is not yours to see'}
          description={t('agents.askAnOwnerOrAdmin') || 'Ask an owner or admin of this workspace for access.'}
          action={
            <Link to="/chatbots" className={buttonClass('secondary', 'md')}>
              {t('agents.backToYourChatbots') || 'Back to your chatbots'}
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title={t('agents.knowledge') || 'Knowledge'}
        actions={
          // `loading` carries both the spinner and `aria-busy`. The hand-rolled
          // `animate-spin` it replaces froze at 0° under reduced motion.
          <Button loading={knowledge.refreshing} onClick={refreshEverything}>
            {t('agents.refresh') || 'Refresh'}
          </Button>
        }
      />

      <Stack>
        {/* A paused knowledge base and a failed delete are page-scope facts, not
            bands inside a card that has no header to name them. */}
        {knowledge.state.data.deactivated ? (
          <Alert
            tone="plan"
            title={t('agents.thisKnowledgeIsPaused') || 'This knowledge is paused'}
            action={
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                {t('agents.seePlans') || 'See plans'}
              </Link>
            }
          >
            <span className="figure">{formatNumber(knowledge.state.data.inactive_count)}</span>{' '}
            passages stopped being used when your plan moved to Free. Add one new source to
            reactivate them, or move to a paid plan to restore everything.
          </Alert>
        ) : null}
        {actionError ? (
          <Alert tone="danger" live>
            {actionError}
          </Alert>
        ) : null}

        <AgentHealthStrip agent={agent} health={health} />

        <Card>
          <CardHeader size="sm" title={t('agents.whatItKnows') || 'What it knows'} titleAs="h2" />
          <CardBody flush>
            <StatRow
              period="Right now"
              label={t('agents.knowledgeHeld') || 'Knowledge held'}
              columns={4}
              items={[
                {
                  label: t('agents.passages') || 'Passages',
                  value: indexed > 0 ? formatNumber(indexed) : undefined,
                  size: 'lg',
                  empty: t('agents.nothingIndexed') || 'Nothing indexed',
                },
                {
                  label: t('agents.sources') || 'Sources',
                  value: summary.total > 0 ? formatNumber(summary.total) : undefined,
                  period: `${formatNumber(summary.websites)} websites · ${formatNumber(summary.documents)} documents`,
                  size: 'lg',
                  loading: knowledge.sources.loading,
                },
                {
                  label: t('agents.websitePages') || 'Website pages',
                  value: summary.websitePages > 0 ? formatNumber(summary.websitePages) : undefined,
                  period: t('agents.readFromYourSites') || 'Read from your sites',
                  size: 'lg',
                  loading: knowledge.sources.loading,
                },
                {
                  label: t('agents.lastTrained') || 'Last trained',
                  value: summary.lastIngestedAt ? formatDate(summary.lastIngestedAt) : undefined,
                  period: t('agents.mostRecentSourceAdded') || 'Most recent source added',
                  size: 'lg',
                  loading: knowledge.sources.loading,
                },
              ]}
            />
          </CardBody>
        </Card>

        {/* See what it has read, then add to it. Both live in the primary
            column because both are the page's job; the rail holds what you
            only read (the gaps) and what you configure once (the schedule).

            Adding used to be the rail. Measured at 1440 on a chatbot with no
            sources, the rail carried 1,032px against the main column's 455 —
            69% of the page in a 384px gutter, leaving ~590px of dead space
            beside it, and widening the window only grew that gap because the
            rail is a fixed 24rem. The page's own empty state says "Train it on
            your website, or upload a document" while the control that does
            exactly that sat in the narrow column and an empty table took the
            wide one. */}
        <Columns
          asideWidth="md"
          asideLabel="Knowledge management"
          main={
            <Stack>
              <Card>
                <CardHeader size="sm" title={t('agents.sources') || 'Sources'} titleAs="h2" />
                <CardBody flush>
                  <SourcesTable
                    sources={sources}
                    loading={knowledge.sources.loading}
                    error={knowledge.sources.error}
                    onRetry={knowledge.sources.retry}
                    canUseDelta={canUseDeltaRecrawl(planSlug)}
                    busySource={recrawl?.loading ? recrawl.sourceName : null}
                    crawlRunning={crawlRunning}
                    crawlingDomain={crawlingDomain}
                    query={sourceQuery}
                    onQueryChange={(next) => setParam('q', next)}
                    kind={sourceKind}
                    onKindChange={(next) => setParam('kind', next === 'all' ? null : next)}
                    onViewPages={(source) => setDrawerSource(source.name)}
                    onRecrawl={(source, mode) => void requestRecrawl(source, mode)}
                    onDelete={removeSource}
                  />
                </CardBody>
              </Card>

              <AddKnowledgePanel
                agentId={agent.id}
                agentName={agent.name ?? 'this chatbot'}
                agentWebsite={agent.website ?? null}
                sources={sources}
                documentAllowance={documentAllowance}
                pagesTrainedHere={summary.websitePages}
                pageLimit={pageLimit}
                characterAllowance={characterAllowance}
                planName={planName}
                planLoading={planLoading}
                empty={summary.total === 0}
                onChanged={refreshEverything}
              />
            </Stack>
          }
          aside={
            <Stack>
              <AutoRetrainCard agentId={agent.id} section={knowledge.autoRetrain} planName={planName} />

              {/* The gaps list itself lives on Experience ▸ UAQ now; this points
                  there from where the customer is deciding what to add next. */}
              <Card>
                <CardHeader
                  size="sm"
                  title={t('agents.questionsItCouldNotAnswer') || 'Questions it could not answer'}
                />
                <CardBody>
                  <Link
                    to={`${agentPath(agent.id, 'experience')}?tab=uaq`}
                    className={buttonClass('secondary', 'sm')}
                  >
                    {t('agents.viewUnansweredQuestions') || 'View unanswered questions'}
                  </Link>
                </CardBody>
              </Card>
            </Stack>
          }
        />
      </Stack>

      <PagesDrawer
        sourceName={drawerSource}
        agentId={agent.id}
        onClose={() => setDrawerSource(null)}
      />

      {recrawl ? (
        <RecrawlDialog
          open
          onOpenChange={(open) => {
            if (!open) setRecrawl(null);
          }}
          sourceName={recrawl.sourceName}
          mode={recrawl.mode}
          diff={recrawl.diff}
          loading={recrawl.loading}
          previewError={recrawl.previewError}
          planLocked={recrawl.planLocked}
          starting={recrawl.starting}
          startError={recrawl.startError}
          onConfirm={() => void confirmRecrawl()}
        />
      ) : null}
    </Page>
  );
}
