import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import {
  Alert,
  Button,
  Dialog,
  Disclosure,
  FigureList,
  FigureRow,
  LockedState,
  SegmentedControl,
  Well,
  buttonClass,
  formatNumber,
} from '../../../ui';
import {
  orderedUrlsForRecrawl,
  recrawlBlockedReason,
  recrawlCost,
  type RecrawlDiff,
} from './knowledge-model';
import { useTranslation } from '../../../i18n/useTranslation';

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
  const { t } = useTranslation();
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
      title={isDelta ? t('agents.reTrainThePagesThat') || 'Re-train the pages that changed?' : t('agents.reTrainThisWholeWebsite') || 'Re-train this whole website?'}
      description={
        isDelta
          ? t('agents.unchangedPagesAreSkippedAnd') || 'Unchanged pages are skipped and not charged. You pay only for pages whose content moved since the last run.'
          : t('agents.everyPageIsReadAgain') || 'Every page is read again and every page is charged, whether or not it changed.'
      }
      footer={
        planLocked ? (
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={starting} onClick={() => onOpenChange(false)}>
              {t('agents.cancel') || 'Cancel'}
            </Button>
            {shortOnCredits ? (
              <Link to="/billing" className={buttonClass('primary', 'md')}>
                {t('agents.topUpCredits') || 'Top up credits'}
              </Link>
            ) : (
              <Button
                variant="accent"
                loading={starting}
                disabled={!canConfirm || starting}
                onClick={onConfirm}
              >
                {isDelta
                  ? t('agents.reTrainChangedPages') || 'Re-train changed pages'
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
          size="panel"
          title={t('agents.updatedPagesOnlyReTraining') || 'Updated-pages-only re-training is on Standard and above'}
          description={t('agents.standardComparesYourSiteAnd') || 'Standard compares your site and charges only for changed pages. Your plan re-reads and charges for all of them.'}
          action={
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              {t('agents.seePlans') || 'See plans'}
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
              {t('agents.comparingThisSiteAgainstWhat') || 'Comparing this site against what your chatbot already read…'}
            </p>
          ) : null}

          {previewError ? (
            <Alert tone="warning" title={t('agents.weCouldNotCompareThe2') || 'We could not compare the pages'}>
              {previewError} You can still re-train — we will rediscover the site as we go, and{' '}
              {isDelta
                ? 'unchanged pages will still be skipped during reading.'
                : 'every page found will be read and charged.'}
            </Alert>
          ) : null}

          {blockedReason ? <Alert tone="warning">{blockedReason}</Alert> : null}

          {diff && !loading && !blockedReason ? (
            <>
              {/* One well, four rows. It used to be a three-tile stat block
                  followed by an `Alert` restating the same arithmetic in prose,
                  and on a delta run a second `Alert` restating it again. */}
              <Well>
                <FigureList>
                  <FigureRow
                    label={t('agents.unchanged') || 'Unchanged'}
                    value={formatNumber(diff.unchanged)}
                    hint={isDelta ? 'Skipped, free' : t('agents.readAgainCharged') || 'Read again, charged'}
                  />
                  <FigureRow
                    label={t('agents.new') || 'New'}
                    value={formatNumber(diff.newPages)}
                    hint={t('agents.notReadBefore') || 'Not read before'}
                  />
                  <FigureRow
                    label={t('agents.gone') || 'Gone'}
                    value={formatNumber(diff.removedPages)}
                    hint={
                      diff.headPartial
                        ? t('agents.atLeastThisManyWe') || 'At least this many — we could not check every stored page in time, and nothing is deleted by this preview'
                        : t('agents.noLongerOnTheSite') || 'No longer on the site'
                    }
                  />
                  <FigureRow
                    label={isDelta ? t('agents.worstCase') || 'Worst case' : t('agents.cost') || 'Cost'}
                    value={`${formatNumber(cost?.credits ?? 0)} credits`}
                    hint={
                      isDelta
                        ? `The bill depends on which pages actually changed. ${formatNumber(diff.costPerPage)} credits a page · balance ${formatNumber(diff.balance)}`
                        : `${formatNumber(cost?.pages ?? 0)} pages × ${formatNumber(diff.costPerPage)} credits · balance ${formatNumber(diff.balance)}`
                    }
                    emphasis
                    tone={shortOnCredits ? 'danger' : 'neutral'}
                  />
                </FigureList>
              </Well>

              {shortOnCredits ? (
                <Alert tone="plan">
                  This needs <span className="figure">{formatNumber(cost?.credits ?? 0)}</span>{' '}
                  credits and you have{' '}
                  <span className="figure">{formatNumber(diff.balance)}</span>. Nothing has been
                  charged.
                </Alert>
              ) : null}

              {rediscovers ? (
                <Alert tone="neutral">
                  This site has more pages than we can list here, so the re-train walks the whole
                  site itself rather than the list below. The counts above are still exact.
                </Alert>
              ) : null}

              {/* Closed by default, so the dialog opens at its decision height.
                  A modal whose body scrolls internally while the page behind it
                  also scrolls is the pattern a drawer exists for; the decision
                  here is three counts and a price, and the per-page browser is
                  the detail behind it. */}
              <Disclosure summary="See which pages">
                <SegmentedControl<Bucket>
                  label={t('agents.whichPagesToList') || 'Which pages to list'}
                  size="sm"
                  value={bucket}
                  onChange={setBucket}
                  items={[
                    { value: 'new', label: `New ${formatNumber(diff.newPages)}` },
                    { value: 'unchanged', label: `Unchanged ${formatNumber(diff.unchanged)}` },
                    { value: 'removed', label: `Gone ${formatNumber(diff.removedPages)}` },
                  ]}
                />
                <ul className="mt-2 max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {urls.length === 0 ? (
                    <li className="px-3 py-2.5 text-xs text-text-secondary">
                      {t('agents.noPagesInThisGroup') || 'No pages in this group.'}
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
              </Disclosure>
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
