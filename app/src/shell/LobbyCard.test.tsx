import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LobbyCard } from './LobbyCard';
import { AGEING_MS, OVERDUE_MS, waitWords, type LobbyAlert } from './lobbyModel';

/**
 * One card, and the two things about it that are not decoration.
 *
 * The stripe darkens as a visitor waits, and about one operator in twelve
 * cannot tell those three colours apart. The wait is therefore printed at every
 * band, and that is asserted here rather than left to a review of a screenshot.
 */

const NOW = Date.parse('2026-09-08T12:00:00Z');

function alert(over: Partial<LobbyAlert> = {}): LobbyAlert {
  return {
    key: 'w.s1',
    sessionId: 's1',
    kind: 'waiting',
    name: 'Siddique',
    detail: 'Acme Bot',
    preview: 'i want to know more abt the pricing',
    since: new Date(NOW - 8_000).toISOString(),
    ...over,
  };
}

function card(over: Partial<LobbyAlert> = {}, props: Record<string, unknown> = {}) {
  return render(
    <LobbyCard
      alert={alert(over)}
      now={NOW}
      onTake={vi.fn()}
      onOpenInbox={vi.fn()}
      onDismiss={vi.fn()}
      {...props}
    />,
  );
}

describe('waitWords', () => {
  it('counts in seconds before a minute and keeps them after', () => {
    // A queue is read in seconds. "1m" for anything between 60 and 119 seconds
    // hides exactly the interval in which a visitor decides to leave.
    expect(waitWords(8_000)).toBe('8s');
    expect(waitWords(59_000)).toBe('59s');
    expect(waitWords(72_000)).toBe('1m 12s');
    expect(waitWords(3_680_000)).toBe('1h 1m');
  });
});

describe('LobbyCard', () => {
  it('names who is waiting, where from, and what they said', () => {
    card();
    expect(screen.getByText('Siddique')).toBeInTheDocument();
    // The chatbot and the state share one subtitle. They used to be an
    // uppercase mono eyebrow above the name and a chatbot line below it, which
    // is two rows of furniture on a 320px card for one sentence.
    expect(screen.getByText('Acme Bot · Waiting for a person')).toBeInTheDocument();
    expect(screen.getByText(/i want to know more abt the pricing/)).toBeInTheDocument();
  });

  it('prints the wait at every band, so colour is never the only signal', () => {
    const fresh = card({ since: new Date(NOW - 8_000).toISOString() });
    expect(screen.getByText('8s')).toBeInTheDocument();
    expect(document.querySelector('[data-lobby-card]')).toHaveAttribute('data-band', 'fresh');
    fresh.unmount();

    const ageing = card({ since: new Date(NOW - AGEING_MS - 12_000).toISOString() });
    expect(screen.getByText('1m 12s')).toBeInTheDocument();
    expect(document.querySelector('[data-lobby-card]')).toHaveAttribute('data-band', 'ageing');
    ageing.unmount();

    card({ since: new Date(NOW - OVERDUE_MS - 40_000).toISOString() });
    expect(screen.getByText('3m 40s')).toBeInTheDocument();
    expect(document.querySelector('[data-lobby-card]')).toHaveAttribute('data-band', 'overdue');
  });

  it('never reddens a chat the operator already holds', () => {
    // That visitor knows somebody is there. Spending the loudest signal in the
    // stack on them would leave nothing for a stranger about to give up.
    card({ kind: 'message', since: new Date(NOW - OVERDUE_MS - 60_000).toISOString() });
    expect(document.querySelector('[data-lobby-card]')).toHaveAttribute('data-band', 'fresh');
  });

  it('offers to take a stranger and to reply to somebody you hold', () => {
    const waiting = card();
    expect(screen.getByRole('button', { name: 'Take it' })).toBeInTheDocument();
    waiting.unmount();

    card({ kind: 'message' });
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  it('says whose card the dismiss button closes', () => {
    // Three cards, three identical Xs, is a control that needs the name to be
    // usable by anybody listening rather than looking.
    card();
    expect(screen.getByRole('button', { name: 'Dismiss Siddique' })).toBeInTheDocument();
  });

  it('carries the mute only when the caller gives it one', () => {
    const without = card();
    expect(screen.queryByRole('button', { name: /mute/i })).toBeNull();
    without.unmount();

    const onToggleMute = vi.fn();
    card({}, { onToggleMute });
    expect(screen.getByRole('button', { name: 'Mute alert sound' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('says the sound is off once it is', () => {
    card({}, { onToggleMute: vi.fn(), muted: true });
    const button = screen.getByRole('button', { name: 'Unmute alert sound' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('replaces the actions with what happened, rather than vanishing', async () => {
    // A card that disappears the instant a colleague takes the visitor leaves
    // an operator's pointer travelling toward a button that is no longer there,
    // landing on whichever card slid up into the gap.
    const onTake = vi.fn();
    card({}, { resolution: 'Asha took this one', onTake });
    expect(screen.getByText('Asha took this one')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take it' })).toBeNull();
    expect(onTake).not.toHaveBeenCalled();
  });

  it('prints no duration at all when the payload carried no start time', () => {
    // "0s" would be a claim. A card that does not know how long somebody has
    // been waiting says nothing, and stays on the calm end of the scale.
    card({ since: null });
    expect(screen.queryByText(/^\d+[smh]/)).toBeNull();
    expect(document.querySelector('[data-lobby-card]')).toHaveAttribute('data-band', 'fresh');
  });

  it('carries the urgency on the wait itself, not on a coloured rule', () => {
    // The first version painted a 3px accent bar across the top of the card.
    // It said "urgent" without saying how urgent, and the number underneath
    // already did. `Badge` always carries a word, so the tone never works
    // alone — which is the reason the bar could go.
    card({ since: new Date(NOW - OVERDUE_MS - 40_000).toISOString() });
    // `Badge` truncates its label in an inner span, so the tone lives on the
    // element above the text node.
    const badge = screen.getByText('3m 40s').closest('[class*="bg-danger"]');
    expect(badge).not.toBeNull();
    expect(document.querySelector('[data-lobby-card] [class*="bg-accent-500"]')).toBeNull();
  });

  it('is announced politely, not as an interruption', () => {
    // The operator may be mid-sentence in another conversation. `role="alert"`
    // would cut across whatever a screen reader is currently saying, and this
    // card does not go away on its own, so there is nothing to race.
    card();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('does not fire an accept twice while the first is in flight', async () => {
    const onTake = vi.fn();
    const user = userEvent.setup();
    card({}, { onTake, busy: true });
    await user.click(screen.getByRole('button', { name: 'Take it' }));
    expect(onTake).not.toHaveBeenCalled();
  });
});
