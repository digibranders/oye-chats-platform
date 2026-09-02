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
  type RecrawlMode,
} from './knowledge-model';
import { useTranslation } from '../../../i18n/useTranslation';

type Bucket = 'unchanged' | 'new' | 'removed';

export interface RecrawlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Null while the preview is still being fetched, and null for good once it
   * has failed. There is no third state where counts are invented to fill it.
   */
  diff: RecrawlDiff | null;
  /** The source and mode, known before the diff resolves. */
  sourceName: string;
  /** What the customer asked for, which survives a preview that never arrives. */
  mode: RecrawlMode;
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
 *
 * **A failed preview prices nothing.** The page used to hand this dialog a
 * synthetic all-zero diff with an invented `balance: 0`, and every figure below
 * rendered from it: "Unchanged 0 · New 0 · Gone 0 · Cost 0 credits" and an
 * enabled "Re-train 0 pages for 0 credits" over a `force_reingest` run that
 * re-reads and re-bills every stored page, 2,000 credits on a 400-page site.
 * With no preview there is no well, no cost row and no count on the button:
 * only the warning that says the comparison failed and that every page found
 * will be read and charged.
 */
export function RecrawlDialog({
  open,
  onOpenChange,
  diff,
  sourceName,
  mode: requestedMode,
  loading,
  previewError,
  planLocked,
  starting,
  startError,
  onConfirm,
}: RecrawlDialogProps) {
  const { t } = useTranslation();
  const [bucket, setBucket] = useState<Bucket>('new');

  const mode = diff?.mode ?? requestedMode;
  const isDelta = mode === 'delta';
  const previewFailed = previewError !== null;
  // Every figure below reads from this, never from `diff`: a comparison the
  // customer has just been told failed is not a source of counts or of a price.
  const previewed = previewFailed ? null : diff;
  const cost = previewed ? recrawlCost(previewed) : null;
  const blockedReason = diff ? recrawlBlockedReason(diff, previewFailed) : null;
  const shortOnCredits =
    previewed !== null && !isDelta && cost !== null && cost.credits > previewed.balance;
  const rediscovers = previewed !== null && orderedUrlsForRecrawl(previewed) === null;

  const urls =
    previewed === null
      ? []
      : bucket === 'unchanged'
        ? previewed.unchangedUrls
        : bucket === 'new'
          ? previewed.newUrls
          : previewed.removedUrls;
  const bucketCount =
    previewed === null
      ? 0
      : bucket === 'unchanged'
        ? previewed.unchanged
        : bucket === 'new'
          ? previewed.newPages
          : previewed.removedPages;

  // An unpreviewed re-train stays available: a network hiccup on a courtesy
  // comparison must not be the reason a customer cannot refresh their own
  // website. What it loses is the right to quote a number for it.
  const canConfirm =
    !planLocked &&
    !loading &&
    (previewed !== null || previewFailed) &&
    blockedReason === null &&
    !shortOnCredits;

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
                    : previewFailed
                      ? // No count and no price, because neither is known. The
                        // label still states the consequence in full, which is
                        // the whole job of this button.
                        t('agents.reTrainEveryPageCharged') || 'Re-train every page, charged'
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

          {/* No preview, no figures. The well below is the only thing on this
              surface that states a price, so it renders from a comparison that
              actually happened or it does not render at all. */}
          {previewed && !loading && !blockedReason ? (
            <>
              {/* One well, four rows. It used to be a three-tile stat block
                  followed by an `Alert` restating the same arithmetic in prose,
                  and on a delta run a second `Alert` restating it again. */}
              <Well>
                <FigureList>
                  <FigureRow
                    label={t('agents.unchanged') || 'Unchanged'}
                    value={formatNumber(previewed.unchanged)}
                    hint={isDelta ? 'Skipped, free' : t('agents.readAgainCharged') || 'Read again, charged'}
                  />
                  <FigureRow
                    label={t('agents.new') || 'New'}
                    value={formatNumber(previewed.newPages)}
                    hint={t('agents.notReadBefore') || 'Not read before'}
                  />
                  <FigureRow
                    label={t('agents.gone') || 'Gone'}
                    value={formatNumber(previewed.removedPages)}
                    hint={
                      previewed.headPartial
                        ? t('agents.atLeastThisManyWe') || 'At least this many. We could not check every stored page in time, and nothing is deleted by this preview'
                        : t('agents.noLongerOnTheSite') || 'No longer on the site'
                    }
                  />
                  <FigureRow
                    label={isDelta ? t('agents.worstCase') || 'Worst case' : t('agents.cost') || 'Cost'}
                    // A free re-crawl says so. "0 credits a page" reads like a
                    // rounding error, and this is the number people check
                    // before they commit.
                    value={
                      previewed.costPerPage === 0
                        ? t('agents.thisIsFree') || 'free'
                        : `${formatNumber(cost?.credits ?? 0)} credits`
                    }
                    hint={
                      previewed.costPerPage === 0
                        ? t('agents.thisTrainingIsFree') || 'This training is free · balance unchanged'
                        : isDelta
                          ? `The bill depends on which pages actually changed. ${formatNumber(previewed.costPerPage)} credits a page · balance ${formatNumber(previewed.balance)}`
                          : `${formatNumber(cost?.pages ?? 0)} pages × ${formatNumber(previewed.costPerPage)} credits · balance ${formatNumber(previewed.balance)}`
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
                  <span className="figure">{formatNumber(previewed.balance)}</span>. Nothing has been
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
                    { value: 'new', label: `New ${formatNumber(previewed.newPages)}` },
                    { value: 'unchanged', label: `Unchanged ${formatNumber(previewed.unchanged)}` },
                    { value: 'removed', label: `Gone ${formatNumber(previewed.removedPages)}` },
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
