import { Download, HelpCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  buttonClass,
  formatNumber,
  type Column,
} from '../../ui';
import { agentPath } from '../../shell/nav';
import type { UnansweredQuestion } from '../../types/domain';
import { csvFilename, exportRows } from './exportCsv';
import { errorMessage, useUnansweredQuestions } from './useAnalyticsData';
import type { ResolvedRange } from './range';

/**
 * Questions the chatbot could not answer, inside the selected window.
 *
 * `/analytics/unanswered-questions` has accepted `?days=` from the start and
 * nothing in the product ever passed it, so this list was all-time everywhere
 * it appeared: a gap fixed in March still counted against you in August. It
 * takes the page's range now, which is what makes it actionable — the question
 * is not "what has ever gone unanswered" but "what is going unanswered lately".
 */
export function KnowledgeGapsPanel({
  botId,
  range,
}: {
  botId: number | null;
  range: ResolvedRange;
}) {
  const { questions, loading, error, refetch } = useUnansweredQuestions(botId, range.days);

  // Two columns, not three. This panel is one half of a two-up `Grid`, so its
  // card is about 550px; `Question` plus a 9rem count plus an 11rem "Last
  // asked" made the table 641px wide inside it, and `DataTable`'s own
  // `overflow-auto` quietly clipped the last column at the card's right edge.
  // `Column.secondary` is `hidden md:table-cell` — a *viewport* query — so it
  // stayed visible in a 550px container on a 1440px screen. The window is
  // already stated in the header, and the timestamp is still in the CSV.
  const columns: readonly Column<UnansweredQuestion>[] = [
    {
      key: 'question',
      header: 'Question',
      render: (row) => <span className="text-text-primary">{row.question}</span>,
      sortable: (a, b) => a.question.localeCompare(b.question),
    },
    {
      key: 'count',
      header: 'Times asked',
      align: 'right',
      width: '9rem',
      render: (row) => <span className="figure">{formatNumber(row.count)}</span>,
      sortable: (a, b) => a.count - b.count,
    },
  ];

  function onExport() {
    exportRows(
      csvFilename('unanswered-questions', range.label),
      ['Question', 'Times asked', 'Last asked'],
      questions.map((question) => [question.question, question.count, question.last_asked ?? '']),
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Knowledge gaps"
        title="What it could not answer"
        titleAs="h2"
        // Short enough to leave the header's action slot on the same line.
        // With the window appended, the description and the two buttons came
        // to 548px in a 512px header, so `CardHeader` wrapped the actions onto
        // their own row at the *left* — while the identical Export on the panel
        // beside it sat top-right. The window is on the page's period control.
        description="Questions the chatbot had nothing to answer from"
        actions={
          <>
            {questions.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={onExport} iconLeft={<Download aria-hidden />}>
                Export
              </Button>
            ) : null}
            {botId != null ? (
              <Link to={agentPath(botId, 'knowledge')} className={buttonClass('secondary', 'sm')}>
                Add knowledge
              </Link>
            ) : null}
          </>
        }
      />
      <CardBody flush>
        <DataTable
          seated
          caption="Questions the chatbot could not answer in the selected period"
          columns={columns}
          rows={questions}
          rowKey={(row) => row.question}
          loading={loading}
          error={error ? errorMessage(error, 'The request for knowledge gaps failed.') : null}
          onRetry={() => void refetch()}
          defaultSort={{ key: 'count', direction: 'desc' }}
          pageSize={10}
          rowNoun="question"
          empty={
            <EmptyState
              size="inline"
              icon={HelpCircle}
              title="Nothing went unanswered"
              description={`Every question asked in ${range.label.toLowerCase()} was answered from what the chatbot already knows.`}
            />
          }
        />
      </CardBody>
    </Card>
  );
}
