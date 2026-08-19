import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Globe, Search, Square } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  ConfirmDialog,
  Field,
  FigureRow,
  FileDrop,
  Input,
  LockedState,
  Progress,
  SegmentedControl,
  Switch,
  buttonClass,
  formatNumber,
} from '../../../ui';
import { getCurrentUser, discoverCrawlUrls, previewUploadCost, uploadDocuments } from '../../../services/api';
import type { UploadCostPreview } from '../../../services/api';
import { keys } from '../../../query/keys';
import { resolveWebsitePrefill } from '../../../lib/websitePrefill';
import { useCrawl, type StartCrawlOptions } from '../../../context/CrawlContext';
import type { CrawlDiscovery, KnowledgeSource } from '../../../types/domain';
import { CrawlPageTree, canonicalCrawlUrls } from './CrawlPageTree';
import { IngestionProgress } from './IngestionProgress';
import { errorMessage } from './knowledge-api';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  UPLOAD_EXTENSIONS,
  type Allowance,
  crawlBudgetOf,
  crawlPreflight,
  isWebsiteSource,
  normalizeSiteUrl,
  rootDomainOf,
  uploadSkipReason,
} from './knowledge-model';

type AddMode = 'website' | 'documents';

export interface AddKnowledgePanelProps {
  agentId: number;
  agentName: string;
  /** The chatbot's own stored website, captured when it was created. */
  agentWebsite: string | null;
  sources: readonly KnowledgeSource[];
  /** Plan allowance for uploaded documents — workspace-wide. */
  documentAllowance: Allowance;
  /** Plan allowance for crawled pages. */
  pageAllowance: Allowance;
  /**
   * Knowledge-base size allowance, in characters. `null` when the plan payload
   * does not report the limit at all — which is not the same as a full one.
   */
  characterAllowance: Allowance | null;
  planName: string;
  /**
   * True while entitlements are still resolving.
   *
   * The provider's placeholder is a Free plan, so a Standard workspace with
   * five hundred trained pages reads as over its limit for the first frames.
   * Nothing locks until the real plan has arrived.
   */
  planLoading: boolean;
  /** Called after anything lands, so the page can refetch its sources. */
  onChanged: () => void;
  /** Softer heading while the chatbot has nothing to answer from. */
  empty: boolean;
}

/**
 * The one place a chatbot learns something new.
 *
 * Two things it does that the panel it replaces did not.
 *
 * **It states the plan's allowance before the crawl, not after it fails.** The
 * old flow discovered pages, started the crawl, took the 403 or the 402, and
 * printed the server's sentence — after the customer had already chosen pages
 * and pressed a button that reads like a commitment. `plan_max`,
 * `max_affordable_pages` and `cost_per_page` all come back from
 * `/crawl/discover`, and every one of them was thrown away.
 *
 * **An upload reports honest progress.** `POST /ingest` returns 202 with a
 * `job_id` and the reading, chunking and embedding all happen afterwards, so
 * the old spinner stopped a long way before the document was answerable. The
 * job is polled now, and while it is moving the surface shows motion rather
 * than a coloured "processing" pill — this system has no hue for in-progress.
 */
export function AddKnowledgePanel({
  agentId,
  agentName,
  agentWebsite,
  sources,
  documentAllowance,
  pageAllowance,
  characterAllowance,
  planName,
  planLoading,
  onChanged,
  empty,
}: AddKnowledgePanelProps) {
  const [mode, setMode] = useState<AddMode>('website');
  const { crawl, startCrawl, cancelCrawl } = useCrawl();

  // A crawl with no bot scope is still ours until it says otherwise — an
  // unscoped in-flight crawl surfacing nowhere is worse than surfacing here.
  const crawlOwned = crawl.botId === null || crawl.botId === agentId;
  const crawlRunning = crawlOwned && (crawl.status === 'running' || crawl.status === 'cancelling');
  const crawlIsOurs = crawl.botId === agentId;

  return (
    <Card>
      <CardHeader
        eyebrow="Add knowledge"
        title={empty ? 'Teach this chatbot something' : 'Add more knowledge'}
        titleAs="h2"
        description="Train it on a website, or upload documents. Everything you add becomes something it can answer from."
        actions={
          <SegmentedControl<AddMode>
            label="What to add"
            value={mode}
            onChange={setMode}
            items={[
              { value: 'website', label: 'Website' },
              { value: 'documents', label: 'Documents' },
            ]}
          />
        }
      />

      {mode === 'website' ? (
        <WebsiteFlow
          agentId={agentId}
          agentName={agentName}
          agentWebsite={agentWebsite}
          sources={sources}
          pageAllowance={pageAllowance}
          planName={planName}
          planLoading={planLoading}
          crawlRunning={crawlRunning}
          crawlIsOurs={crawlIsOurs}
          onChanged={onChanged}
          startCrawl={startCrawl}
          cancelCrawl={cancelCrawl}
          crawlStatus={crawl.status}
          crawlPages={crawl.pagesCrawled}
          crawlTotal={crawl.discoveredTotal ?? crawl.maxPages}
          crawlCurrentUrl={crawl.currentUrl}
          crawlError={crawl.error}
          cancelInFlight={crawl.cancelInFlight}
        />
      ) : (
        <DocumentsFlow
          agentId={agentId}
          documentAllowance={documentAllowance}
          characterAllowance={characterAllowance}
          planName={planName}
          planLoading={planLoading}
          onChanged={onChanged}
        />
      )}
    </Card>
  );
}

