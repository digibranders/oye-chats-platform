import { useState } from 'react';
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
  Switch,
  Well,
  formatNumber,
} from '../../../../ui';
import type { KnowledgeSource } from '../../../../types/domain';
import { useEntitlements } from '../../../../hooks/useEntitlements';
import { CrawlPageTree } from '../CrawlPageTree';
import { IngestionProgress } from '../IngestionProgress';
import { crawlCoverageOf, crawlDoneMessage } from '../knowledge-model';
import { useCrawlDiscovery } from './useCrawlDiscovery';
import { useTranslation } from '../../../../i18n/useTranslation';

export interface WebsiteFlowProps {
  agentId: number;
  agentName: string;
  /** The chatbot's own stored website, captured when it was created. */
  agentWebsite: string | null;
  sources: readonly KnowledgeSource[];
  /** Website pages THIS chatbot has stored, all time. Never the workspace's. */
  pagesTrainedHere: number;
  /**
   * The plan's website-page ceiling: `-1` unlimited, `null` when the plan
   * payload states none.
   *
   * Not paired with `pagesTrainedHere` in a meter, and not a gate. The server
   * populates no `page_scraping` usage counter, so the only numerator that
   * exists is this chatbot's own stored pages while the ceiling is the
   * account's, over a billing period. A bar built from the two read "500 of
   * 500" on a workspace that had spent nothing, and the lock beneath it left
   * that customer unable to train their chatbot at all. The real ceiling is
   * enforced server-side and reported by the `limit` crawl outcome below, in
   * the server's own words, because only it knows which limit was reached.
   */
  pageLimit: number | null;
  planName: string;
  /**
   * True while entitlements are still resolving. The provider's placeholder is
   * a Free plan, so a Standard workspace would be quoted a Free plan's ceiling
   * for the first frames. Nothing about the plan is stated until it arrives.
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
 * **The plan's page ceiling is stated, not metered.** It was a `Meter` over a
 * quota this surface cannot compute, and before that a permanent brass `Alert`
 * carrying three interpolated figures in prose on every render. The two figures
 * a customer needs here are what this chatbot has already read and what the
 * plan allows; they belong to different scopes, so they are two sentences and
 * not one bar. What is actually spent per run is in the budget well below,
 * where the selection changes it.
 */
export function WebsiteFlow({
  agentId,
  agentName,
  agentWebsite,
  sources,
  pagesTrainedHere,
  pageLimit,
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
    discoveryFailed,
    hasPageList,
    pageCount,
    preflight,
    cost,
    alreadyTrained,
  } = flow;

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
            body: t('agents.weReachedTheSiteBut') || 'We reached the site but found no readable text. If it is built with React or Next.js, turn on the JavaScript option above and try again, or upload a document instead.',
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
        {/* Two facts, each labelled with the thing it is about. This chatbot's
            own page count is the one figure this surface can state exactly; the
            plan's ceiling covers the whole workspace, and saying so is the
            difference between a fact and a bar that quietly compares one
            chatbot against an account. */}
        {planLoading ? null : (
          <p className="text-xs text-text-secondary">
            <span className="figure">{formatNumber(pagesTrainedHere)}</span> website page
            {pagesTrainedHere === 1 ? '' : 's'} trained on this chatbot so far.{' '}
            {pageLimit === null || pageLimit < 0
              ? `Website training is charged in credits on ${planName}.`
              : `${planName} allows ${formatNumber(pageLimit)} website pages across this workspace.`}
          </p>
        )}

        <Field label={t('agents.websiteAddress') || 'Website address'} hint={t('agents.aPublicPageIsEnough') || 'A public page is enough, with no login.'}>
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
                // Three different truths, and quoting the wrong one is how a
                // customer decides against a crawl that would not have cost
                // them anything. With an allowance the price is a SPLIT, so
                // naming only the per-page rate overstates it — 81 pages on 25
                // free reads as 405 credits when the charge is 280.
                hint={
                  budget.costPerPage === 0
                    ? t('agents.thisTrainingIsFree') || 'This training is free · balance unchanged'
                    : budget.freePages > 0
                      ? `First ${formatNumber(budget.freePages)} free · then ${formatNumber(budget.costPerPage)} credits a page · balance ${formatNumber(budget.balance)}`
                      : `${formatNumber(budget.costPerPage)} credits a page · balance ${formatNumber(budget.balance)}`
                }
              />
              <FigureRow
                label={t('agents.selected') || 'Selected'}
                value={
                  // `cost` already has the allowance taken off the top, so a
                  // selection inside it reads as free without a special case.
                  budget.costPerPage === 0 || cost === 0
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
          ) : discoveryFailed ? (
            <>
              {/* The count failed, not the site. The crawl follows links from
                  the homepage on its own, so the honest offer is to go ahead
                  without a number: no page count, no invented cost. The confirm
                  dialog's no-budget copy states the consequence. */}
              <Button
                variant="accent"
                disabled={!url.trim() || discovering}
                onClick={() => setConfirmingStart(true)}
              >
                {t('agents.trainAnyway') || 'Train anyway'}
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
