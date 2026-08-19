import { describe, expect, it } from 'vitest';
import { deriveInsights, type InsightInput } from './insight';

/**
 * The section this replaces had exactly one branch that could fire: a
 * hard-coded congratulation whenever a workspace held at least one
 * ready-to-buy lead. It never warned, never flagged a fall, and rendered an
 * empty div for everyone else — including every workspace that had just lost
 * half its traffic.
 *
 * So what is under test is mostly restraint: when a comparison is too small to
 * mean anything, nothing is said.
 */

function input(over: Partial<InsightInput> = {}): InsightInput {
  return {
    rangeLabel: 'Last 30 days',
    comparisonLabel: 'the previous 30 days',
    conversations: 100,
    previousConversations: 100,
    unansweredCount: 0,
    topUnanswered: null,
    ...over,
  };
}

describe('deriveInsights. Conversation trend', () => {
  it('warns on a material fall against the previous window', () => {
    const [insight] = deriveInsights(input({ conversations: 60, previousConversations: 100 }));
    expect(insight.tone).toBe('warning');
    expect(insight.title).toContain('down 40%');
    expect(insight.title).toContain('the previous 30 days');
  });

  it('says so on a material rise', () => {
    const [insight] = deriveInsights(input({ conversations: 150, previousConversations: 100 }));
    expect(insight.tone).toBe('success');
    expect(insight.title).toContain('up 50%');
  });

  it('stays quiet on a small move', () => {
    expect(deriveInsights(input({ conversations: 105, previousConversations: 100 }))).toEqual([]);
  });

  it('stays quiet when the sample is too small to mean anything', () => {
    // Two conversations becoming four is not a doubling, it is a quiet
    // fortnight. Firing here is how an insight section becomes noise.
    expect(deriveInsights(input({ conversations: 4, previousConversations: 2 }))).toEqual([]);
  });

  it('stays quiet on a range with nothing before it', () => {
    expect(
      deriveInsights(
        input({ comparisonLabel: null, conversations: 500, previousConversations: null }),
      ),
    ).toEqual([]);
  });
});

describe('deriveInsights. Knowledge gaps', () => {
  it('names the most-asked gap and offers the way to fix it', () => {
    const insights = deriveInsights(
      input({
        unansweredCount: 12,
        topUnanswered: { question: 'Do you integrate with Salesforce?', count: 9 },
        knowledgeTo: '/chatbots/7/knowledge',
      }),
    );
    const gap = insights.find((insight) => insight.id === 'knowledge-gap');
    expect(gap?.title).toContain('12 questions went unanswered');
    expect(gap?.body).toContain('Salesforce');
    expect(gap?.action).toEqual({ label: 'Add knowledge', to: '/chatbots/7/knowledge' });
  });

  it('ignores a one-off question nobody repeated', () => {
    expect(
      deriveInsights(
        input({ unansweredCount: 1, topUnanswered: { question: 'anything?', count: 1 } }),
      ),
    ).toEqual([]);
  });

  it('omits the action when no chatbot is in scope', () => {
    const [gap] = deriveInsights(
      input({ unansweredCount: 4, topUnanswered: { question: 'pricing?', count: 5 } }),
    );
    expect(gap.action).toBeUndefined();
  });
});
