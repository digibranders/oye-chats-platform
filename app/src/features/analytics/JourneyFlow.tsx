import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EYEBROW_CLASS,
  EmptyState,
  ErrorState,
  FigureList,
  FigureRow,
  Grid,
  LoadingRows,
  StatTile,
  Tooltip,
  cn,
  formatNumber,
  formatPercent,
} from '../../ui';
import type {
  JourneyConversionPathsResponse,
  JourneyPostChatResponse,
  JourneyPreChatSequencesResponse,
  JourneySummary,
} from '../../services/api';
import {
  filterEmptyDescription,
  isFilterableOutcome,
  type FilterableOutcome,
  type JourneyOutcome,
} from './journeyModel';

/**
 * How visitors moved: before the chat, the chat, and after it.
 *
 * This replaces a 2,011-line SVG. That diagram put its nodes in `foreignObject`
 * divs carrying `onClick` and neither `role` nor `tabIndex`, so the entire
 * filter-by-clicking interaction — the only interaction it had — was
 * unreachable without a mouse. It also instantiated the whole diagram a second
 * time whenever the expand modal was open, and its wheel-zoom canvas swallowed
 * the scroll wheel in the middle of a scrolling page.
 *
 * What was cut, deliberately: the pan-and-zoom canvas, the expand modal, the
 * per-node hover cards, the start-page filter, and the "page flows shown"
 * control that pruned rows already fetched. What was kept: every fact. The
 * routes visitors took before opening chat, how many took each, what they did
 * afterwards, and the ability to see only the routes behind one outcome — now
 * as three ordinary columns of ordinary controls, which a keyboard can walk.
 */

/** Rows revealed at a time. Enough to see a pattern, short enough to scan. */
const PAGE_STEP = 6;

interface RouteRow {
  key: string;
  pages: string[];
  sessions: number;
  /** Share of the routes in view, 0 to 1, or null when there is no denominator. */
  share: number | null;
}

/**
 * The route a visitor took, as one line.
 *
 * The segments used to `break-all`, so a UTM-tagged path in a narrow column
 * rendered as five or six lines of mid-word breaks. They truncate now, and the
 * whole route is on the row's tooltip — which is also where a reader who needs
 * the full string can actually read it.
 */
