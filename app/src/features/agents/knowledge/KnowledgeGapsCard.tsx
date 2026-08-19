import { CircleCheck } from 'lucide-react';
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
        description="Each of these is a visitor who asked something and was told the chatbot did not know. Add a page or a document that covers it and the gap closes."
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
            title="Not yours to see"
            description="Your seat can read this chatbot's knowledge but not its conversation history, which is where these questions come from."
          />
        </CardBody>
      ) : (
        <DataTable
          columns={columns}
          rows={section.data}
          rowKey={(row) => row.question}
          caption={`Questions this chatbot could not answer, ${gapWindowLabel(window).toLowerCase()}`}
          error={section.error}
          onRetry={section.retry}
          defaultSort={{ key: 'count', direction: 'desc' }}
          empty={
            <EmptyState
              icon={CircleCheck}
              title={
                window === null
                  ? 'No unanswered questions on record'
                  : `Nothing went unanswered in the ${gapWindowLabel(window).toLowerCase()}`
              }
              description={
                window === null
                  ? 'When a visitor asks something this chatbot cannot answer from its knowledge, it turns up here so you know what to add.'
                  : 'Try a longer period, or take it as a good sign — this chatbot answered everything it was asked.'
              }
            />
          }
        />
      )}
      {section.data.length >= GAPS_LIMIT ? (
        <CardBody className="border-t border-border">
          <p className="text-xs text-text-secondary">
            Showing the <span className="figure">{GAPS_LIMIT}</span> most-asked. Close these first —
            they are the ones costing you the most conversations.
          </p>
        </CardBody>
      ) : null}
    </Card>
  );
}
