import {
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  LoadingRows,
  SegmentedControl,
  formatNumber,
  formatRelative,
  type Column,
} from '../../../ui';
import type { UnansweredQuestion } from '../../../types/domain';
import {
  GAP_WINDOWS,
  gapWindowLabel,
  gapWindowParam,
  parseGapWindow,
  type GapWindow,
} from './knowledge-model';
import { GAPS_LIMIT, type Section } from './useKnowledgeData';

export interface KnowledgeGapsCardProps {
  section: Section<UnansweredQuestion[]>;
  window: GapWindow;
  onWindowChange: (next: GapWindow) => void;
}

/**
 * What visitors asked that this chatbot could not answer.
 *
 * It sits next to the way to fix it, and it finally has a window. The endpoint
 * has always accepted `?days=` and the console never passed it, so a question
 * asked once, months ago, before the document that answers it was uploaded, sat
 * here for ever reading as an open gap — and the list that is supposed to tell
 * you what to add next was mostly things you already had.
 */
export function KnowledgeGapsCard({ section, window, onWindowChange }: KnowledgeGapsCardProps) {
  const columns: Column<UnansweredQuestion>[] = [
    {
      key: 'question',
      header: 'Question',
      sortable: (a, b) => a.question.localeCompare(b.question),
      render: (row) => <span className="block min-w-0 truncate">{row.question}</span>,
    },
    {
      key: 'count',
      header: 'Times asked',
      align: 'right',
      width: '9rem',
      sortable: (a, b) => a.count - b.count,
      render: (row) => formatNumber(row.count),
    },
    {
      key: 'last_asked',
      header: 'Last asked',
      align: 'right',
      width: '10rem',
      sortable: (a, b) => Date.parse(a.last_asked ?? '') - Date.parse(b.last_asked ?? ''),
      render: (row) => (row.last_asked ? formatRelative(row.last_asked) : '—'),
    },
  ];

  return (
    <Card>
      <CardHeader
        eyebrow={gapWindowLabel(window)}
        title="Questions it could not answer"
        titleAs="h2"
        description="Add a page or document that covers one and the gap closes."
        actions={
          <SegmentedControl<string>
            label="Period for knowledge gaps"
            size="sm"
            value={gapWindowParam(window)}
            onChange={(value) => onWindowChange(parseGapWindow(value))}
            items={GAP_WINDOWS.map((option) => ({
              value: gapWindowParam(option),
              label: option === null ? 'All' : `${option}d`,
            }))}
          />
        }
      />

      {section.loading ? (
        <CardBody>
          <LoadingRows rows={4} />
        </CardBody>
      ) : section.forbidden ? (
        <CardBody>
          <EmptyState
            size="panel"
            title="Not yours to see"
            description="Your seat cannot read this chatbot's conversations."
          />
        </CardBody>
      ) : (
        // Seated, in a flush body: a `DataTable` placed directly inside a `Card`
        // draws its own `rounded-lg` border concentric with the card's, 0px
        // apart — a doubled hairline and a visible doubled arc at every corner.
        <CardBody flush>
          <DataTable
            seated
            // `fit`: this card is the `main` half of a `Columns` split, so it is
            // about 720px at 1440 and 560 at 1280. The default lets the table be
            // wider than its box and scroll, which clips "Last asked" at the
            // card's edge; `fit` ellipsises the question instead, which is what
            // the `truncate` in its own `render` was already asking for.
            fit
            columns={columns}
            rows={section.data}
            rowKey={(row) => row.question}
            rowNoun="question"
            caption={`Questions this chatbot could not answer, ${gapWindowLabel(window).toLowerCase()}`}
            error={section.error}
            onRetry={section.retry}
            defaultSort={{ key: 'count', direction: 'desc' }}
            // The cap is the table's own row count to state: "1–20 of 20" in the
            // pager replaces a hand-written aside under a doubled hairline.
            pageSize={GAPS_LIMIT}
            empty={
              // `inline`: this is a table body with no rows, not a poster. At
              // the default `page` size it drew a 48px disc and an 18px title
              // inside a seated table and made an empty card 340px tall.
              <EmptyState
                size="inline"
                title={
                  window === null
                    ? 'No unanswered questions on record'
                    : `Nothing went unanswered in the ${gapWindowLabel(window).toLowerCase()}`
                }
                description={
                  window === null
                    ? 'Questions it cannot answer turn up here.'
                    : 'Try a longer period.'
                }
              />
            }
          />
        </CardBody>
      )}
    </Card>
  );
}
