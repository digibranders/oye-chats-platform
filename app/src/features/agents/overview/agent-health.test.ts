import { describe, expect, it } from 'vitest';
import { deriveAgentHealth } from './agent-health';
import { type Bot } from '../../../types/domain';

/**
 * The reported bug: an agent trained on a real website showed "Nothing learned
 * yet" on Overview while its Knowledge tab listed the source as Ready. These
 * tests pin the rule that produced it - what the agent CURRENTLY knows
 * (`indexed_chunk_count`) decides whether it is trained; `last_crawl_status`
 * only describes the most recent training ATTEMPT.
 */

function bot(overrides: Partial<Bot>): Bot {
  return { id: 1, name: 'Agent Lee', created_at: null, ...overrides };
}

function knowledge(agent: Bot) {
  const check = deriveAgentHealth(agent).checks.find((c) => c.id === 'knowledge');
  if (!check) throw new Error('knowledge check missing');
  return check;
}

describe('knowledge health check', () => {
  it('reports a trained agent as trained', () => {
    const check = knowledge(bot({ indexed_chunk_count: 42, last_crawl_status: 'done' }));
    expect(check.status).toBe('pass');
    expect(check.detail).toBe('Trained on 42 passages.');
  });

  it('singularises a single passage', () => {
    expect(knowledge(bot({ indexed_chunk_count: 1 })).detail).toBe('Trained on 1 passage.');
  });

  it('reports an agent with no knowledge as untrained', () => {
    const check = knowledge(bot({ indexed_chunk_count: 0 }));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('Nothing learned yet');
  });

  it('does not claim "nothing learned" when a recrawl fails on a trained agent', () => {
    // The regression: a failed ATTEMPT used to be checked before the agent's
    // actual content, so one bad recrawl erased thousands of indexed passages
    // from the UI. It should warn about the attempt, not deny the knowledge.
    const check = knowledge(bot({ indexed_chunk_count: 1204, last_crawl_status: 'failed' }));
    expect(check.status).toBe('warn');
    expect(check.detail).toBe('Trained on 1,204 passages, but the last training run failed.');
    expect(check.detail).not.toContain('Nothing learned yet');
  });

  it('reports a hard failure on an agent that has no knowledge at all', () => {
    const check = knowledge(bot({ indexed_chunk_count: 0, last_crawl_status: 'failed' }));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('last training run failed');
  });

  it('keeps showing existing knowledge while a further crawl runs', () => {
    const check = knowledge(bot({ indexed_chunk_count: 12, last_crawl_status: 'running' }));
    expect(check.status).toBe('pending');
    expect(check.detail).toBe('Trained on 12 passages - learning more right now.');
  });

  it('reports a first-ever crawl as simply training', () => {
    const check = knowledge(bot({ indexed_chunk_count: 0, last_crawl_status: 'running' }));
    expect(check.status).toBe('pending');
    expect(check.detail).toBe('Learning from your website right now.');
  });

  it('treats a missing chunk count as untrained rather than crashing', () => {
    expect(knowledge(bot({})).status).toBe('fail');
  });
});
