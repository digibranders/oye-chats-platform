import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import {
  Alert,
  Button,
  Dialog,
  LockedState,
  SegmentedControl,
  StatTile,
  buttonClass,
  formatNumber,
} from '../../../ui';
import {
  orderedUrlsForRecrawl,
  recrawlBlockedReason,
  recrawlCost,
  type RecrawlDiff,
} from './knowledge-model';

type Bucket = 'unchanged' | 'new' | 'removed';

export interface RecrawlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while the preview is still being fetched. */
  diff: RecrawlDiff | null;
  /** The source and mode, known before the diff resolves. */
  sourceName: string;
  loading: boolean;
  /** The preview itself failed. The re-crawl can still go ahead, unpreviewed. */
  previewError: string | null;
  /** The plan does not include updated-pages-only re-training. */
  planLocked: boolean;
  starting: boolean;
  startError: string | null;
  onConfirm: () => void;
}

/**
 * What a re-crawl will change, and what it will cost, before a credit moves.
 *
 * A `Dialog` rather than `ConfirmDialog` because the consequence here is not one
 * sentence — it is three page counts, a per-page price, a balance, and two
 * caveats about how complete those counts are. The confirm button still states
 * the actual consequence in full, which is the rule `ConfirmDialog` exists to
 * enforce.
 *
 * The cost is computed from *new + unchanged*, the pages a full re-crawl really
 * fetches — never from `sitemap_total`, which reads 0 when discovery times out
 * and would print "0 credits" over a run that re-bills every stored page.
 */
