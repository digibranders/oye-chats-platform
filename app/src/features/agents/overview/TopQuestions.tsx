import { MessageSquare } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  EmptyState,
  LoadingRows,
  formatNumber,
} from '../../../ui';
import type { TopQuestion } from '../../../types/domain';
import type { Section } from './overview-data';

/**
 * What visitors ask most.
 *
 * A ranked list rather than a chart: the question text is the content, and a bar
 * chart of eight long strings spends its whole width on labels. The bar behind
 * each row is a proportion, not the reading — the count beside it is.
 *
 * `/analytics/top-questions` takes no window parameter, so this is all-time and
 * says so. Trimming it client-side is not possible here: the endpoint returns
 * questions already aggregated, with no dates to trim by.
 */
export function TopQuestions({ section }: { section: Section<TopQuestion[]> }) {
  const questions = section.data;
  const max = questions[0]?.count || 1;

  if (section.loading) {
    return (
      <Card>
        <CardBody>
          <LoadingRows rows={4} />
        </CardBody>
      </Card>
    );
  }

  if (section.error) {
    return (
      <Card>
        <CardBody>
          <Alert
            tone="danger"
            title="We could not load the top questions"
            action={
              <Button size="sm" onClick={section.retry}>
                Try again
              </Button>
            }
          >
            {section.error}
          </Alert>
        </CardBody>
      </Card>
    );
  }

  if (questions.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={MessageSquare}
          title="No questions yet"
          description="Once visitors have asked this chatbot a few things, the most common ones are listed here."
        />
      </Card>
    );
  }

  return (
    <Card>
      <ol>
        {questions.map((item, index) => (
          <li
            key={`${item.question}-${index}`}
            className="flex items-center gap-4 border-t border-border px-5 py-3 first:border-t-0"
          >
            <span aria-hidden className="figure w-5 shrink-0 text-xs text-text-tertiary">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-text-primary">{item.question}</span>
              <span aria-hidden className="mt-1.5 block h-1 rounded-xs bg-surface-sunken">
                <span
                  className="block h-1 rounded-xs bg-accent-500"
                  style={{ width: `${Math.max((item.count / max) * 100, 4)}%` }}
                />
              </span>
            </span>
            <span className="figure shrink-0 text-sm text-text-secondary">
              {formatNumber(item.count)}
              <span className="ml-1 text-text-tertiary">{item.count === 1 ? 'ask' : 'asks'}</span>
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
