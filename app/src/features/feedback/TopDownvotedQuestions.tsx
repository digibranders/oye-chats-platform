import { RankedBars, formatNumber, formatRelative } from '../../ui';
import { type TopDownvotedItem } from './feedback-helpers';

export interface TopDownvotedQuestionsProps {
  items: readonly TopDownvotedItem[];
  /** The currently selected question, if the list below is showing one. */
  selected?: string | null;
  /** Called with the question text when a row is activated (click-to-jump). */
  onSelect: (question: string) => void;
}

/**
 * The questions the chatbot keeps getting wrong.
 *
 * `RankedBars`, not a hand-drawn bar list: these are peers competing for the
 * same attention, not one quantity against a ceiling, so `Progress` and `Meter`
 * semantics would both be lies. The primitive states every count in text, which
 * is what makes the ranking survive being printed or read aloud — the version
 * this replaces drew the same shape by hand at its own height, one of three
 * such copies in the app.
 *
 * Each row is a real button that selects the question in the list below, and
 * says so via `aria-pressed`.
 */
export function TopDownvotedQuestions({
  items,
  selected = null,
  onSelect,
}: TopDownvotedQuestionsProps) {
  return (
    <RankedBars
      label="Most frequently unhelpful questions"
      tone="danger"
      items={items.map((item) => ({
        id: item.question,
        label: item.question,
        value: item.count,
        display: formatNumber(item.count),
        meta: `Last rated unhelpful ${formatRelative(item.lastAt)}`,
        selected: selected === item.question,
        onSelect: () => onSelect(item.question),
      }))}
    />
  );
}