// ── Website ────────────────────────────────────────────────────────────────

interface WebsiteFlowProps {
  agentId: number;
  agentName: string;
  agentWebsite: string | null;
  sources: readonly KnowledgeSource[];
  pageAllowance: Allowance;
  planName: string;
  planLoading: boolean;
  crawlRunning: boolean;
  crawlIsOurs: boolean;
  crawlStatus: string;
  crawlPages: number;
  crawlTotal: number | null;
  crawlCurrentUrl: string | null;
  crawlError: string | null;
  cancelInFlight: boolean;
  onChanged: () => void;
  startCrawl: (options: StartCrawlOptions) => Promise<unknown>;
  cancelCrawl: () => Promise<{ status: string; message: string }>;
}

function WebsiteFlow({
  agentId,
  agentName,
  agentWebsite,
  sources,
  pageAllowance,
  planName,
  planLoading,
  crawlRunning,
  crawlIsOurs,
  crawlStatus,
  crawlPages,
  crawlTotal,
  crawlCurrentUrl,
  crawlError,
  cancelInFlight,
  onChanged,
  startCrawl,
  cancelCrawl,
}: WebsiteFlowProps) {
  // The account's own website, read from the shared session cache rather than a
  // private fetch — `/auth/me` was being called from ten places with no cache
  // between them. A failure simply means no prefill, never a blocked field.
  const { data: account } = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    staleTime: 5 * 60_000,
  });

  const trainedHosts = useMemo(
    () => new Set(sources.filter((s) => isWebsiteSource(s.name)).map((s) => rootDomainOf(s.name))),
    [sources],
  );

  /**
   * What to offer in the URL field — unless that site is already trained.
   *
   * The suppression is the point. A chatbot with no sources is here to train
   * its own website, and asking for a URL the create-chatbot modal already
   * stored is the product forgetting. A chatbot that already learned that site
   * is here to add something *else*, and handing back its own trained URL
   * invites a second full crawl of pages it already knows — routing around the
   * previewed, diffed re-train that exists for exactly that job.
   */
  const prefill = useMemo(() => {
    const resolved = resolveWebsitePrefill(agentWebsite, account?.website ?? null);
    if (!resolved) return '';
    return trainedHosts.has(rootDomainOf(normalizeSiteUrl(resolved))) ? '' : resolved;
  }, [agentWebsite, account?.website, trainedHosts]);

  const [url, setUrl] = useState(prefill);
  // A ref, not state: it gates the sync effect below and must never re-run it.
  const edited = useRef(false);
  const [useJs, setUseJs] = useState(false);
  const [discovery, setDiscovery] = useState<CrawlDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmingStart, setConfirmingStart] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // `agentWebsite` and `/auth/me` resolve independently and asynchronously, so
  // the initialiser alone is computed from `undefined` on a cold load and never
  // corrects itself. Re-sync when the resolved value changes — but never over
  // what the customer typed, including a field they deliberately cleared.
  useEffect(() => {
    if (edited.current || !prefill) return;
    setUrl(prefill);
  }, [prefill]);

  // Clear the form once our crawl finishes cleanly, so it is ready for the next
  // site. Keyed on the status transition, not derived during render.
  useEffect(() => {
    if (!crawlIsOurs || crawlStatus !== 'done') return;
    setUrl('');
    setDiscovery(null);
    setSelected([]);
    setError(null);
    onChanged();
  }, [crawlIsOurs, crawlStatus, onChanged]);

  const budget = discovery ? crawlBudgetOf(discovery) : null;
  const hasPageList = (discovery?.urls?.length ?? 0) > 0;
  const pageCount = hasPageList ? selected.length : (discovery?.total_found ?? 0);
  const preflight = budget ? crawlPreflight(budget, Math.max(pageCount, 0)) : null;

  const alreadyTrained = useMemo(() => {
    const trimmed = url.trim();
    if (!trimmed) return null;
    const host = rootDomainOf(normalizeSiteUrl(trimmed));
    return trainedHosts.has(host) ? host : null;
  }, [url, trainedHosts]);

  async function discover() {
    const trimmed = url.trim();
    if (!trimmed || discovering) return;
    setDiscovering(true);
    setError(null);
    setDiscovery(null);
    setSelected([]);
    try {
      const result = await discoverCrawlUrls(normalizeSiteUrl(trimmed), agentId);
      setDiscovery(result);
      setSelected(canonicalCrawlUrls(result.urls ?? []));
    } catch (cause) {
      // Discovery is best-effort: a site with no sitemap is still crawlable by
      // following links, so a failure explains itself and leaves the path open
      // rather than blocking the only way to train a chatbot.
      setDiscovery({ total_found: 0, capped: false });
      setError(
        errorMessage(
          cause,
          'We could not count the pages on that site. You can still train on it — we will follow links from the homepage.',
        ),
      );
    } finally {
      setDiscovering(false);
    }
  }

  async function beginCrawl() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const options: StartCrawlOptions = {
        url: normalizeSiteUrl(trimmed),
        botId: agentId,
        botName: agentName,
        useJs,
      };
      if (hasPageList) {
        options.orderedUrls = selected;
        options.discoveredTotal = selected.length;
      } else if (discovery && discovery.total_found > 0) {
        options.discoveredTotal = discovery.total_found;
      }
      await startCrawl(options);
      setConfirmingStart(false);
    } catch (cause) {
      setConfirmingStart(false);
      setError(errorMessage(cause, 'We could not start training. Please try again.'));
    }
  }

  async function stopCrawl() {
    try {
      await cancelCrawl();
      setConfirmingCancel(false);
    } catch (cause) {
      setConfirmingCancel(false);
      setError(errorMessage(cause, 'We could not stop training. Please try again.'));
    }
  }

  if (pageAllowance.atLimit && !planLoading && !crawlRunning) {
    return (
      <CardBody>
        <LockedState
          title={`Your ${planName} plan's website pages are all used`}
          description={`This plan covers ${formatNumber(pageAllowance.limit)} crawled pages, and they are all in use. Remove a website below to free some up, or move to a plan with more.`}
          action={
            <Link to="/billing" className={buttonClass('primary', 'md')}>
              See plans
            </Link>
          }
        />
      </CardBody>
    );
  }

  const cost = budget ? pageCount * budget.costPerPage : 0;

  return (
    <>
      <CardBody className="space-y-4">
        {/* The allowance, stated before anything is spent. */}
        <Alert tone="plan">
          {planLoading ? (
            <>Checking what your plan includes…</>
          ) : pageAllowance.unlimited ? (
            <>
              Your {planName} plan has no page limit — website training is charged in credits,{' '}
              {formatNumber(pageAllowance.used)} pages trained on this chatbot so far.
            </>
          ) : (
            <>
              Your {planName} plan covers{' '}
              <span className="figure">{formatNumber(pageAllowance.limit)}</span> website pages.{' '}
              <span className="figure">{formatNumber(pageAllowance.used)}</span> are trained on this
              chatbot, so about <span className="figure">{formatNumber(pageAllowance.remaining)}</span>{' '}
              are left.
            </>
          )}
        </Alert>

        <Field
          label="Website address"
          hint={
            alreadyTrained
              ? `${alreadyTrained} is already trained. Training it again re-reads every page and charges for them — use Re-train on the source below to see what actually changed first.`
              : 'We read the pages, not the design. A public page is enough — no login.'
          }
        >
          <Input
            value={url}
            inputMode="url"
            placeholder="example.com"
            disabled={crawlRunning}
            leading={<Globe aria-hidden className="h-4 w-4" />}
            onChange={(event) => {
              edited.current = true;
              setUrl(event.target.value);
              setDiscovery(null);
              setSelected([]);
              setError(null);
            }}
          />
        </Field>

        <Switch
          checked={useJs}
          disabled={crawlRunning}
          onCheckedChange={(next) => {
            setUseJs(next);
            setDiscovery(null);
            setSelected([]);
          }}
          label="This site needs JavaScript to show its text"
          description="Turn this on for React, Next.js and other single-page sites. It is slower and covers fewer pages per run, so leave it off unless a first attempt came back empty."
        />

        {budget ? (
          <div className="rounded-md border border-border bg-surface-sunken px-4 py-3">
            <dl className="space-y-0.5">
              <FigureRow
                label="Pages found"
                value={`${formatNumber(budget.found)}${budget.capped ? '+' : ''}`}
                hint={budget.capped ? 'There may be more than we could list' : undefined}
              />
              <FigureRow
                label="Your plan allows per crawl"
                value={
                  budget.perCrawlLimit === null
                    ? 'No limit'
                    : formatNumber(budget.perCrawlLimit)
                }
              />
              <FigureRow
                label="Your credits cover"
                value={`${formatNumber(budget.affordablePages)} pages`}
                hint={`${formatNumber(budget.costPerPage)} credits a page · balance ${formatNumber(budget.balance)}`}
              />
              <FigureRow
                label="Selected"
                value={`${formatNumber(pageCount)} pages · ${formatNumber(cost)} credits`}
                emphasis
              />
            </dl>
          </div>
        ) : null}

        {budget && budget.found === 0 ? (
          <Alert tone="neutral">
            We could not list this site&apos;s pages. Training will follow links from the homepage
            instead and charge for what it reads.
          </Alert>
        ) : null}

        {hasPageList && !crawlRunning ? (
          <CrawlPageTree
            urls={discovery?.urls ?? []}
            selected={selected}
            onSelectionChange={setSelected}
            disabled={crawlRunning}
          />
        ) : null}

        {preflight?.message ? (
          <Alert tone={preflight.blocked ? 'warning' : 'plan'}>{preflight.message}</Alert>
        ) : null}

        {crawlRunning ? (
          <div className="space-y-3">
            <IngestionProgress
              title={crawlStatus === 'cancelling' ? 'Stopping' : 'Reading your website'}
              detail={crawlCurrentUrl ?? 'Finding pages'}
              done={crawlPages}
              total={crawlTotal}
              unit="pages"
            />
            <Button
              variant="danger"
              size="sm"
              disabled={crawlStatus === 'cancelling' || cancelInFlight}
              onClick={() => setConfirmingCancel(true)}
              iconLeft={<Square aria-hidden className="h-3.5 w-3.5" />}
            >
              {crawlStatus === 'cancelling' || cancelInFlight ? 'Stopping…' : 'Stop training'}
            </Button>
          </div>
        ) : null}

        {crawlIsOurs && crawlStatus === 'done' ? (
          <Alert tone="success" live>
            Finished — this chatbot read {formatNumber(crawlPages)} page
            {crawlPages === 1 ? '' : 's'}.
          </Alert>
        ) : null}

        {crawlIsOurs && (crawlStatus === 'failed' || crawlStatus === 'no_content') ? (
          <Alert tone="danger" live title="That website could not be read">
            {crawlStatus === 'no_content'
              ? 'We reached the site but found no readable text. If it is built with React or Next.js, turn on the JavaScript option above and try again — or upload a document instead.'
              : (crawlError ??
                'We could not finish reading that site. Try again, or upload a document instead.')}
          </Alert>
        ) : null}

        {crawlIsOurs && crawlStatus === 'cancelled' ? (
          <Alert tone="neutral" live>
            Training stopped. Pages that had already been read are kept, and you were not charged
            for the rest.
          </Alert>
        ) : null}

        {error ? (
          <Alert tone="danger" live>
            {error}
          </Alert>
        ) : null}
      </CardBody>

      <CardSection className="flex flex-wrap items-center gap-2">
        {discovery ? (
          <>
            <Button
              variant="accent"
              disabled={crawlRunning || !url.trim() || (preflight?.blocked ?? false)}
              onClick={() => setConfirmingStart(true)}
            >
              Train on {formatNumber(pageCount)} page{pageCount === 1 ? '' : 's'}
            </Button>
            <Button
              variant="ghost"
              disabled={crawlRunning || discovering}
              onClick={() => void discover()}
            >
              Check again
            </Button>
          </>
        ) : (
          <Button
            variant="accent"
            loading={discovering}
            disabled={discovering || crawlRunning || !url.trim()}
            onClick={() => void discover()}
            iconLeft={<Search aria-hidden className="h-4 w-4" />}
          >
            {discovering ? 'Checking pages…' : 'Check pages'}
          </Button>
        )}
      </CardSection>

      <ConfirmDialog
        open={confirmingStart}
        onOpenChange={setConfirmingStart}
        title="Start training?"
        description={
          budget ? (
            <>
              This reads <span className="figure">{formatNumber(pageCount)}</span> page
              {pageCount === 1 ? '' : 's'} of {url.trim() || 'this website'} and charges{' '}
              <span className="figure">{formatNumber(cost)}</span> credit{cost === 1 ? '' : 's'} —{' '}
              <span className="figure">{formatNumber(budget.costPerPage)}</span> a page, from a
              balance of <span className="figure">{formatNumber(budget.balance)}</span>. Pages are
              charged as they are read, so stopping early only pays for what was read.
            </>
          ) : (
            <>This reads {url.trim() || 'this website'} and charges credits for each page it reads.</>
          )
        }
        confirmLabel="Start training"
        onConfirm={beginCrawl}
      />

      <ConfirmDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
        destructive
        title="Stop training?"
        description="Pages already read are kept and stay charged. The rest are dropped, and you are not charged for them. You can start again at any time."
        confirmLabel="Stop training"
        cancelLabel="Keep training"
        onConfirm={stopCrawl}
      />
    </>
  );
}

