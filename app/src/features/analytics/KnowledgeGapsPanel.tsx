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
  formatRelative,
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
  const now = new Date();

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
    {
      key: 'last_asked',
      header: 'Last asked',
      align: 'right',
      width: '11rem',
      secondary: true,
      render: (row) => (
        <span className="text-text-secondary">{formatRelative(row.last_asked, now)}</span>
      ),
      sortable: (a, b) =>
        new Date(a.last_asked ?? 0).getTime() - new Date(b.last_asked ?? 0).getTime(),
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
        description={`Questions the chatbot had nothing to answer from · ${range.label.toLowerCase()}`}
        actions={
          <>
            {questions.length > 0 ? (
              <Button size="sm" variant="secondary" onClick={onExport} iconLeft={<Download aria-hidden />}>
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
