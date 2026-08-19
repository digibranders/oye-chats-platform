import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  LockedState,
  Meter,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
  StatTile,
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
import { AddKnowledgePanel } from './AddKnowledgePanel';
import { AutoRetrainCard } from './AutoRetrainCard';
import { KnowledgeGapsCard } from './KnowledgeGapsCard';
import { PagesDrawer } from './PagesDrawer';
import { RecrawlDialog } from './RecrawlDialog';
import { SourcesTable } from './SourcesTable';
import { errorMessage, fetchRecrawlDiff, isPlanLocked } from './knowledge-api';
import {
  allowanceOf,
  canUseDeltaRecrawl,
  charactersAsWords,
  crawlUrlFor,
  orderedUrlsForRecrawl,
  parseGapWindow,
  gapWindowParam,
  rootDomainOf,
  summarise,
  type GapWindow,
  type RecrawlDiff,
  type RecrawlMode,
} from './knowledge-model';
import { useKnowledgeData } from './useKnowledgeData';

/**
 * A chatbot's knowledge.
 *
 * It answers one question first — **what can this chatbot actually answer?** —
 * and only then what was last done to it. That order is the correction the page
 * it replaces needed most: it led with a plan-limits panel, and it rendered a
 * source's state as a hardcoded green "Ready" badge on every row regardless of
 * anything the server said.
 *
 * Four things this closes that the backend has always supported and no screen
 * ever showed: the ingestion job behind an upload (`GET /ingest/status/{id}`,
 * which had no client function at all), the window on the knowledge-gap list,
 * the knowledge-base character quota, and the crawl allowance — stated before a
 * crawl is started rather than as a 403 after one fails.
 */