// ── Documents ──────────────────────────────────────────────────────────────

interface DocumentsFlowProps {
  agentId: number;
  documentAllowance: Allowance;
  characterAllowance: Allowance | null;
  planName: string;
  planLoading: boolean;
  onChanged: () => void;
}

function DocumentsFlow({
  agentId,
  documentAllowance,
  characterAllowance,
  planName,
  planLoading,
  onChanged,
}: DocumentsFlowProps) {
  const [pending, setPending] = useState<File[] | null>(null);
  const [quote, setQuote] = useState<UploadCostPreview | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      setLanded(null);
      setQuoting(true);
      try {
        // The cost preview extracts and counts words server-side without saving
        // anything or touching the ledger, so the customer sees the price
        // before a single credit moves. When it is unavailable we say so rather
        // than uploading anyway — an unpriced charge is not a confirmation.
        const preview = await previewUploadCost(files, agentId);
        if (!preview) {
          setError(
            'We could not price these documents just now, so we have not uploaded them. Try again in a moment.',
          );
          return;
        }
        setPending(files);
        setQuote(preview);
      } catch (cause) {
        setError(errorMessage(cause, 'We could not read those files. Please try again.'));
      } finally {
        setQuoting(false);
      }
    },
    [agentId],
  );

  async function upload() {
    if (!pending) return;
    const files = pending;
    setUploading(true);
    setError(null);
    try {
      const result = (await uploadDocuments(files, agentId)) as {
        job_id?: string;
        credits_charged?: number;
      } | null;
      // `job_id` is present only when the API runs with the ARQ worker. Without
      // it, ingestion happens inline and there is nothing to poll — which the
      // progress component says plainly rather than spinning for ever.
      setJobId(typeof result?.job_id === 'string' ? result.job_id : null);
      setLanded(
        `${files.length} document${files.length === 1 ? '' : 's'} uploaded${
          typeof result?.credits_charged === 'number' && result.credits_charged > 0
            ? ` · ${formatNumber(result.credits_charged)} credits charged`
            : ''
        }.`,
      );
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, 'That upload did not go through. Please try again.'));
    } finally {
      // The confirmation closes either way. A failure explained behind a modal
      // the customer cannot see is the same as no explanation at all.
      setPending(null);
      setQuote(null);
      setUploading(false);
    }
  }

  if (documentAllowance.atLimit && !planLoading) {
    return (
      <CardBody>
        <LockedState
          title={`Your ${planName} plan's documents are all used`}
          description={`This plan covers ${formatNumber(documentAllowance.limit)} uploaded documents across the whole workspace, and they are all in use. Remove one below, or move to a plan with more.`}
          action={
            <Link to="/billing" className={buttonClass('primary', 'md')}>
              See plans
            </Link>
          }
        />
      </CardBody>
    );
  }

  if (characterAllowance !== null && characterAllowance.atLimit && !planLoading) {
    return (
      <CardBody>
        <LockedState
          title={`Your ${planName} plan's knowledge base is full`}
          description={`This plan holds ${formatNumber(characterAllowance?.limit ?? 0)} characters of knowledge, and it is full. Remove something below to make room, or move to a plan with a larger knowledge base.`}
          action={
            <Link to="/billing" className={buttonClass('primary', 'md')}>
              See plans
            </Link>
          }
        />
      </CardBody>
    );
  }

  const skipped = quote?.per_file.filter((file) => file.reason) ?? [];
  const billable = quote?.per_file.filter((file) => !file.reason) ?? [];
  // The confirm only opens when confirming would actually do something. A
  // dialog whose primary button is inert because the balance is short teaches
  // people that the button is a suggestion; an unaffordable quote is answered
  // on the page, beside the files, with the way to fix it.
  const affordable = quote !== null && quote.sufficient && quote.total_credits > 0;

  function clearPending() {
    setPending(null);
    setQuote(null);
  }

  return (
    <>
      <CardBody className="space-y-4">
        <Alert tone="plan">
          {planLoading ? (
            <>Checking what your plan includes…</>
          ) : documentAllowance.unlimited ? (
            <>
              Your {planName} plan has no document limit — uploads are charged in credits, by
              length.
            </>
          ) : (
            <>
              <span className="figure">{formatNumber(documentAllowance.remaining)}</span> of your{' '}
              {planName} plan&apos;s{' '}
              <span className="figure">{formatNumber(documentAllowance.limit)}</span> documents are
              still free across this workspace.
            </>
          )}
        </Alert>

        <FileDrop
          label="Drop documents here, or choose files"
          hint="Handbooks, product sheets, FAQs, policies — anything a visitor might ask about."
          accept={UPLOAD_EXTENSIONS}
          maxSizeBytes={MAX_UPLOAD_BYTES}
          maxFiles={MAX_UPLOAD_FILES}
          disabled={quoting || uploading || pending !== null}
          onFiles={(files) => void handleFiles(files)}
        />

        {quoting ? (
          <Progress
            value={null}
            label="Working out what these documents will cost"
            hideLabel={false}
          />
        ) : null}

        {quote !== null && !affordable ? (
          <Alert
            tone="plan"
            title={
              quote.total_credits === 0
                ? 'There is nothing to upload here'
                : 'Not enough credits for these documents'
            }
            action={
              quote.total_credits === 0 ? (
                <Button size="sm" onClick={clearPending}>
                  Choose other files
                </Button>
              ) : (
                <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                  Top up
                </Link>
              )
            }
          >
            {quote.total_credits === 0 ? (
              <>
                None of these files had readable text — most often a scanned PDF. Nothing was
                uploaded and nothing was charged.
              </>
            ) : (
              <>
                These cost <span className="figure">{formatNumber(quote.total_credits)}</span>{' '}
                credits and you have{' '}
                <span className="figure">{formatNumber(quote.current_balance)}</span>. Nothing has
                been uploaded or charged.
              </>
            )}
          </Alert>
        ) : null}

        {jobId !== null || landed !== null ? (
          <IngestionProgress
            jobId={jobId}
            title="Reading your documents"
            detail={landed ?? 'Uploaded'}
            onFinished={onChanged}
          />
        ) : null}

        {error ? (
          <Alert tone="danger" live>
            {error}
          </Alert>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={pending !== null && affordable}
        onOpenChange={(open) => {
          if (!open) clearPending();
        }}
        title={`Upload ${pending?.length ?? 0} document${(pending?.length ?? 0) === 1 ? '' : 's'}?`}
        description={
          quote ? (
            <>
              <span className="block">
                This charges <span className="figure">{formatNumber(quote.total_credits)}</span>{' '}
                credit{quote.total_credits === 1 ? '' : 's'} from a balance of{' '}
                <span className="figure">{formatNumber(quote.current_balance)}</span>. Documents are
                priced by length, and the chatbot can answer from them a minute or two later.
              </span>
              <dl className="mt-3 max-h-48 overflow-y-auto">
                {billable.map((file) => (
                  <FigureRow
                    key={file.filename}
                    label={file.filename}
                    value={`${formatNumber(file.credits)} credits`}
                    hint={`${formatNumber(file.words)} words`}
                  />
                ))}
                {skipped.map((file) => (
                  <FigureRow
                    key={file.filename}
                    label={file.filename}
                    value="Free"
                    hint={uploadSkipReason(file.reason) ?? undefined}
                  />
                ))}
              </dl>
            </>
          ) : null
        }
        confirmLabel={`Upload for ${formatNumber(quote?.total_credits ?? 0)} credits`}
        onConfirm={upload}
      />
    </>
  );
}
