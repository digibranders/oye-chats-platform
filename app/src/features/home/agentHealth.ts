import type { Bot } from '../../types/domain';

export type HealthState = 'untrained' | 'training' | 'broken' | 'stale' | 'ready' | 'live';

export interface AgentHealth {
  state: HealthState;
  /** One line, in the user's terms. */
  label: string;
  /** Why it matters, for a surface with room to say so. */
  detail: string;
  /** What to do about it, when there is something to do. */
  action?: { label: string; segment: string };
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  /** True when Home should name this chatbot under "needs attention". */
  needsAttention: boolean;
}

/**
 * One definition of whether a chatbot is healthy.
 *
 * The app this replaces had three, in three files, with three different
 * vocabularies — "Not trained yet" / "Needs training" / "Your AI needs
 * knowledge" — that disagreed on their inputs, so the same chatbot could read
 * "Live" on Home and "needs knowledge" on its own Overview. This is the only
 * one, and every surface reads it.
 *
 * **`indexed_chunk_count` is what the chatbot currently knows.
 * `last_crawl_status` only describes the last training attempt.** Those are
 * different questions and the order matters: checking the attempt first made a
 * single failed recrawl render a chatbot holding thousands of passages as
 * broken, which is a bug this codebase has already shipped once. A chatbot with
 * knowledge and a failed refresh is working — on slightly old information —
 * and that is what it should say.
 */
export function agentHealth(bot: Bot): AgentHealth {
  const indexed = Number(bot.indexed_chunk_count ?? 0);
  const status = bot.last_crawl_status ?? null;
  const crawlFailed = status === 'failed' || status === 'error';
  const crawling = status === 'running' || status === 'in_progress' || status === 'pending';

  if (crawling && indexed === 0) {
    return {
      state: 'training',
      label: 'Training',
      detail: 'It is reading your site now. This usually takes a few minutes.',
      tone: 'neutral',
      needsAttention: false,
    };
  }

  if (indexed === 0) {
    return crawlFailed
      ? {
          state: 'broken',
          label: 'Training failed',
          detail:
            'It could not read your site, so it has nothing to answer from. Try a different page, or upload documents instead.',
          action: { label: 'Fix training', segment: 'knowledge' },
          tone: 'danger',
          needsAttention: true,
        }
      : {
          state: 'untrained',
          label: 'Nothing to answer from',
          detail: 'Until it has something to read, it will tell visitors it does not know.',
          action: { label: 'Add knowledge', segment: 'knowledge' },
          tone: 'warning',
          needsAttention: true,
        };
  }

  // It knows things. From here the failure modes are about freshness and reach,
  // not about whether it works at all.
  if (crawlFailed) {
    return {
      state: 'stale',
      label: 'Answers may be out of date',
      detail:
        'It is still answering, but the last attempt to refresh its knowledge did not finish.',
      action: { label: 'Retry training', segment: 'knowledge' },
      tone: 'warning',
      needsAttention: true,
    };
  }

  if (!bot.widget_installed_at) {
    return {
      state: 'ready',
      label: 'Ready, not installed',
      detail: 'It is trained and waiting. Visitors will not see it until the script is on your site.',
      action: { label: 'Install it', segment: 'deploy' },
      tone: 'warning',
      needsAttention: true,
    };
  }

  return {
    state: 'live',
    label: 'Live',
    detail: 'Trained, installed and answering visitors.',
    tone: 'success',
    needsAttention: false,
  };
}
