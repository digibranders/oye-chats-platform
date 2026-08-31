import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Search, Square } from 'lucide-react';
import {
  Alert,
  Button,
  CardBody,
  CardSection,
  ConfirmDialog,
  Field,
  FigureList,
  FigureRow,
  Input,
  LockedState,
  Meter,
  Switch,
  Well,
  buttonClass,
  formatNumber,
} from '../../../../ui';
import type { KnowledgeSource } from '../../../../types/domain';
import { useEntitlements } from '../../../../hooks/useEntitlements';
import { CrawlPageTree } from '../CrawlPageTree';
import { IngestionProgress } from '../IngestionProgress';
import { crawlCoverageOf, crawlDoneMessage, type Allowance } from '../knowledge-model';
import { useCrawlDiscovery } from './useCrawlDiscovery';
import { useTranslation } from '../../../../i18n/useTranslation';

export interface WebsiteFlowProps {
  agentId: number;
  agentName: string;
  /** The chatbot's own stored website, captured when it was created. */
  agentWebsite: string | null;
  sources: readonly KnowledgeSource[];
  /** Plan allowance for crawled pages. */
  pageAllowance: Allowance;
  planName: string;
  /**
   * True while entitlements are still resolving. The provider's placeholder is
   * a Free plan, so a Standard workspace with five hundred trained pages reads
   * as over its limit for the first frames. Nothing locks until the real plan
   * has arrived.
   */
  planLoading: boolean;
  /** Called after anything lands, so the page can refetch its sources. */
  onChanged: () => void;
}

/**
 * Train a chatbot on a website.
 *
 * Eight props, down from seventeen: the whole crawl state machine lives in
 * `useCrawlDiscovery`, which this calls itself rather than having fourteen
 * fields of `useCrawl()` handed down one at a time by a parent that had already
 * imported the same context.
 *
 * **The allowance is a `Meter`, not an `Alert`.** It used to be a permanent
 * brass `Alert` — the tone the system reserves for "this is a paid thing" —
 * carrying three interpolated figures in prose on every render. A quota that is
 * 60% spent is ambient state, not something the reader must act on, and painting
 * it in the reserved colour every time is how a customer learns to ignore that
 * colour. It escalates to an `Alert` only once it is nearly gone.
 */