function PathTrail({ pages }: { pages: readonly string[] }) {
  if (pages.length === 0) return <span className="text-xs text-text-tertiary">Direct</span>;
  return (
    <Tooltip content={pages.join(' → ')}>
      <span className="flex min-w-0 items-center gap-1">
        {pages.map((page, index) => (
          <span key={`${page}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <ArrowRight aria-hidden className="h-3 w-3 shrink-0 text-text-tertiary" />
            ) : null}
            <span className="figure min-w-0 truncate text-xs text-text-primary">{page}</span>
          </span>
        ))}
      </span>
    </Tooltip>
  );
}

export interface JourneyFlowProps {
  summary: JourneySummary;
  outcomes: readonly JourneyOutcome[];
  sequences: JourneyPreChatSequencesResponse;
  postChat: JourneyPostChatResponse;
  monthLabel: string;
  selectedOutcome: FilterableOutcome | null;
  onSelectOutcome: (outcome: FilterableOutcome | null) => void;
  paths: JourneyConversionPathsResponse | null;
  pathsLoading: boolean;
  pathsError: string | null;
}

export function JourneyFlow({
  summary,
  outcomes,
  sequences,
  postChat,
  monthLabel,
  selectedOutcome,
  onSelectOutcome,
  paths,
  pathsLoading,
  pathsError,
}: JourneyFlowProps) {
  const [visible, setVisible] = useState(PAGE_STEP);

  const rows = useMemo<RouteRow[]>(() => {
    if (selectedOutcome) {
      const denominator = paths?.total_conversions ?? 0;
      return (paths?.paths ?? []).map((path, index) => ({
        key: `${path.sequence.join('>')}-${index}`,
        pages: path.sequence,
        sessions: path.sessions,
        share: denominator > 0 ? path.sessions / denominator : null,
      }));
    }
    const denominator = sequences.sessions_with_pre_chat;
    return sequences.sequences.map((entry, index) => ({
      key: `${entry.sequence.join('>')}-${index}`,
      pages: entry.sequence,
      sessions: entry.sessions,
      share: denominator > 0 ? entry.sessions / denominator : null,
    }));
  }, [selectedOutcome, paths, sequences]);

  const shown = rows.slice(0, visible);
  const outcomeLabelFor = (id: FilterableOutcome) =>
    outcomes.find((outcome) => outcome.id === id)?.label ?? id;

  return (
    <Card>
      <CardHeader
        eyebrow="Flow"
        title="How visitors moved"
        titleAs="h2"
        description={`Where people were before they opened the chat, and what happened afterwards · ${monthLabel}`}
      />
      {/* Three peers, on the system's ramp — not a hand-written
          `lg:grid-cols-[1.4fr_0.8fr_1fr]`, which measured the viewport and
          weighted three sections that carry the same altitude. */}
      <CardBody>
        <Grid cols={3} gap="section" align="start">
          {/* Before the chat */}
          <section aria-labelledby="journey-before">
            <h3 id="journey-before" className="text-base font-semibold text-text-primary">
              Before the chat
            </h3>
            <p aria-live="polite" className="mt-1 text-xs text-text-secondary">
              {selectedOutcome ? (
                <>
                  <span className="figure">{formatNumber(rows.length)}</span>{' '}
                  {rows.length === 1 ? 'route' : 'routes'} attributed to{' '}
                  {outcomeLabelFor(selectedOutcome).toLowerCase()}
                </>
              ) : (
                <>
                  <span className="figure">{formatNumber(sequences.sessions_with_pre_chat)}</span> of{' '}
                  <span className="figure">{formatNumber(sequences.total_sessions)}</span>{' '}
                  conversations were browsing first
                </>
              )}
            </p>

            {selectedOutcome ? (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => {
                  onSelectOutcome(null);
                  setVisible(PAGE_STEP);
                }}
              >
                Clear filter
              </Button>
            ) : null}

            <div className="mt-3">
              {pathsLoading && selectedOutcome ? (
                <LoadingRows rows={4} />
              ) : pathsError && selectedOutcome ? (
                <ErrorState
                  size="inline"
                  polite
                  title="These routes could not be loaded"
                  description={pathsError}
                />
              ) : shown.length === 0 ? (
                <EmptyState
                  size="inline"
                  title="No routes to show"
                  description={filterEmptyDescription({
                    outcome: selectedOutcome,
                    startPage: null,
                    hasTrackedJourneys: sequences.sessions_with_pre_chat > 0,
                  })}
                />
              ) : (
                <>
                  <ol className="space-y-2.5">
                    {shown.map((row) => (
                      <li key={row.key} className="border-t border-border pt-2.5 first:border-t-0 first:pt-0">
                        <PathTrail pages={row.pages} />
                        <p className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
                          <span className="figure text-text-primary">
                            {formatNumber(row.sessions)}
                          </span>
                          {row.sessions === 1 ? 'conversation' : 'conversations'}
                          {row.share !== null ? (
                            <span className="figure text-text-tertiary">
                              {formatPercent(row.share)}
                            </span>
                          ) : null}
                        </p>
                      </li>
                    ))}
                  </ol>
                  {rows.length > shown.length ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-3"
                      onClick={() => setVisible((count) => count + PAGE_STEP)}
                    >
                      Show {Math.min(PAGE_STEP, rows.length - shown.length)} more{' '}
                      <span className="figure text-text-tertiary">
                        ({formatNumber(shown.length)} of {formatNumber(rows.length)})
                      </span>
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </section>

          {/* The chat itself */}
          <section aria-labelledby="journey-chat">
            <h3 id="journey-chat" className="text-base font-semibold text-text-primary">
              The chat
            </h3>
            {/* A `StatTile` and a `FigureRow`, not a bordered well with a
                hand-set 20px figure and a decorative glyph inside it. */}
            <div className="mt-3">
              <StatTile
                size="lg"
                label={summary.sessions_with_journey === 1 ? 'Tracked journey' : 'Tracked journeys'}
                value={formatNumber(summary.sessions_with_journey)}
                period={monthLabel}
              />
              <FigureList className="mt-2">
                <FigureRow
                  label="Left their details"
                  value={formatNumber(summary.leads_captured)}
                />
              </FigureList>
            </div>
          </section>

          {/* After the chat */}
          <section aria-labelledby="journey-after">
            <h3 id="journey-after" className="text-base font-semibold text-text-primary">
              After the chat
            </h3>
            <p className="mt-1 text-xs text-text-secondary">
              Select an outcome to see only the routes behind it.
            </p>
            <ul className="mt-3 space-y-1.5">
              {outcomes.map((outcome) => {
                const id = outcome.id;
                const selected = id === selectedOutcome;
                const figure = (
                  <>
                    <span className="min-w-0 flex-1 truncate text-left text-sm text-text-primary">
                      {outcome.label}
                    </span>
                    <span className="figure shrink-0 text-sm text-text-primary">
                      {formatNumber(outcome.sessions)}
                    </span>
                    {outcome.share !== null ? (
                      <span className="figure w-12 shrink-0 text-right text-xs text-text-tertiary">
                        {formatPercent(outcome.share)}
                      </span>
                    ) : null}
                  </>
                );

                // `isFilterableOutcome` is a type guard, so past this branch the
                // click handler below cannot be handed a bucket the paths
                // endpoint has no attribution for — drop-off has none, and the
                // model deliberately makes that unrepresentable.
                if (!outcome.filterable || !isFilterableOutcome(id)) {
                  return (
                    <li key={id} className="rounded-md border border-border-strong px-3 py-2">
                      <span className="flex min-h-6 items-center gap-2">{figure}</span>
                      {/* Written out rather than hidden in a tooltip: how this
                          number is arrived at, and why it cannot be opened as a
                          filter, is exactly the sort of fact a reader needs
                          before they plan against it. */}
                      {outcome.note ? (
                        <span className="mt-1 block text-2xs leading-snug text-text-tertiary">
                          {outcome.note}
                        </span>
                      ) : null}
                    </li>
                  );
                }

                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        onSelectOutcome(selected ? null : id);
                        setVisible(PAGE_STEP);
                      }}
                      className={cn(
                        'flex min-h-6 w-full items-center gap-2 rounded-md border px-3 py-2',
                        'transition-colors duration-[var(--dur-fast)]',
                        selected
                          ? 'border-accent-500 bg-accent-50'
                          : 'border-border-strong hover:bg-surface-hover',
                      )}
                    >
                      {figure}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Still a heading, so the column stays navigable by heading — but at
                the eyebrow's own treatment rather than a 12px semibold rung the
                type scale does not have. */}
            <h4 className={cn(EYEBROW_CLASS, 'mt-5')}>Where they went next</h4>
            {postChat.first_hops.length === 0 ? (
              <p className="mt-1 text-xs text-text-secondary">
                Nobody was seen on another page after closing the chat in this month.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {postChat.first_hops.slice(0, 5).map((hop) => (
                  <li key={hop.path} className="flex items-center gap-2">
                    <span className="figure min-w-0 flex-1 truncate text-xs text-text-secondary">
                      {hop.path}
                    </span>
                    <Badge>{formatNumber(hop.sessions)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Grid>
      </CardBody>
    </Card>
  );
}
