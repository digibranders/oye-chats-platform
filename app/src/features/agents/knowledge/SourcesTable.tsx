import { useMemo, useState } from 'react';
import { FileText, Globe, MoreHorizontal, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  SearchField,
  SegmentedControl,
  Toolbar,
  Tooltip,
  WorkingDots,
  formatDate,
  formatNumber,
  type Column,
} from '../../../ui';
import type { KnowledgeSource } from '../../../types/domain';
import {
  filterSources,
  isWebsiteSource,
  sourceState,
  sourceUnits,
  type RecrawlMode,
  type SourceKind,
} from './knowledge-model';

/**
 * Pages this source is made of, or `null` when nothing recorded any.
 *
 * A website knows how many pages were read. A document knows only if the
 * extractor reported a page count — a `.txt` never does — and guessing its
 * passage count in that column is what made the table state one number twice.
 */
function pageCount(source: KnowledgeSource): number | null {
  const pages = isWebsiteSource(source.name) ? source.page_count : source.doc_page_count;
  return typeof pages === 'number' && pages > 0 ? pages : null;
}

export interface SourcesTableProps {
  sources: readonly KnowledgeSource[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** True when the plan will actually run an updated-pages-only re-crawl. */
  canUseDelta: boolean;
  /** The source a diff is currently being fetched for. */
  busySource: string | null;
  /**
   * The registrable domain of the crawl running right now for this chatbot, or
   * `null`. It is what lets a row say "Training" rather than reporting whatever
   * it happened to hold when the run started.
   */
  crawlingDomain: string | null;
  onViewPages: (source: KnowledgeSource) => void;
  onRecrawl: (source: KnowledgeSource, mode: RecrawlMode) => void;
  onDelete: (source: KnowledgeSource) => Promise<void>;
  /** Blocks every action while a crawl is already running for this chatbot. */
  crawlRunning: boolean;
  /** Free-text filter over source names, held in the URL by the page. */
  query: string;
  onQueryChange: (next: string) => void;
  /** All / websites / documents, also in the URL. */
  kind: SourceKind;
  onKindChange: (next: SourceKind) => void;
}

/**
 * Everything this chatbot has learned from.
 *
 * The table answers "what does it know?" before it answers "what did we last
 * do?" — the row's badge reads from the passages it holds, because a source with
 * thousands of indexed passages and one failed refresh is a working chatbot on
 * slightly old information, not a broken one.
 *
 * **That badge now exists.** The docblock promised it and the only `Badge` on a
 * row rendered *Website* or *Document* — a type, not a state — so a source that
 * failed to extract, one still being read, and one fully trained were visually
 * identical apart from an em dash in the Passages column. The type moved onto
 * the icon that was already in the Source cell, which reclaims the width, and
 * the column it vacated carries the state instead. See `sourceState`.
 */
export function SourcesTable({
  sources,
  loading,
  error,
  onRetry,
  canUseDelta,
  busySource,
  crawlingDomain,
  onViewPages,
  onRecrawl,
  onDelete,
  crawlRunning,
  query,
  onQueryChange,
  kind,
  onKindChange,
}: SourcesTableProps) {
  const [confirming, setConfirming] = useState<KnowledgeSource | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [removing, setRemoving] = useState(false);

  const visible = useMemo(() => filterSources(sources, query, kind), [sources, query, kind]);
  const chosen = useMemo(
    () => visible.filter((source) => selected.has(source.name)),
    [visible, selected],
  );
  const chosenPassages = chosen.reduce((total, source) => total + (source.chunk_count ?? 0), 0);

  const columns = useMemo<Column<KnowledgeSource>[]>(
    () => [
      {
        key: 'name',
        header: 'Source',
        rowHeader: true,
        sortable: (a, b) => a.name.localeCompare(b.name),
        render: (row) => {
          const website = isWebsiteSource(row.name);
          const Icon = website ? Globe : FileText;
          return (
            <span className="flex min-w-0 items-center gap-2.5">
              {/* The icon carries the kind. It always did — the Kind column beside
                  it spent 8rem of table restating it in a word. */}
              <Tooltip content={website ? 'Website' : 'Document'}>
                <span className="flex shrink-0 items-center">
                  <Icon aria-hidden className="h-4 w-4 text-text-tertiary" />
                  <span className="sr-only">{website ? 'Website' : 'Document'}</span>
                </span>
              </Tooltip>
              <span className="min-w-0 truncate font-medium text-text-primary">{row.name}</span>
            </span>
          );
        },
      },
      {
        key: 'state',
        header: 'State',
        width: '8rem',
        sortable: (a, b) =>
          sourceState(a, crawlingDomain).label.localeCompare(sourceState(b, crawlingDomain).label),
        render: (row) => {
          const state = sourceState(row, crawlingDomain);
          return (
            <span className="flex items-center gap-2">
              <Badge tone={state.tone} dot>
                {state.label}
              </Badge>
              {/* In-progress is motion, not hue — this system has no fifth tone
                  for "working". */}
              {state.kind === 'training' ? <WorkingDots label="Being read now" /> : null}
            </span>
          );
        },
      },
      {
        // Pages, not "Size". `sourceUnits` falls back to the passage count for a
        // document whose page count the backend never recorded, so the column
        // printed "42 passages" beside a Passages column reading 42 — one fact,
        // twice, in two adjacent columns, at the cost of 8rem in a pane that was
        // already overflowing its card. It states pages where pages are known
        // and `—` where they are not.
        key: 'pages',
        header: 'Pages',
        type: 'number',
        width: '6rem',
        sortable: (a, b) => (pageCount(a) ?? -1) - (pageCount(b) ?? -1),
        render: (row) => {
          const pages = pageCount(row);
          return pages === null ? '—' : formatNumber(pages);
        },
      },
      {
        key: 'passages',
        header: 'Passages',
        // One hint, on the column head, rather than 25 identical ones on a
        // non-focusable span — hover-only, unreachable by keyboard, invisible
        // on touch. It is a `headerHint` rather than a `<Tooltip>` in `header`
        // because this column sorts, so the heading is already a button and the
        // trigger was nesting a second button inside it.
        headerHint: 'Passages are the pieces this chatbot searches when it answers.',
        type: 'number',
        width: '6.5rem',
        secondary: true,
        sortable: (a, b) => (a.chunk_count ?? 0) - (b.chunk_count ?? 0),
        render: (row) => (row.chunk_count ? formatNumber(row.chunk_count) : '—'),
      },
      {
        key: 'ingested_at',
        // "Last trained", not "Trained": the State column beside it says
        // *Trained*, and one word meaning both a date and a state in adjacent
        // columns is the kind of collision a reader has to stop and resolve.
        header: 'Last trained',
        type: 'number',
        width: '8rem',
        sortable: (a, b) => Date.parse(a.ingested_at ?? '') - Date.parse(b.ingested_at ?? ''),
        render: (row) => (row.ingested_at ? formatDate(row.ingested_at) : '—'),
      },
      {
        key: 'actions',
        header: 'Actions',
        align: 'right',
        width: '4.5rem',
        render: (row) => {
          const website = isWebsiteSource(row.name);
          return (
            <MenuRoot>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Actions for ${row.name}`}
                    loading={busySource === row.name}
                  >
                    <MoreHorizontal aria-hidden />
                  </Button>
                }
              />
              <MenuContent>
                {website ? (
                  <>
                    <MenuItem onSelect={() => onViewPages(row)}>See the pages it read</MenuItem>
                    <MenuItem
                      disabled={crawlRunning}
                      icon={<RefreshCw aria-hidden className="h-3.5 w-3.5" />}
                      onSelect={() => onRecrawl(row, 'full')}
                    >
                      Re-train every page…
                    </MenuItem>
                    <MenuItem
                      disabled={crawlRunning}
                      icon={<Sparkles aria-hidden className="h-3.5 w-3.5" />}
                      onSelect={() => onRecrawl(row, 'delta')}
                    >
                      {canUseDelta ? 'Re-train changed pages…' : 'Re-train changed pages (Standard)'}
                    </MenuItem>
                    <MenuSeparator />
                  </>
                ) : null}
                <MenuItem
                  destructive
                  icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}
                  onSelect={() => setConfirming(row)}
                >
                  Remove…
                </MenuItem>
              </MenuContent>
            </MenuRoot>
          );
        },
      },
    ],
    [busySource, canUseDelta, crawlRunning, crawlingDomain, onRecrawl, onViewPages],
  );

  const confirmingUnits = confirming ? sourceUnits(confirming) : null;
  const filtered = query.trim() !== '' || kind !== 'all';

  return (
    <>
      {/* Search and a type filter, on a table capped at 25 rows a page: a
          workspace with sixty sources paged through three screens with no way to
          find `pricing.pdf`. Both controls are 28px, on one line. */}
      <Toolbar className="border-b border-border px-cell py-2.5">
        <div className="w-full sm:w-64">
          <SearchField
            label="Search sources"
            size="sm"
            placeholder="Search by name"
            value={query}
            onValueChange={onQueryChange}
          />
        </div>
        <SegmentedControl<SourceKind>
          label="Source type"
          size="sm"
          value={kind}
          onChange={onKindChange}
          items={[
            { value: 'all', label: 'All', count: sources.length },
            {
              value: 'websites',
              label: 'Websites',
              count: sources.filter((source) => isWebsiteSource(source.name)).length,
            },
            {
              value: 'documents',
              label: 'Documents',
              count: sources.filter((source) => !isWebsiteSource(source.name)).length,
            },
          ]}
        />
      </Toolbar>

      <DataTable
        seated
        fit
        columns={columns}
        rows={visible}
        selectedKeys={selected}
        onSelectionChange={setSelected}
        rowLabel={(row) => row.name}
        bulkActions={
          <Button
            variant="danger"
            size="sm"
            disabled={crawlRunning || removing}
            onClick={() => setConfirmingBulk(true)}
          >
            Remove {formatNumber(chosen.length)}
          </Button>
        }
        rowKey={(row) => row.name}
        rowNoun="source"
        caption="Websites and documents this chatbot has learned from"
        loading={loading}
        error={error}
        onRetry={onRetry}
        defaultSort={{ key: 'ingested_at', direction: 'desc' }}
        pageSize={25}
        empty={
          filtered ? (
            <EmptyState
              size="inline"
              title="No source matches"
              description="Nothing here matches that search and filter."
            />
          ) : (
            <EmptyState
              size="inline"
              title="This chatbot has nothing to answer from yet"
              description="Train it on your website, or upload a document."
            />
          )
        }
      />

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        destructive
        title="Remove this source?"
        description={
          confirming ? (
            <>
              {confirming.name} and its{' '}
              <span className="figure">{formatNumber(confirming.chunk_count ?? 0)}</span> indexed
              passage{(confirming.chunk_count ?? 0) === 1 ? '' : 's'} are deleted. This chatbot
              stops answering from it immediately, and the credits already spent on it are not
              returned.
            </>
          ) : null
        }
        confirmLabel="Remove it"
        onConfirm={async () => {
          if (!confirming) return;
          await onDelete(confirming);
          setConfirming(null);
        }}
      >
        {/* The consequence of adding it back, as the dialog's own second block.
            It used to be a second `<span className="block">` smuggled into
            `description` — one paragraph pretending to be a string — because
            `ConfirmDialog` took no children. It does now. */}
        {confirming ? (
          <p className="text-prose text-text-secondary">
            {isWebsiteSource(confirming.name)
              ? `Training it again later re-reads all ${confirmingUnits?.label ?? 'its pages'} and charges for them.`
              : 'You would need the original file to add it again.'}
          </p>
        ) : null}
      </ConfirmDialog>

      {/* One confirmation for the whole selection. A customer who crawled a site
          and wants nine of its documents gone did it nine times, each behind its
          own dialog. The count and the passages it takes with it are both named,
          because that is the consequence — not "9 items". */}
      <ConfirmDialog
        open={confirmingBulk}
        onOpenChange={(open) => {
          if (!open) setConfirmingBulk(false);
        }}
        destructive
        title={`Remove ${formatNumber(chosen.length)} source${chosen.length === 1 ? '' : 's'}?`}
        description={`This deletes ${formatNumber(chosenPassages)} indexed passage${chosenPassages === 1 ? '' : 's'}. The chatbot stops answering from them immediately, and the credits already spent on them are not returned.`}
        confirmLabel={`Remove ${formatNumber(chosen.length)}`}
        onConfirm={async () => {
          setRemoving(true);
          try {
            // Sequential, not parallel: each removal is a separate write on the
            // same chatbot, and firing nine at once is how a partial failure
            // becomes an unreadable one.
            for (const source of chosen) await onDelete(source);
            setSelected(new Set());
            setConfirmingBulk(false);
          } finally {
            setRemoving(false);
          }
        }}
      />
    </>
  );
}
