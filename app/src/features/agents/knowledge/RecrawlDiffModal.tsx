import { type ReactElement, useMemo, useState } from 'react';
import {
  AlertCircle,
  ExternalLink,
  Eye,
  Globe,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { Button, Modal, cn } from '../../../design-system';
import type { RecrawlDiff } from './recrawl-api';

export interface RecrawlDiffModalProps {
  open: boolean;
  diff: RecrawlDiff;
  /** When set, the diff couldn't be fetched - offer a plain proceed instead of buckets. */
  error?: string | null;
  /** True while the recrawl is being started, to disable the confirm control. */
  starting?: boolean;
  onConfirm: () => void;
  onGetCredits: () => void;
  onClose: () => void;
}

type BucketKey = 'unchanged' | 'new' | 'removed';

interface BucketDef {
  key: BucketKey;
  label: string;
  sublabel: string;
  count: number;
  urls: string[];
  toneClass: string;
}

/**
 * RecrawlDiffModal - the pre-recrawl cost preview. Before spending credits the
 * user sees exactly how many pages are unchanged, new, and removed, can expand
 * each bucket's URL list, and (for full re-crawls) sees the precise credit cost
 * with an insufficient-balance guard. Delta re-crawls skip the up-front number
 * because the true bill depends on which pages changed at ingest time.
 */
export function RecrawlDiffModal({
  open,
  diff,
  error = null,
  starting = false,
  onConfirm,
  onGetCredits,
  onClose,
}: RecrawlDiffModalProps): ReactElement {
  const [viewing, setViewing] = useState<BucketKey | null>(null);

  const buckets = useMemo<BucketDef[]>(
    () => [
      {
        key: 'unchanged',
        label: 'Unchanged',
        sublabel: 'Pages unchanged',
        count: diff.unchanged,
        urls: diff.unchangedUrls,
        toneClass: 'text-[var(--ds-text-muted)]',
      },
      {
        key: 'new',
        label: 'New',
        sublabel: 'New pages found',
        count: diff.newPages,
        urls: diff.newUrls,
        toneClass: 'text-[var(--ds-success)]',
      },
      {
        key: 'removed',
        label: 'Removed',
        sublabel: 'Pages removed',
        count: diff.removedPages,
        urls: diff.removedUrls,
        toneClass: 'text-[var(--ds-danger)]',
      },
    ],
    [diff],
  );

  const isDelta = diff.mode === 'delta';

  // The full re-crawl set is every page that will actually be scraped: pages
  // discovered as new PLUS stored pages still alive (unchanged). These buckets
  // are disjoint by construction, so the crawl-set size is their sum. Cost and
  // the insufficient-balance guard MUST key off this - never off
  // `sitemap_total`. When sitemap discovery times out the endpoint still
  // returns 200 with sitemap_total=0 (and `credits_required_full`/
  // `exceeds_balance` derived from it), which would otherwise hide the cost
  // line and silently neutralise the balance guard while a full re-crawl still
  // force-reingests every unchanged page.
  const crawlSetSize = diff.unchanged + diff.newPages;
  const required = crawlSetSize * diff.costPerPage;

  // Full re-crawl with an empty sitemap = discovery failed/timed out; we can't
  // verify the site's page set, so block rather than let the user spend on it.
  const emptyDiscovery = diff.mode === 'full' && !error && diff.sitemapTotal === 0;
  const showFullCost = diff.mode === 'full' && !emptyDiscovery;
  const fullBlocked = showFullCost && required > diff.balance;
  const activeBucket = viewing ? buckets.find((b) => b.key === viewing) ?? null : null;

  const confirmLabel = fullBlocked
    ? 'Get more credits'
    : isDelta
      ? 'Re-train changed pages'
      : 'Re-train all pages';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={isDelta ? 'Re-train only updated pages?' : 'Re-train the entire website?'}
      description={
        isDelta
          ? "Unchanged pages are free - you'll only be billed for pages whose content changed since the last training run."
          : 'Every discovered page will be re-trained, and every page will be charged.'
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button
            variant={fullBlocked ? 'danger' : 'primary'}
            onClick={fullBlocked ? onGetCredits : onConfirm}
            disabled={starting || emptyDiscovery}
          >
            {starting ? (
              'Starting…'
            ) : (
              <>
                {isDelta ? (
                  <Sparkles size={16} aria-hidden="true" />
                ) : (
                  <RefreshCw size={16} aria-hidden="true" />
                )}
                {confirmLabel}
              </>
            )}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <a
          href={diff.crawlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-accent)] hover:underline"
        >
          <Globe size={15} aria-hidden="true" />
          <span className="max-w-[22rem] truncate">{diff.crawlUrl}</span>
          <ExternalLink size={13} aria-hidden="true" className="opacity-80" />
        </a>

        {error ? (
          <div className="space-y-1.5 rounded-lg border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-4 py-3 text-[13px] text-[var(--ds-danger)]">
            <p className="flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                We couldn&apos;t preview the page changes. You can still proceed - training will{' '}
                {isDelta
                  ? 'skip unchanged pages during ingestion.'
                  : 're-train and re-bill every page.'}
              </span>
            </p>
            <p className="break-words pl-6 font-mono text-[11px] opacity-80">{error}</p>
          </div>
        ) : emptyDiscovery ? (
          <div className="space-y-1.5 rounded-lg border border-[var(--ds-warning-soft)] bg-[var(--ds-warning-soft)] px-4 py-3 text-[13px] text-[var(--ds-warning)]">
            <p className="flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                No pages discovered - the site&apos;s sitemap may be temporarily unavailable. Try
                again shortly. We won&apos;t start a full re-train until we can confirm the pages to
                train, so you&apos;re never charged for a set we can&apos;t verify.
              </span>
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {buckets.map((bucket) => {
                const isActive = viewing === bucket.key;
                const isEmpty = bucket.count === 0;
                return (
                  <div
                    key={bucket.key}
                    className={cn(
                      'relative flex min-h-[104px] flex-col justify-between rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-4 transition-shadow',
                      isActive && 'shadow-[0_0_0_1px_var(--ds-accent)]',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setViewing(isActive ? null : bucket.key)}
                      disabled={isEmpty}
                      aria-label={`View ${bucket.label.toLowerCase()} pages`}
                      aria-expanded={isActive}
                      className="absolute right-2 top-2 rounded-md p-1 text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Eye size={13} aria-hidden="true" />
                    </button>
                    <span
                      className={cn(
                        'pr-6 text-[11px] font-semibold uppercase tracking-wider',
                        bucket.toneClass,
                      )}
                    >
                      {bucket.label}
                    </span>
                    <span className="my-1 text-2xl font-semibold tabular-nums text-[var(--ds-text)]">
                      {bucket.count.toLocaleString()}
                    </span>
                    <span className="text-[11px] text-[var(--ds-text-subtle)]">{bucket.sublabel}</span>
                  </div>
                );
              })}
            </div>

            {showFullCost && (
              <div
                className={cn(
                  'rounded-xl border px-4 py-3 text-[13px]',
                  fullBlocked
                    ? 'border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]'
                    : 'border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]',
                )}
              >
                <p className="font-semibold text-[var(--ds-text)]">
                  {fullBlocked ? (
                    <>
                      Not enough credits - this re-crawl needs{' '}
                      <span className="tabular-nums">{required.toLocaleString()}</span> credit
                      {required === 1 ? '' : 's'}.
                    </>
                  ) : (
                    <>
                      This will charge{' '}
                      <span className="tabular-nums">{required.toLocaleString()}</span> credit
                      {required === 1 ? '' : 's'}.
                    </>
                  )}
                </p>
                <p className="mt-1 tabular-nums">
                  {diff.costPerPage.toLocaleString()} credit{diff.costPerPage === 1 ? '' : 's'} per page ×{' '}
                  {crawlSetSize.toLocaleString()} page{crawlSetSize === 1 ? '' : 's'} - you have{' '}
                  <span className="font-semibold text-[var(--ds-text)]">
                    {diff.balance.toLocaleString()}
                  </span>{' '}
                  credit{diff.balance === 1 ? '' : 's'} available.
                </p>
                {fullBlocked && (
                  <p className="mt-1.5 text-[12px]">
                    Upgrade your plan or buy a top-up to unlock this re-crawl.
                  </p>
                )}
              </div>
            )}

            {activeBucket && (
              <div className="overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]">
                <div className="flex items-center justify-between gap-2 border-b border-[var(--ds-border)] px-4 py-2.5">
                  <span className="text-[12px] font-semibold text-[var(--ds-text)]">
                    {activeBucket.sublabel}
                    <span className="ml-1.5 font-normal text-[var(--ds-text-subtle)]">
                      ({activeBucket.count.toLocaleString()})
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setViewing(null)}
                    aria-label="Close page list"
                    className="rounded p-1 text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
                <ul className="max-h-56 divide-y divide-[var(--ds-border)] overflow-y-auto">
                  {activeBucket.urls.length === 0 ? (
                    <li className="px-4 py-3 text-center text-[12px] text-[var(--ds-text-subtle)]">
                      No pages in this bucket.
                    </li>
                  ) : (
                    activeBucket.urls.map((u) => (
                      <li key={u} className="px-4 py-1.5 text-[12px]">
                        <a
                          href={u}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 truncate text-[var(--ds-text-muted)] hover:text-[var(--ds-accent)] hover:underline"
                        >
                          <ExternalLink size={11} className="shrink-0 opacity-60" aria-hidden="true" />
                          <span className="truncate">{u}</span>
                        </a>
                      </li>
                    ))
                  )}
                </ul>
                {activeBucket.count > activeBucket.urls.length && (
                  <div className="border-t border-[var(--ds-border)] px-4 py-1.5 text-[10px] text-[var(--ds-text-subtle)]">
                    Showing first {activeBucket.urls.length.toLocaleString()} of{' '}
                    {activeBucket.count.toLocaleString()} pages.
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
