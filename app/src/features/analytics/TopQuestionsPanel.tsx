import { Download, MessageSquare } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  RankedBars,
  formatNumber,
} from '../../ui';
import { csvFilename, exportRows } from './exportCsv';
import { errorMessage, useTopQuestions } from './useAnalyticsData';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * What visitors ask most.
 *
 * `/analytics/top-questions` takes no date filter, so this is all time and says
 * so. It is the one panel here whose period the page's range cannot move, and
 * pretending otherwise would put a range label on a figure that ignores it.
 *
 * `RankedBars`, like the funnel beside it and the ratings distribution under
 * it: three panels drew this shape by hand at three bar heights and three
 * fills, two of them on the same page.
 */
export function TopQuestionsPanel({ botId }: { botId: number | null }) {
  const { t } = useTranslation();
  const { questions, loading, error, refetch } = useTopQuestions(botId);

  function onExport() {
    exportRows(
      csvFilename('top-questions', 'all time'),
      [t('analytics.question') || 'Question', t('analytics.timesAsked') || 'Times asked'],
      questions.map((question) => [question.question, question.count]),
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Demand"
        title={t('analytics.whatVisitorsAskMost') || 'What visitors ask most'}
        titleAs="h2"
        description={t('analytics.theQuestionsYourChatbotAnswers') || 'The questions your chatbot answers most often · all time'}
        actions={
          questions.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={onExport} iconLeft={<Download aria-hidden />}>
              {t('analytics.export') || 'Export'}
            </Button>
          ) : undefined
        }
      />
      {error ? (
        <ErrorState
          size="panel"
          polite
          title={t('analytics.questionsCouldNotBeLoaded') || 'Questions could not be loaded'}
          description={errorMessage(error, t('analytics.theRequestForYourTop') || 'The request for your top questions failed.')}
          onRetry={() => void refetch()}
        />
      ) : !loading && questions.length === 0 ? (
        <EmptyState
          size="panel"
          icon={MessageSquare}
          title={t('analytics.noQuestionsYet') || 'No questions yet'}
          description={t('analytics.onceVisitorsStartChattingThe') || 'Once visitors start chatting, the questions they repeat will collect here.'}
        />
      ) : (
        <CardBody flush>
          <RankedBars
            label={t('analytics.mostAskedQuestions') || 'Most asked questions'}
            loading={loading}
            items={questions.map((question, index) => ({
              id: `${index}-${question.question}`,
              label: question.question,
              value: question.count,
              display: formatNumber(question.count),
            }))}
          />
        </CardBody>
      )}
    </Card>
  );
}
