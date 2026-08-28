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
import { useTranslation } from '../../i18n/useTranslation';

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
  const { t } = useTranslation();
  const { questions, loading, error, refetch } = useUnansweredQuestions(botId, range.days);
  const now = new Date();

  // `Column.secondary` is a container query now, so "Last asked" is back: this
  // panel is one half of a two-up `Grid` and its card is about 550px, which is
  // under the 768px step, so the column drops itself there and the table stays
  // inside the card. It returns when the panel is given the room — a narrow
  // window, or a future single-column arrangement. `fit` is what keeps the two
  // remaining columns honest at 550: the default lets the table be wider than
  // its box behind a scroll affordance under 44px rows that nobody finds.
  const columns: readonly Column<UnansweredQuestion>[] = [
    {
      key: 'question',
      header: t('analytics.question') || 'Question',
      render: (row) => <span className="text-text-primary">{row.question}</span>,
      sortable: (a, b) => a.question.localeCompare(b.question),
    },
    {
      key: 'count',
      header: t('analytics.timesAsked') || 'Times asked',
      align: 'right',
      width: '9rem',
      render: (row) => <span className="figure">{formatNumber(row.count)}</span>,
      sortable: (a, b) => a.count - b.count,
    },
    {
      key: 'last_asked',
      header: t('analytics.lastAsked') || 'Last asked',
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
      [t('analytics.question') || 'Question', t('analytics.timesAsked') || 'Times asked', t('analytics.lastAsked') || 'Last asked'],
      questions.map((question) => [question.question, question.count, question.last_asked ?? '']),
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Knowledge gaps"
        title={t('analytics.whatItCouldNotAnswer') || 'What it could not answer'}
        titleAs="h2"
        // Short enough to leave the header's action slot on the same line.
        // With the window appended, the description and the two buttons came
        // to 548px in a 512px header, so `CardHeader` wrapped the actions onto
        // their own row at the *left* — while the identical Export on the panel
        // beside it sat top-right. The window is on the page's period control.
        description={t('analytics.questionsTheChatbotHadNothing') || 'Questions the chatbot had nothing to answer from'}
        actions={
          <>
            {questions.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={onExport} iconLeft={<Download aria-hidden />}>
                {t('analytics.export') || 'Export'}
              </Button>
            ) : null}
            {botId != null ? (
              <Link to={agentPath(botId, 'knowledge')} className={buttonClass('secondary', 'sm')}>
                {t('analytics.addKnowledge') || 'Add knowledge'}
              </Link>
            ) : null}
          </>
        }
      />
      <CardBody flush>
        <DataTable
          seated
          fit
          caption={t('analytics.questionsTheChatbotCouldNot') || 'Questions the chatbot could not answer in the selected period'}
          columns={columns}
          rows={questions}
          rowKey={(row) => row.question}
          loading={loading}
          error={error ? errorMessage(error, t('analytics.theRequestForKnowledgeGaps') || 'The request for knowledge gaps failed.') : null}
          onRetry={() => void refetch()}
          defaultSort={{ key: 'count', direction: 'desc' }}
          pageSize={10}
          rowNoun="question"
          empty={
            <EmptyState
              size="inline"
              icon={HelpCircle}
              title={t('analytics.nothingWentUnanswered') || 'Nothing went unanswered'}
              description={`Every question asked in ${range.label.toLowerCase()} was answered from what the chatbot already knows.`}
            />
          }
        />
      </CardBody>
    </Card>
  );
}
