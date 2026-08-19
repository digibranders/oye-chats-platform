import { Download, MessageSquare } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingRows,
  formatNumber,
} from '../../ui';
import { csvFilename, exportRows } from './exportCsv';
import { errorMessage, useTopQuestions } from './useAnalyticsData';

/**
 * What visitors ask most.
 *
 * `/analytics/top-questions` takes no date filter, so this is all time and says
 * so. It is the one panel here whose period the page's range cannot move, and
 * pretending otherwise would put a range label on a figure that ignores it.
 */
export function TopQuestionsPanel({ botId }: { botId: number | null }) {
  const { questions, loading, error, refetch } = useTopQuestions(botId);
  const max = questions.reduce((peak, question) => Math.max(peak, question.count), 0);

  function onExport() {
    exportRows(
      csvFilename('top-questions', 'all time'),
      ['Question', 'Times asked'],
      questions.map((question) => [question.question, question.count]),
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Demand"
        title="What visitors ask most"
        titleAs="h2"
        description="The questions your chatbot answers most often · all time"
        actions={
          questions.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={onExport}
              iconLeft={<Download aria-hidden className="h-3.5 w-3.5" />}
            >
              Export
            </Button>
          ) : undefined
        }
      />
      {loading ? (
        <CardBody>
          <LoadingRows rows={5} />
        </CardBody>
      ) : error ? (
        <ErrorState
          compact
          title="Questions could not be loaded"
          description={errorMessage(error, 'The request for your top questions failed.')}
          onRetry={() => void refetch()}
        />
      ) : questions.length === 0 ? (
        <EmptyState
          compact
          icon={MessageSquare}
          title="No questions yet"
          description="Once visitors start chatting, the questions they repeat will collect here."
        />
      ) : (
        <ol className="px-5 py-2">
          {questions.map((question, index) => (
            <li
              key={`${question.question}-${index}`}
              className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0"
            >
              <span className="figure w-6 shrink-0 text-xs text-text-tertiary">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">{question.question}</p>
                <span
                  aria-hidden
                  className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-sunken"
                >
                  <span
                    className="block h-full rounded-full bg-accent-500"
                    style={{ width: `${max > 0 ? Math.max(4, (question.count / max) * 100) : 0}%` }}
                  />
                </span>
              </div>
              <span className="figure w-16 shrink-0 text-right text-sm text-text-primary">
                {formatNumber(question.count)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
