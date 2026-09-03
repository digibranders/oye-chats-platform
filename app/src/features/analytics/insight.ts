import { delta } from './range';
import { t as translateNow } from '../../i18n/i18n';

/**
 * What changed, said in a sentence.
 *
 * The section this replaces had exactly one non-null branch — a hard-coded
 * congratulation that fired whenever a workspace had at least one ready-to-buy
 * lead. It never warned, never flagged a drop, and never fired for anything
 * else, so for most readers "Insights" was an empty div and for the rest it was
 * the same sentence every day.
 *
 * Every rule here compares this period against the one before it, which is the
 * only thing on this page that can be surprising. Nothing fires on a figure
 * standing alone, and nothing fires on a sample too small to mean anything: a
 * workspace that went from two conversations to four has not doubled, it has
 * had a quiet fortnight.
 *
 * And nothing fires on good news that the tiles above already state. Every
 * insight here has to carry something the strip cannot — an instruction, or a
 * figure that is not on it. Otherwise it is a second copy of a number, styled
 * as an interruption.
 */

export type InsightTone = 'success' | 'warning' | 'neutral';

export interface Insight {
  id: string;
  tone: InsightTone;
  title: string;
  body: string;
  /** Where to go to act on it. Rendered as a link by the caller. */
  action?: { label: string; to: string };
}

/** Below this, a period-over-period percentage is noise rather than a trend. */
const MIN_PRIOR_CONVERSATIONS = 10;

/** A move smaller than this is not worth interrupting anyone for. */
const MATERIAL_CHANGE_PERCENT = 20;

/** A gap asked this many times is a documented question, not a one-off. */
const REPEATED_GAP_COUNT = 3;

export interface InsightInput {
  /** "Last 30 days". */
  rangeLabel: string;
  /** "the previous 30 days", or `null` on a range with nothing before it. */
  comparisonLabel: string | null;
  conversations: number;
  previousConversations: number | null;
  /** Distinct questions the chatbots could not answer, inside the window. */
  unansweredCount: number;
  /**
   * `unansweredCount` is a full page of results, so it is a floor, not a total.
   *
   * The gaps list is fetched with a row limit. Once a workspace has more gaps
   * than that limit the count stops moving and reads as the limit for ever,
   * which is how "100 questions went unanswered" ended up being the same
   * sentence every day on every busy account. When the page came back full the
   * figure is stated as a minimum instead.
   */
  unansweredTruncated?: boolean;
  /** The most-asked of those, when there is one. */
  topUnanswered: { question: string; count: number } | null;
  /** Where to go and fix a knowledge gap, when an agent is in scope. */
  knowledgeTo?: string;
}

export function deriveInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = [];
  const change = delta(input.conversations, input.previousConversations);
  const prior = input.previousConversations ?? 0;

  // Falls only.
  //
  // A rise was a full-width tinted banner saying "Conversations are up 101% on
  // the previous 30 days" about 40px under a tile already reading `↑ +101% vs
  // the previous 30 days` — the same fact, in the same words, with the same
  // number, and nothing to do about it. An alert is for something that needs
  // attention; a good month does not. A fall carries an instruction the tile
  // cannot ("check the widget is still installed"), which is what earns it the
  // interruption.
  if (
    change &&
    change.direction === 'down' &&
    input.comparisonLabel &&
    prior >= MIN_PRIOR_CONVERSATIONS &&
    Math.abs(change.percent) >= MATERIAL_CHANGE_PERCENT
  ) {
    insights.push({
      id: 'conversation-trend',
      tone: 'warning',
      title:
        translateNow('analytics.conversationsAreDown', {
          percent: Math.abs(change.percent),
          period: input.comparisonLabel,
        }) || `Conversations are down ${Math.abs(change.percent)}% on ${input.comparisonLabel}`,
      body:
        translateNow('analytics.conversationsAreDownBody', {
          count: input.conversations.toLocaleString(),
          range: input.rangeLabel.toLowerCase(),
          prior: prior.toLocaleString(),
        }) ||
        `${input.conversations.toLocaleString()} in ${input.rangeLabel.toLowerCase()}, against ${prior.toLocaleString()} before it. Check that the widget is still installed on every page it was on.`,
    });
  }

  if (input.topUnanswered && input.topUnanswered.count >= REPEATED_GAP_COUNT) {
    const counted =
      (input.unansweredCount === 1
        ? translateNow('analytics.oneQuestionUnanswered', {
            count: input.unansweredCount.toLocaleString(),
          })
        : translateNow('analytics.manyQuestionsUnanswered', {
            count: input.unansweredCount.toLocaleString(),
          })) ||
      `${input.unansweredCount.toLocaleString()} ${
        input.unansweredCount === 1 ? 'question went' : 'questions went'
      } unanswered`;
    insights.push({
      id: 'knowledge-gap',
      tone: 'warning',
      title: input.unansweredTruncated
        ? translateNow('analytics.atLeastCounted', { counted }) || `At least ${counted}`
        : counted,
      body:
        translateNow('analytics.questionCameUpNTimes', {
          question: input.topUnanswered.question,
          count: input.topUnanswered.count.toLocaleString(),
          range: input.rangeLabel.toLowerCase(),
        }) ||
        `"${input.topUnanswered.question}" came up ${input.topUnanswered.count.toLocaleString()} times in ${input.rangeLabel.toLowerCase()} and the chatbot had nothing to answer from.`,
      action: input.knowledgeTo ? { label: translateNow('analytics.addKnowledge') || 'Add knowledge', to: input.knowledgeTo } : undefined,
    });
  }

  return insights;
}
