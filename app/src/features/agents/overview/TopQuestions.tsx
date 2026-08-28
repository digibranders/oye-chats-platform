import {
  Alert,
  Button,
  CardBody,
  RankedBars,
  formatNumber,
} from '../../../ui';
import type { TopQuestion } from '../../../types/domain';
import type { Section } from './overview-data';
import { useTranslation } from '../../../i18n/useTranslation';

/** How many questions the panel shows beside the activity chart. */
const TOP_N = 6;

/**
 * What visitors ask most.
 *
 * A ranked list rather than a chart: the question text is the content, and a bar
 * chart of eight long strings spends its whole width on labels.
 *
 * It is `RankedBars`, which DESIGN.md's addenda introduce by name for exactly
 * this surface. The version it replaces hand-drew the same row — label,
 * proportional bar, mono count — and painted the bar `bg-accent-500`, the
 * interactive blue the token file reserves for links, focus and selection, on a
 * bar nothing can click.
 *
 * `/analytics/top-questions` takes no window parameter, so this is all-time and
 * the card says so. Trimming it client-side is not possible here: the endpoint
 * returns questions already aggregated, with no dates to trim by.
 */
export function TopQuestions({ section }: { section: Section<TopQuestion[]> }) {
  const { t } = useTranslation();
  if (section.error) {
    return (
      <CardBody>
        <Alert
          tone="danger"
          title={t('agents.weCouldNotLoadThe6') || 'We could not load the top questions'}
          action={
            <Button size="sm" onClick={section.retry}>
              {t('agents.tryAgain') || 'Try again'}
            </Button>
          }
        >
          {section.error}
        </Alert>
      </CardBody>
    );
  }

  return (
    <RankedBars
      label={t('agents.mostAskedQuestionsAllTime') || 'Most asked questions, all time'}
      loading={section.loading}
      loadingRows={TOP_N}
      emptyTitle="Nothing asked yet"
      items={section.data.slice(0, TOP_N).map((item, index) => ({
        id: `${item.question}-${index}`,
        label: item.question,
        value: item.count,
        display: (
          <>
            {formatNumber(item.count)}
            <span className="ml-1 text-text-tertiary">{item.count === 1 ? 'ask' : 'asks'}</span>
          </>
        ),
      }))}
    />
  );
}