export function KnowledgePage() {
  const { agent, loading, error, refresh } = useAgent();

  if (agent) {
    // Keyed on the chatbot, so switching remounts rather than rendering one
    // chatbot's sources under another's name for a frame.
    return <KnowledgeContent key={agent.id} agent={agent} />;
  }

  if (loading) {
    return (
      <Page width="wide">
        <PageHeader title="Knowledge" description="What this chatbot can answer from." />
        <Stack>
          <Card>
            <CardBody className="space-y-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-full max-w-md" />
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

  return (
    <Page width="wide">
      <PageHeader title="Knowledge" />
      <Card>
        <ErrorState
          title={error ? 'We could not load this chatbot' : 'Chatbot not found'}
          description={
            error
              ? error.message || 'Something went wrong while loading this workspace.'
              : 'This chatbot does not exist, or it belongs to a workspace you cannot see.'
          }
          onRetry={() => void refresh()}
        />
      </Card>
    </Page>
  );
}

function KnowledgeContent({ agent }: { agent: Bot }) {
  const [params, setParams] = useSearchParams();
  const gapWindow = parseGapWindow(params.get('gaps'));
  const {
    entitlements,
    limitFor,
    planSlug,
    planName,
    loading: planLoading,
  } = useEntitlements();
  const { crawl, startCrawl } = useCrawl();
  const knowledge = useKnowledgeData(agent.id, gapWindow);
  const { refresh: refreshAgent } = useAgent();

  const [drawerSource, setDrawerSource] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── Re-crawl ─────────────────────────────────────────────────────────────
  const [recrawl, setRecrawl] = useState<{
    sourceName: string;
    mode: RecrawlMode;
    diff: RecrawlDiff | null;
    loading: boolean;
    previewError: string | null;
    planLocked: boolean;
    starting: boolean;
    startError: string | null;
  } | null>(null);

  const sources = knowledge.sources.data;
  const summary = useMemo(() => summarise(sources), [sources]);
  const health = agentHealth(agent);
  const indexed = Number(agent.indexed_chunk_count ?? 0);

  const crawlOwned = crawl.botId === null || crawl.botId === agent.id;
  const crawlRunning = crawlOwned && (crawl.status === 'running' || crawl.status === 'cancelling');

  const setGapWindow = useCallback(
    (next: GapWindow) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          updated.set('gaps', gapWindowParam(next));
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

  const documentAllowance = allowanceOf(usage.documents ?? summary.documents, limitFor('documents'));
  // `page_scraping` usage is never populated server-side (see `_build_usage`),
  // so it is derived from this chatbot's own crawled pages and labelled as such
  // rather than invented as a workspace figure.
  const pageAllowance = allowanceOf(summary.websitePages, limitFor('page_scraping'));
  // `knowledge_characters` is in the entitlements payload — both the plan limit
  // and a real usage counter — but not in the `LimitKey` union, which lives
  // outside this surface. Read through a widened view rather than pretending
  // the key does not exist.
  //
  // An ABSENT limit is `null`, never zero. The server treats a missing plan
  // limit as deny-by-default, but "we do not know your allowance" and "your
  // allowance is spent" are different sentences, and only one of them is true
  // here — telling a customer their knowledge base is full because a plan row
  // is missing a key is the kind of lie that gets a support ticket.
  const characterLimit = limits.knowledge_characters;
  const characterAllowance =
    typeof characterLimit === 'number'
      ? allowanceOf(usage.knowledge_characters ?? 0, characterLimit)
      : null;

  const requestRecrawl = useCallback(
    async (source: KnowledgeSource, mode: RecrawlMode) => {
      setActionError(null);
      if (mode === 'delta' && !canUseDeltaRecrawl(planSlug)) {
        setRecrawl({
          sourceName: source.name,
          mode,
          diff: null,
          loading: false,
          previewError: null,
          planLocked: true,
          starting: false,
          startError: null,
        });
        return;
      }

      const crawlUrl = crawlUrlFor(source.name);
      const replaceSource = rootDomainOf(source.name);
      setRecrawl({
        sourceName: source.name,
        mode,
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
        // the reason a customer cannot refresh their own website. We proceed
        // with an empty, explicitly-capped diff so the backend rediscovers the
        // site itself, and we say plainly that the counts are unknown.
        setRecrawl((current) =>
          current === null
            ? current
            : {
                ...current,
                loading: false,
                previewError: errorMessage(cause, 'We could not compare the pages.'),
                diff: {
                  mode,
                  sourceName: source.name,
                  crawlUrl,
                  replaceSource,
                  sitemapTotal: 0,
                  existingTotal: 0,
                  unchanged: 0,
                  newPages: 0,
                  removedPages: 0,
                  unchangedUrls: [],
                  newUrls: [],
                  removedUrls: [],
                  costPerPage: 1,
                  balance: 0,
                  capped: true,
                  headPartial: false,
                  planMax: -1,
                },
              },
        );
      }
    },
    [agent.id, planSlug],
  );

  const confirmRecrawl = useCallback(async () => {
    const current = recrawl;
    if (current?.diff == null) return;
    const { diff } = current;
    setRecrawl({ ...current, starting: true, startError: null });
    try {
      const orderedUrls = orderedUrlsForRecrawl(diff);
      const options: StartCrawlOptions = {
        url: diff.crawlUrl,
        botId: agent.id,
        botName: agent.name ?? null,
        // A source record carries no per-source JavaScript flag, so a site
        // originally trained with JS rendering re-trains HTTP-only here. Named
        // rather than hidden: it is the difference between a full refresh and
        // an empty one on a single-page site.
        useJs: false,
        replaceSource: diff.replaceSource,
        mode: diff.mode,
        orderedUrls,
        expectedNewPages: diff.mode === 'delta' ? diff.newPages : null,
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
              startError: errorMessage(cause, 'We could not start the re-train. Please try again.'),
            },
      );
    }
  }, [recrawl, agent.id, agent.name, startCrawl]);

  const removeSource = useCallback(
    async (source: KnowledgeSource) => {
      setActionError(null);
      try {
        await deleteDocument(source.name, agent.id);
        refreshEverything();
      } catch (cause) {
        setActionError(
          errorMessage(cause, 'We could not remove that source. Nothing has been deleted.'),
        );
      }
    },
    [agent.id, refreshEverything],
  );

  if (knowledge.sources.forbidden) {
    return (
      <Page width="wide">
        <PageHeader title="Knowledge" description="What this chatbot can answer from." />
        <LockedState
          title="This chatbot's knowledge is not yours to see"
          description="Your seat does not have access to this chatbot. An owner or an admin of this workspace can open it for you, or change your seat."
          action={
            <Link to="/chatbots" className={buttonClass('secondary', 'md')}>
              Back to your chatbots
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Knowledge"
        description="What this chatbot can answer from, and what it is still missing."
        actions={
          <Button
            disabled={knowledge.refreshing}
            onClick={refreshEverything}
            iconLeft={
              <RefreshCw
                aria-hidden
                className={knowledge.refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              />
            }
          >
            Refresh
          </Button>
        }
      />

      <Stack>
        {/* What it knows, before what was last done to it. */}
        <Card>
          <CardBody className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-text-primary">
                {health.label}
                <Badge tone={health.tone} dot>
                  {health.tone === 'success'
                    ? 'Healthy'
                    : health.tone === 'danger'
                      ? 'Not working'
                      : health.tone === 'warning'
                        ? 'Needs you'
                        : 'In progress'}
                </Badge>
              </h2>
              <p className="mt-1.5 max-w-prose text-prose text-text-secondary">{health.detail}</p>
            </div>
          </CardBody>
          <CardBody className="grid grid-cols-2 gap-6 border-t border-border lg:grid-cols-4">
            <StatTile
              label="Passages"
              value={indexed > 0 ? formatNumber(indexed) : undefined}
              period="Searchable right now"
              hint={indexed > 0 ? undefined : 'Nothing indexed yet'}
            />
            <StatTile
              label="Sources"
              value={summary.total > 0 ? formatNumber(summary.total) : undefined}
              period={`${formatNumber(summary.websites)} websites · ${formatNumber(summary.documents)} documents`}
              loading={knowledge.sources.loading}
            />
            <StatTile
              label="Website pages"
              value={summary.websitePages > 0 ? formatNumber(summary.websitePages) : undefined}
              period="Read from your sites"
              loading={knowledge.sources.loading}
            />
            <StatTile
              label="Last trained"
              value={summary.lastIngestedAt ? formatDate(summary.lastIngestedAt) : undefined}
              period="Most recent source added"
              loading={knowledge.sources.loading}
            />
          </CardBody>
          {knowledge.state.data.deactivated ? (
            <CardBody className="border-t border-border">
              <Alert
                tone="plan"
                title="This knowledge is paused"
                action={
                  <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                    See plans
                  </Link>
                }
              >
                This chatbot still holds{' '}
                <span className="figure">{formatNumber(knowledge.state.data.inactive_count)}</span>{' '}
                passages, but they stopped being used for answers when the plan moved to Free. Train
                it on a website or upload a document to bring it back on Free, or move to a paid plan
                to restore everything at once.
              </Alert>
            </CardBody>
          ) : null}
          {actionError ? (
            <CardBody className="border-t border-border">
              <Alert tone="danger" live>
                {actionError}
              </Alert>
            </CardBody>
          ) : null}
        </Card>

        <AddKnowledgePanel
          agentId={agent.id}
          agentName={agent.name ?? 'this chatbot'}
          agentWebsite={agent.website ?? null}
          sources={sources}
          documentAllowance={documentAllowance}
          pageAllowance={pageAllowance}
          characterAllowance={characterAllowance}
          planName={planName}
          planLoading={planLoading}
          empty={summary.total === 0}
          onChanged={refreshEverything}
        />

        <Section
          title="Sources"
          description="Everything this chatbot has read. Removing one takes its answers with it."
        >
          <SourcesTable
            sources={sources}
            loading={knowledge.sources.loading}
            error={knowledge.sources.error}
            onRetry={knowledge.sources.retry}
            canUseDelta={canUseDeltaRecrawl(planSlug)}
            busySource={recrawl?.loading ? recrawl.sourceName : null}
            crawlRunning={crawlRunning}
            onViewPages={(source) => setDrawerSource(source.name)}
            onRecrawl={(source, mode) => void requestRecrawl(source, mode)}
            onDelete={removeSource}
          />
        </Section>

        <KnowledgeGapsCard
          section={knowledge.gaps}
          window={gapWindow}
          onWindowChange={setGapWindow}
        />

        <Card>
          <CardHeader
            eyebrow={planName}
            title="What your plan includes"
            titleAs="h2"
            description="Knowledge is capped by plan, not by fault — being full here means you are using what you pay for."
            actions={
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                See plans
              </Link>
            }
          />
          <CardBody className="grid gap-6 sm:grid-cols-3">
            <div>
              <Meter
                label="Documents"
                used={documentAllowance.used}
                limit={documentAllowance.limit}
              />
              <p className="mt-1.5 text-2xs text-text-tertiary">
                Uploaded files, across every chatbot in this workspace.
              </p>
            </div>
            <div>
              <Meter
                label="Website pages"
                used={pageAllowance.used}
                limit={pageAllowance.limit}
              />
              <p className="mt-1.5 text-2xs text-text-tertiary">
                Counted from this chatbot&apos;s own crawled pages — the server reports no
                workspace-wide figure.
              </p>
            </div>
            {characterAllowance ? (
              <div>
                <Meter
                  label="Knowledge base size"
                  used={characterAllowance.used}
                  limit={characterAllowance.limit}
                  unit="chars"
                />
                <p className="mt-1.5 text-2xs text-text-tertiary">
                  About{' '}
                  <span className="figure">
                    {formatNumber(charactersAsWords(characterAllowance.used))}
                  </span>{' '}
                  words of text, across every chatbot in this workspace.
                </p>
              </div>
            ) : null}
          </CardBody>
          {!planLoading &&
          ((characterAllowance?.nearLimit ?? false) ||
            documentAllowance.nearLimit ||
            pageAllowance.nearLimit) ? (
            <CardBody className="border-t border-border">
              <Alert
                tone="plan"
                action={
                  <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                    See plans
                  </Link>
                }
              >
                You are close to what this plan holds. Nothing stops working — you simply cannot add
                more until you remove something or move up.
              </Alert>
            </CardBody>
          ) : null}
        </Card>

        <AutoRetrainCard agentId={agent.id} section={knowledge.autoRetrain} planName={planName} />
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