export function RecrawlDialog({
  open,
  onOpenChange,
  diff,
  sourceName,
  loading,
  previewError,
  planLocked,
  starting,
  startError,
  onConfirm,
}: RecrawlDialogProps) {
  const [bucket, setBucket] = useState<Bucket>('new');

  const mode = diff?.mode ?? 'full';
  const isDelta = mode === 'delta';
  const cost = diff ? recrawlCost(diff) : null;
  const blockedReason = diff ? recrawlBlockedReason(diff, previewError !== null) : null;
  const shortOnCredits = diff !== null && !isDelta && cost !== null && cost.credits > diff.balance;
  const rediscovers = diff !== null && orderedUrlsForRecrawl(diff) === null;

  const urls =
    diff === null
      ? []
      : bucket === 'unchanged'
        ? diff.unchangedUrls
        : bucket === 'new'
          ? diff.newUrls
          : diff.removedUrls;
  const bucketCount =
    diff === null
      ? 0
      : bucket === 'unchanged'
        ? diff.unchanged
        : bucket === 'new'
          ? diff.newPages
          : diff.removedPages;

  const canConfirm =
    !planLocked && !loading && diff !== null && blockedReason === null && !shortOnCredits;

  return (
    <Dialog
      open={open}
      onOpenChange={starting ? () => {} : onOpenChange}
      size="lg"
      dismissible={!starting}
      title={isDelta ? 'Re-train the pages that changed?' : 'Re-train this whole website?'}
      description={
        isDelta
          ? 'Unchanged pages are skipped and not charged. You pay only for pages whose content moved since the last run.'
          : 'Every page is read again and every page is charged, whether or not it changed.'
      }
      footer={
        planLocked ? (
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={starting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {shortOnCredits ? (
              <Link to="/billing" className={buttonClass('primary', 'md')}>
                Top up credits
              </Link>
            ) : (
              <Button
                variant="accent"
                loading={starting}
                disabled={!canConfirm || starting}
                onClick={onConfirm}
              >
                {isDelta
                  ? 'Re-train changed pages'
                  : cost
                    ? `Re-train ${formatNumber(cost.pages)} pages for ${formatNumber(cost.credits)} credits`
                    : 'Re-train'}
              </Button>
            )}
          </>
        )
      }
    >
      {planLocked ? (
        <LockedState
          title="Updated-pages-only re-training is on Standard and above"
          description="It compares your site against what this chatbot already read, then re-trains and charges for only the pages whose content changed. On your plan, re-training reads and charges for every page."
          action={
            <Link to="/billing" className={buttonClass('primary', 'md')}>
              See plans
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          <a
            href={diff?.crawlUrl ?? sourceName}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 text-base text-accent-600 hover:text-accent-700 hover:underline"
          >
            <span className="truncate">{sourceName}</span>
            <ExternalLink aria-hidden className="h-3.5 w-3.5 shrink-0" />
          </a>

          {loading ? (
            <p className="text-prose text-text-secondary" role="status">
              Comparing this site against what your chatbot already read…
            </p>
          ) : null}

          {previewError ? (
            <Alert tone="warning" title="We could not compare the pages">
              {previewError} You can still re-train — we will rediscover the site as we go, and{' '}
              {isDelta
                ? 'unchanged pages will still be skipped during reading.'
                : 'every page found will be read and charged.'}
            </Alert>
          ) : null}

          {blockedReason ? <Alert tone="warning">{blockedReason}</Alert> : null}

          {diff && !loading && !blockedReason ? (
            <>
              <div className="grid grid-cols-3 gap-4 rounded-md border border-border bg-surface-sunken px-4 py-3">
                <StatTile
                  label="Unchanged"
                  value={formatNumber(diff.unchanged)}
                  period={isDelta ? 'Skipped, free' : 'Read again, charged'}
                />
                <StatTile label="New" value={formatNumber(diff.newPages)} period="Not read before" />
                <StatTile
                  label="Gone"
                  value={formatNumber(diff.removedPages)}
                  period={diff.headPartial ? 'At least — see below' : 'No longer on the site'}
                />
              </div>

              {diff.headPartial ? (
                <Alert tone="neutral">
                  We could not check every stored page for a response in time, so the &ldquo;gone&rdquo;
                  count is a floor rather than a total. Nothing is deleted by this preview.
                </Alert>
              ) : null}

              {isDelta ? (
                <Alert tone="plan">
                  The exact bill depends on which pages actually changed, which is only known as
                  each page is read. At{' '}
                  <span className="figure">{formatNumber(diff.costPerPage)}</span> credits a page,
                  the worst case is{' '}
                  <span className="figure">{formatNumber(cost?.credits ?? 0)}</span> and your balance
                  is <span className="figure">{formatNumber(diff.balance)}</span>.
                </Alert>
              ) : (
                <Alert tone={shortOnCredits ? 'plan' : 'neutral'}>
                  {shortOnCredits ? (
                    <>
                      This needs <span className="figure">{formatNumber(cost?.credits ?? 0)}</span>{' '}
                      credits and you have{' '}
                      <span className="figure">{formatNumber(diff.balance)}</span>. Nothing has been
                      charged.
                    </>
                  ) : (
                    <>
                      <span className="figure">{formatNumber(cost?.pages ?? 0)}</span> pages ×{' '}
                      <span className="figure">{formatNumber(diff.costPerPage)}</span> credits ={' '}
                      <span className="figure">{formatNumber(cost?.credits ?? 0)}</span> credits,
                      from a balance of{' '}
                      <span className="figure">{formatNumber(diff.balance)}</span>.
                    </>
                  )}
                </Alert>
              )}

              {rediscovers ? (
                <Alert tone="neutral">
                  This site has more pages than we can list here, so the re-train walks the whole
                  site itself rather than the list below. The counts above are still exact.
                </Alert>
              ) : null}

              <div className="space-y-2">
                <SegmentedControl<Bucket>
                  label="Which pages to list"
                  size="sm"
                  value={bucket}
                  onChange={setBucket}
                  items={[
                    { value: 'new', label: `New ${formatNumber(diff.newPages)}` },
                    { value: 'unchanged', label: `Unchanged ${formatNumber(diff.unchanged)}` },
                    { value: 'removed', label: `Gone ${formatNumber(diff.removedPages)}` },
                  ]}
                />
                <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {urls.length === 0 ? (
                    <li className="px-3 py-2.5 text-xs text-text-secondary">
                      No pages in this group.
                    </li>
                  ) : (
                    urls.map((url) => (
                      <li key={url} className="px-3 py-1.5">
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-xs text-text-secondary hover:text-accent-600 hover:underline"
                        >
                          {url}
                        </a>
                      </li>
                    ))
                  )}
                  {bucketCount > urls.length ? (
                    <li className="px-3 py-2 text-2xs text-text-tertiary">
                      Showing the first <span className="figure">{formatNumber(urls.length)}</span>{' '}
                      of <span className="figure">{formatNumber(bucketCount)}</span>.
                    </li>
                  ) : null}
                </ul>
              </div>
            </>
          ) : null}

          {startError ? (
            <Alert tone="danger" live>
              {startError}
            </Alert>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
