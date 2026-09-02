import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../../types/domain';
import { LeadJourney } from './LeadInsights';
import { buildJourney } from './leadSource';

/**
 * `lead.source.journey` spans the whole visit, not the pre-chat leg. The backend
 * writes a `phase` of `pre` / `chat` / `post` on every entry and filters on it
 * everywhere else; this panel used to take the array whole, so 3 pages before a
 * chat plus 6 after rendered "9 pages before the chat" with "opened the chat
 * here" pointing at a page the visitor reached afterwards.
 */

function entry(path: string, phase: string | null, ts: string) {
  return phase === null ? { path, ts } : { path, phase, ts };
}

function leadWith(journey: unknown[]): Lead {
  return {
    session_id: 's1',
    score: 40,
    tier: 'mql',
    status: 'mql',
    chats: 3,
    source: { journey },
  } as unknown as Lead;
}

describe('buildJourney', () => {
  it('keeps only the pre-chat entries when the payload states a phase', () => {
    const { steps, phased } = buildJourney([
      entry('/pricing', 'pre', '2026-08-19T10:00:00Z'),
      entry('/docs', 'pre', '2026-08-19T10:01:00Z'),
      entry('/chat', 'chat', '2026-08-19T10:02:00Z'),
      entry('/thanks', 'post', '2026-08-19T10:10:00Z'),
    ]);
    expect(phased).toBe(true);
    expect(steps.map((step) => step.path)).toEqual(['/pricing', '/docs']);
    // `last` marks the page the chat opened on, which is now the last PRE entry.
    expect(steps[1].last).toBe(true);
  });

  it('measures dwell against the next kept entry, not the next raw one', () => {
    const { steps } = buildJourney([
      entry('/pricing', 'pre', '2026-08-19T10:00:00Z'),
      entry('/chat', 'chat', '2026-08-19T10:00:10Z'),
      entry('/docs', 'pre', '2026-08-19T10:01:00Z'),
    ]);
    expect(steps.map((step) => step.path)).toEqual(['/pricing', '/docs']);
    expect(steps[0].dwell).toBe('1m');
  });

  it('keeps an unphased array whole rather than blanking the panel', () => {
    // Leads captured before the field existed carry no phase at all. Dropping
    // every entry would lose a record that is still worth reading.
    const { steps, phased } = buildJourney([
      entry('/pricing', null, '2026-08-19T10:00:00Z'),
      entry('/docs', null, '2026-08-19T10:01:00Z'),
    ]);
    expect(phased).toBe(false);
    expect(steps).toHaveLength(2);
  });
});

describe('LeadJourney', () => {
  it('counts and labels only the pre-chat pages', () => {
    render(
      <LeadJourney
        lead={leadWith([
          entry('/a', 'pre', '2026-08-19T10:00:00Z'),
          entry('/b', 'pre', '2026-08-19T10:01:00Z'),
          entry('/c', 'pre', '2026-08-19T10:02:00Z'),
          entry('/d', 'post', '2026-08-19T10:20:00Z'),
          entry('/e', 'post', '2026-08-19T10:21:00Z'),
        ])}
      />,
    );
    expect(screen.getByText('3 pages before the chat')).toBeInTheDocument();
    expect(screen.queryByText('5 pages before the chat')).not.toBeInTheDocument();
  });

  it('drops the "before the chat" claim when nothing states a phase', () => {
    render(
      <LeadJourney
        lead={leadWith([
          entry('/a', null, '2026-08-19T10:00:00Z'),
          entry('/b', null, '2026-08-19T10:01:00Z'),
        ])}
      />,
    );
    expect(screen.getByText('2 pages visited')).toBeInTheDocument();
    expect(screen.queryByText(/before the chat/i)).not.toBeInTheDocument();
  });
});
