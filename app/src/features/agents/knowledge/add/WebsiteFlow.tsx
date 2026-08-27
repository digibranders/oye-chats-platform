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
import type { Allowance } from '../knowledge-model';
import { useCrawlDiscovery } from './useCrawlDiscovery';

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
              See plans
            </Link>
          }
        />
      </CardBody>
    );
  }

  /**
   * The four terminal outcomes are mutually exclusive, so they are one `Alert`
   * rather than four stacked conditionals. Up to six alerts in four tones could
   * previously render in one 500px column with nothing to say which was the
   * result of what the reader had just done.
   */
  const outcome = !crawlIsOurs
    ? null
    : crawl.status === 'done'
      ? {
          tone: 'success' as const,
          title: undefined,
          body: `Finished — this chatbot read ${formatNumber(crawl.pagesCrawled)} page${crawl.pagesCrawled === 1 ? '' : 's'}.`,
        }
      : crawl.status === 'no_content'
        ? {
            tone: 'danger' as const,
            title: 'That website could not be read',
            body: 'We reached the site but found no readable text. If it is built with React or Next.js, turn on the JavaScript option above and try again — or upload a document instead.',
          }
        : crawl.status === 'failed'
          ? {
              tone: 'danger' as const,
              title: 'That website could not be read',
              body:
                crawl.error ??
                'We could not finish reading that site. Try again, or upload a document instead.',
            }
          : crawl.status === 'cancelled'
            ? {
                tone: 'neutral' as const,
                title: undefined,
                body: 'Training stopped. Pages already read are kept, and you were not charged for the rest.',
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
            label="Website pages"
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
                See plans
              </Link>
            }
          >
            <span className="figure">{formatNumber(pageAllowance.remaining)}</span> pages left on{' '}
            {planName}.
          </Alert>
        ) : null}

        <Field label="Website address" hint="A public page is enough — no login.">
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
            page — use <strong className="font-medium">Re-train</strong> on the source below to see
            what actually changed first.
          </Alert>
        ) : null}

        <Switch
          checked={useJs}
          disabled={crawlRunning}
          onCheckedChange={flow.setJavaScript}
          label="This site needs JavaScript to show its text"
          // The troubleshooting advice lives on the `no_content` outcome below,
          // at the moment it is actually needed.
          description="Slower, fewer pages per run."
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
                label="Pages found"
                value={`${formatNumber(budget.found)}${budget.capped ? '+' : ''}`}
                hint={budget.capped ? 'There may be more than we could list' : undefined}
              />
              <FigureRow
                label="Your plan allows per crawl"
                value={budget.perCrawlLimit === null ? 'No limit' : formatNumber(budget.perCrawlLimit)}
              />
              <FigureRow
                label="Your credits cover"
                value={`${formatNumber(budget.affordablePages)} pages`}
                hint={`${formatNumber(budget.costPerPage)} credits a page · balance ${formatNumber(budget.balance)}`}
              />
              <FigureRow
                label="Selected"
                value={`${formatNumber(pageCount)} pages · ${formatNumber(cost)} credits`}
                hint={
                  budget.found === 0
                    ? 'We could not list this site’s pages; training will follow links from the homepage'
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
            title={crawl.status === 'cancelling' ? 'Stopping' : 'Reading your website'}
            detail={crawl.currentUrl ?? 'Finding pages'}
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
                {crawl.status === 'cancelling' || crawl.cancelInFlight ? 'Stopping…' : 'Stop'}
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
                Check again
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
              {discovering ? 'Checking pages…' : 'Check pages'}
            </Button>
          )}
        </CardSection>
      )}

      <ConfirmDialog
        open={confirmingStart}
        onOpenChange={setConfirmingStart}
        title="Start training?"
        // The budget well above already lists pages, allowance, credit cover and
        // the selection. This states the consequence and nothing else.
        description={
          budget
            ? `${formatNumber(pageCount)} page${pageCount === 1 ? '' : 's'} × ${formatNumber(budget.costPerPage)} credits = ${formatNumber(cost)} credits, from a balance of ${formatNumber(budget.balance)}. Charged as they are read, so stopping early only pays for what was read.`
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
        title="Stop training?"
        description="Pages already read are kept and charged. The rest are dropped, free."
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
