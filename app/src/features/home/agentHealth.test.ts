import { describe, expect, it } from 'vitest';
import { agentHealth } from './agentHealth';
import type { Bot } from '../../types/domain';

function bot(overrides: Partial<Bot>): Bot {
  return { id: 1, name: 'Acme Support', created_at: null, ...overrides };
}

/**
 * The distinction this file exists to protect: `indexed_chunk_count` is what the
 * chatbot currently knows; `last_crawl_status` only describes the last training
 * attempt. Reading the attempt first is a bug this codebase has already shipped,
 * and it made one failed recrawl render a fully trained chatbot as broken.
 */
describe('agentHealth', () => {
  /**
   * Pause is now writable, so it is a state every surface reading this function
   * has to be able to render. It has to outrank the training and install checks
   * below: a paused chatbot that is trained and installed would otherwise
   * report "Live" while answering nobody, which is the most expensive wrong
   * answer this function can give.
   */
  it('calls a paused chatbot paused, even when it is trained and installed', () => {
    const health = agentHealth(
      bot({
        is_active: false,
        indexed_chunk_count: 4200,
        widget_installed_at: '2026-08-01T00:00:00Z',
      }),
    );
    expect(health.state).toBe('paused');
    expect(health.label).toBe('Paused');
    expect(health.detail).toMatch(/not answering visitors/i);
  });

  it('does not file a pause under "needs attention" — somebody asked for it', () => {
    const health = agentHealth(bot({ is_active: false, indexed_chunk_count: 4200 }));
    expect(health.needsAttention).toBe(false);
    expect(health.tone).toBe('neutral');
  });

  it('treats a missing is_active as active, so an older payload is never paused', () => {
    expect(agentHealth(bot({ indexed_chunk_count: 4200 })).state).not.toBe('paused');
    expect(agentHealth(bot({ is_active: true, indexed_chunk_count: 4200 })).state).not.toBe(
      'paused',
    );
  });

  it('keeps a trained, installed chatbot live after a failed recrawl', () => {
    const health = agentHealth(
      bot({ indexed_chunk_count: 4200, widget_installed_at: '2026-08-01T00:00:00Z', last_crawl_status: 'failed' }),
    );
    expect(health.state).toBe('stale');
    expect(health.label).toMatch(/out of date/i);
    // Still working — the user is told to retry, not that it is broken.
    expect(health.action?.label).toMatch(/retry/i);
  });

  it('calls a failed first crawl broken, because there is nothing to answer from', () => {
    const health = agentHealth(bot({ indexed_chunk_count: 0, last_crawl_status: 'failed' }));
    expect(health.state).toBe('broken');
    expect(health.tone).toBe('danger');
  });

  it('distinguishes never-trained from failed', () => {
    expect(agentHealth(bot({ indexed_chunk_count: 0 })).state).toBe('untrained');
  });

  it('reports a first crawl in progress rather than an empty knowledge base', () => {
    const health = agentHealth(bot({ indexed_chunk_count: 0, last_crawl_status: 'running' }));
    expect(health.state).toBe('training');
    expect(health.needsAttention).toBe(false);
  });

  it('does not interrupt a working chatbot for a background refresh', () => {
    const health = agentHealth(
      bot({ indexed_chunk_count: 900, widget_installed_at: '2026-08-01T00:00:00Z', last_crawl_status: 'running' }),
    );
    expect(health.state).toBe('live');
  });

  it('flags a trained chatbot that was never installed', () => {
    const health = agentHealth(bot({ indexed_chunk_count: 900 }));
    expect(health.state).toBe('ready');
    expect(health.action?.segment).toBe('deploy');
  });

  it('is quiet when everything is fine', () => {
    const health = agentHealth(
      bot({ indexed_chunk_count: 900, widget_installed_at: '2026-08-01T00:00:00Z' }),
    );
    expect(health.state).toBe('live');
    expect(health.needsAttention).toBe(false);
  });
});
