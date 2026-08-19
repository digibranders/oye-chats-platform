import { describe, expect, it } from 'vitest';
import { getAgentHealth } from './agent-status';
import { type Bot } from '../../types/domain';

/**
 * Same rule as `overview/agent-health.ts`, pinned on the sibling surfaces that
 * shipped without it: `indexed_chunk_count` is what the agent CURRENTLY knows,
 * `last_crawl_status` only describes the last training ATTEMPT. Checking the
 * attempt first made one failed recrawl render an agent holding thousands of
 * passages as "Trained" in the Overview hero and "Needs attention" on the Home
 * page and Agents list at the same time.
 */

function bot(overrides: Partial<Bot>): Bot {
  return { id: 1, name: 'Agent Lee', created_at: null, ...overrides };
}

describe('getAgentHealth (Agents list)', () => {
  it('keeps a trained, installed agent live after a failed recrawl', () => {
    expect(
      getAgentHealth(
        bot({
          indexed_chunk_count: 5000,
          widget_installed_at: '2026-07-01T00:00:00Z',
          last_crawl_status: 'failed',
        }),
      ),
    ).toBe('live');
  });

  it('keeps a trained agent ready after a no_content recrawl', () => {
    expect(getAgentHealth(bot({ indexed_chunk_count: 5000, last_crawl_status: 'no_content' }))).toBe(
      'ready',
    );
  });

  it('still flags an untrained agent whose crawl failed', () => {
    expect(getAgentHealth(bot({ indexed_chunk_count: 0, last_crawl_status: 'failed' }))).toBe(
      'attention',
    );
    expect(getAgentHealth(bot({ indexed_chunk_count: 0, last_crawl_status: 'no_content' }))).toBe(
      'attention',
    );
  });

  it('reports a running crawl as training regardless of chunks', () => {
    expect(getAgentHealth(bot({ indexed_chunk_count: 5000, last_crawl_status: 'running' }))).toBe(
      'training',
    );
  });

  it('reports a never-trained agent as draft', () => {
    expect(getAgentHealth(bot({ indexed_chunk_count: 0 }))).toBe('draft');
  });
});
