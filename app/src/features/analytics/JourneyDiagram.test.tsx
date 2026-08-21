import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { JourneyPreChatSequencesResponse } from '../../services/api';
import { JourneyDiagram } from './JourneyDiagram';

const sequences: JourneyPreChatSequencesResponse = {
  period: '2026-08',
  total_sessions: 10,
  sessions_with_pre_chat: 8,
  sequences: [
    { sequence: ['/pricing'], post_sequence: ['/docs'], post_sessions: 3, sessions: 5 },
    { sequence: ['/pricing', '/contact'], post_sequence: [], post_sessions: 0, sessions: 3 },
  ],
};

function renderDiagram(onSelectOutcome = vi.fn()) {
  return render(
    <JourneyDiagram
      sequences={sequences}
      centerLabel="Opened Chatbot"
      centerValue={10}
      selectedOutcome={null}
      onSelectOutcome={onSelectOutcome}
    />,
  );
}

describe('JourneyDiagram', () => {
  it('renders each distinct page as a real, keyboard-focusable button with a labeled session count', async () => {
    const user = userEvent.setup();
    renderDiagram();
    // Prefix merging in buildTrie sums /pricing sessions across both sequences (5 + 3 = 8)
    const node = screen.getByRole('button', { name: /\/pricing.*8 sessions/i });
    await user.tab();
    // keep tabbing until we reach it or run out — proves it's in the tab order
    let found = document.activeElement === node;
    for (let i = 0; i < 10 && !found; i++) {
      await user.tab();
      found = document.activeElement === node;
    }
    expect(found).toBe(true);
  });

  it('activates a node with Enter, not just a click', async () => {
    const user = userEvent.setup();
    renderDiagram();
    // Prefix merging in buildTrie sums /pricing sessions across both sequences (5 + 3 = 8)
    const node = screen.getByRole('button', { name: /\/pricing.*8 sessions/i });
    node.focus();
    await user.keyboard('{Enter}');
    expect(node).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers a fullscreen expand control that is itself a real button', () => {
    renderDiagram();
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
  });
});