export function WebsiteFlow({
  agentId,
  agentName,
  agentWebsite,
  sources,
  pageAllowance,
  planName,
  planLoading,
  onChanged,
}: WebsiteFlowProps) {
  const { t } = useTranslation();
  const flow = useCrawlDiscovery({ agentId, agentName, agentWebsite, sources, onChanged });
  const { limitFor } = useEntitlements();
  const maxPages = limitFor('max_crawl_pages');
  const maxDepth = limitFor('max_crawl_depth');
  const [confirmingStart, setConfirmingStart] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const {
    crawl,
    crawlRunning,
    crawlIsOurs,
    url,
    useJs,
    discovery,
    discovering,
    selected,
    error,
    budget,
    hasPageList,
    pageCount,
    preflight,
    cost,
    alreadyTrained,
  } = flow;

  if (pageAllowance.atLimit && !planLoading && !crawlRunning) {
    return (
      <CardBody>
        {/* `size="panel"`: this already sits inside a card, and `LockedState`'s
            own frame put a second hairline 20px inside the first. */}
        <LockedState
          size="panel"
          title={`${planName}: no website pages left`}
          description={`This plan covers ${formatNumber(pageAllowance.limit)} pages. Remove a website below, or move up.`}
          action={
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              {t('agents.seePlans') || 'See plans'}
            </Link>
          }
        />
      </CardBody>
    );
  }

  // What the chatbot can actually answer from, not what the crawler fetched.
  // `crawl.pagesCrawled` is the fetched count, and a crawl stopped by a plan
  // cap at page 25 of 400 still carries 400 — which is how a Starter customer
  // came to be told their chatbot had read all 400. `null` while the result
  // payload is still in flight, or from a worker predating those keys, and the
  // fetched count is then the best figure available.
  const coverage = crawl.status === 'done' ? crawlCoverageOf(crawl.result) : null;

  /**
   * The four terminal outcomes are mutually exclusive, so they are one `Alert`
   * rather than four stacked conditionals. Up to six alerts in four tones could
   * previously render in one 500px column with nothing to say which was the
   * result of what the reader had just done.
   */
  const outcome = !crawlIsOurs
    ? null
    : crawl.status === 'done'
      ? coverage
        ? crawlDoneMessage(coverage)
        : {
            tone: 'success' as const,
            title: undefined,
            body: `Finished — this chatbot read ${formatNumber(crawl.pagesCrawled)} page${crawl.pagesCrawled === 1 ? '' : 's'}.`,
          }
      : crawl.status === 'limit'
        ? {
            // Not a reading problem. The site was fine and this workspace ran
            // out of credits or knowledge-base room, so the advice is to add
            // capacity rather than to debug JavaScript. The server sends the
            // sentence, because only it knows which limit was reached.
            tone: 'warning' as const,
            title: t('agents.thisCrawlHitALimit') || 'This crawl stopped at a limit',
            body:
              crawl.error ??
              (t('agents.weStoppedBeforeTraining') ||
                'We stopped before training on your pages because this workspace reached a limit. Upgrade or add credits, then run the crawl again.'),
          }
        : crawl.status === 'no_content'
        ? {
            tone: 'danger' as const,
            title: t('agents.thatWebsiteCouldNotBe') || 'That website could not be read',
            body: t('agents.weReachedTheSiteBut') || 'We reached the site but found no readable text. If it is built with React or Next.js, turn on the JavaScript option above and try again — or upload a document instead.',
          }
        : crawl.status === 'failed'
          ? {
              tone: 'danger' as const,
              title: t('agents.thatWebsiteCouldNotBe') || 'That website could not be read',
              body:
                crawl.error ??
                (t('agents.weCouldNotFinishReading') || 'We could not finish reading that site. Try again, or upload a document instead.')
            }
          : crawl.status === 'cancelled'
            ? {
                tone: 'neutral' as const,
                title: undefined,
                body: t('agents.trainingStoppedPagesAlreadyRead') || 'Training stopped. Pages already read are kept, and you were not charged for the rest.',
              }
            : null;

  return (
    <>
      <CardBody className="space-y-4">
        {/* The allowance, stated before anything is spent — as one bar and one
            figure pair rather than a sentence with three numbers in it. */}
        {planLoading ? null : pageAllowance.unlimited ? (
          <p className="text-xs text-text-secondary">
            No page limit on {planName} — website training is charged in credits.{' '}
            <span className="figure">{formatNumber(pageAllowance.used)}</span> pages trained here so
            far.
          </p>
        ) : (
          <Meter
            label={t('agents.websitePages') || 'Website pages'}
            used={pageAllowance.used}
            limit={pageAllowance.limit}
            tone="plan"
          />
        )}

        {pageAllowance.nearLimit && !pageAllowance.atLimit && !planLoading ? (
          <Alert
            tone="plan"
            action={
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                {t('agents.seePlans') || 'See plans'}
              </Link>
            }
          >
            <span className="figure">{formatNumber(pageAllowance.remaining)}</span> pages left on{' '}
            {planName}.
          </Alert>
        ) : null}

        <Field label={t('agents.websiteAddress') || 'Website address'} hint={t('agents.aPublicPageIsEnough') || 'A public page is enough — no login.'}>
          <Input
            value={url}
            inputMode="url"
            placeholder="example.com"
            disabled={crawlRunning}
            leading={<Globe aria-hidden />}
            onChange={(event) => flow.editUrl(event.target.value)}
          />
        </Field>

        {maxPages > 0 ? (
          <p className="text-xs text-text-tertiary">
            Your plan crawls up to {maxPages} pages, {maxDepth} levels deep.
          </p>
        ) : null}

        {/* A price and a redirect are not hint text. Hints are read as optional;
            this one says the next press re-reads and re-charges every page. */}
        {alreadyTrained ? (
          <Alert tone="warning">
            {alreadyTrained} is already trained. Training it again re-reads and re-charges every
            page — use <strong className="font-medium">{t('agents.reTrain') || 'Re-train'}</strong> on the source below to see
            what actually changed first.
          </Alert>
        ) : null}

        <Switch
          checked={useJs}
          disabled={crawlRunning}
          fullWidth
          onCheckedChange={flow.setJavaScript}
          label={t('agents.thisSiteNeedsJavascriptTo') || 'This site needs JavaScript to show its text'}
          // The troubleshooting advice lives on the `no_content` outcome below,
          // at the moment it is actually needed.
          description={t('agents.slowerFewerPagesPerRun') || 'Slower, fewer pages per run.'}
        />

        {/* Side by side once the column is wide enough for it. Stacked, the
            cost block and the page list are ~190px and ~340px of a panel that
            measured 999px in this state — and reading "20 pages · 100 credits"
            is what the checkboxes are FOR, so the two belong on one row where
            changing the selection visibly changes the number. Below `2xl` they
            stack in this order, cost first, because the price is the thing you
            check before you start ticking. */}
        <div className="grid gap-4 @2xl/page:grid-cols-[18rem_minmax(0,1fr)] @2xl/page:items-start">
        {budget ? (
          <Well>
            <FigureList>
              <FigureRow
                label={t('agents.pagesFound') || 'Pages found'}
                value={`${formatNumber(budget.found)}${budget.capped ? '+' : ''}`}
                hint={budget.capped ? t('agents.thereMayBeMoreThan') || 'There may be more than we could list' : undefined}
              />
              <FigureRow
                label={t('agents.yourPlanAllowsPerCrawl') || 'Your plan allows per crawl'}
                value={budget.perCrawlLimit === null ? t('agents.noLimit') || 'No limit' : formatNumber(budget.perCrawlLimit)}
              />
              <FigureRow
                label={t('agents.yourCreditsCover') || 'Your credits cover'}
                // A free crawl is stated as free. "0 credits a page" reads like
                // a bug or a rounding error, and the number people check before
                // they commit is exactly this one.
                value={budget.costPerPage === 0 ? t('agents.everyPageFound') || 'Every page found' : `${formatNumber(budget.affordablePages)} pages`}
                hint={
                  budget.costPerPage === 0
                    ? t('agents.thisTrainingIsFree') || 'This training is free · balance unchanged'
                    : `${formatNumber(budget.costPerPage)} credits a page · balance ${formatNumber(budget.balance)}`
                }
              />
              <FigureRow
                label={t('agents.selected') || 'Selected'}
                value={
                  budget.costPerPage === 0
                    ? `${formatNumber(pageCount)} pages · ${t('agents.thisIsFree') || 'free'}`
                    : `${formatNumber(pageCount)} pages · ${formatNumber(cost)} credits`
                }
                hint={
                  budget.found === 0
                    ? t('agents.weCouldNotListThis') || 'We could not list this site’s pages; training will follow links from the homepage'
                    : (preflight?.message ?? undefined)
                }
                emphasis
                tone={preflight?.blocked ? 'warning' : 'neutral'}
              />
            </FigureList>
          </Well>
        ) : null}

        {hasPageList && !crawlRunning ? (
          <CrawlPageTree
            urls={discovery?.urls ?? []}
            selected={selected}
            onSelectionChange={flow.setSelected}
            disabled={crawlRunning}
          />
        ) : null}
        </div>

        {crawlRunning ? (
          <IngestionProgress
            title={crawl.status === 'cancelling' ? t('agents.stopping2') || 'Stopping' : t('agents.readingYourWebsite') || 'Reading your website'}
            detail={crawl.currentUrl ?? (t('agents.findingPages') || 'Finding pages')}
            done={crawl.pagesCrawled}
            total={crawl.discoveredTotal ?? crawl.maxPages}
            unit="pages"
            // Inside the progress well, as its trailing control. It used to sit
            // loose beneath the well while a disabled "Train on N pages" stayed
            // in the footer — two action zones, one live and one dead.
            action={
              <Button
                variant="danger"
                size="sm"
                disabled={crawl.status === 'cancelling' || crawl.cancelInFlight}
                onClick={() => setConfirmingCancel(true)}
                iconLeft={<Square aria-hidden />}
              >
                {crawl.status === 'cancelling' || crawl.cancelInFlight ? t('agents.stopping') || 'Stopping…' : t('agents.stop') || 'Stop'}
              </Button>
            }
          />
        ) : null}

        {outcome ? (
          <Alert tone={outcome.tone} title={outcome.title} live>
            {outcome.body}
          </Alert>
        ) : null}

        {error ? (
          <Alert tone="danger" live>
            {error}
          </Alert>
        ) : null}
      </CardBody>

      {/* The footer's job is finished once the crawl starts. */}
      {crawlRunning ? null : (
        <CardSection className="flex flex-wrap items-center gap-2">
          {discovery ? (
            <>
              <Button
                variant="accent"
                disabled={!url.trim() || (preflight?.blocked ?? false)}
                onClick={() => setConfirmingStart(true)}
              >
                Train on {formatNumber(pageCount)} page{pageCount === 1 ? '' : 's'}
              </Button>
              <Button variant="ghost" disabled={discovering} onClick={() => void flow.discover()}>
                {t('agents.checkAgain') || 'Check again'}
              </Button>
            </>
          ) : (
            <Button
              variant="accent"
              loading={discovering}
              disabled={discovering || !url.trim()}
              onClick={() => void flow.discover()}
              iconLeft={<Search aria-hidden />}
            >
              {discovering ? t('agents.checkingPages') || 'Checking pages…' : t('agents.checkPages') || 'Check pages'}
            </Button>
          )}
        </CardSection>
      )}

      <ConfirmDialog
        open={confirmingStart}
        onOpenChange={setConfirmingStart}
        title={t('agents.startTraining') || 'Start training?'}
        // The budget well above already lists pages, allowance, credit cover and
        // the selection. This states the consequence and nothing else.
        description={
          budget
            ? budget.costPerPage === 0
              ? `${formatNumber(pageCount)} page${pageCount === 1 ? '' : 's'}, free. Your balance of ${formatNumber(budget.balance)} credits is not touched.`
              : `${formatNumber(pageCount)} page${pageCount === 1 ? '' : 's'} × ${formatNumber(budget.costPerPage)} credits = ${formatNumber(cost)} credits, from a balance of ${formatNumber(budget.balance)}. Charged as they are read, so stopping early only pays for what was read.`
            : `This reads ${url.trim() || 'this website'} and charges credits for each page it reads.`
        }
        confirmLabel="Start training"
        onConfirm={async () => {
          await flow.beginCrawl();
          setConfirmingStart(false);
        }}
      />

      <ConfirmDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
        destructive
        title={t('agents.stopTraining') || 'Stop training?'}
        description={t('agents.pagesAlreadyReadAreKept') || 'Pages already read are kept and charged. The rest are dropped, free.'}
        confirmLabel="Stop training"
        cancelLabel="Keep training"
        onConfirm={async () => {
          await flow.stopCrawl();
          setConfirmingCancel(false);
        }}
      />
    </>
  );
}
