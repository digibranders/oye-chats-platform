import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AgentHealthStrip } from './AgentHealthStrip';
import type { AgentHealth } from '../home/agentHealth';
import type { Bot } from '../../types/domain';

/**
 * The verdict band, and the one thing it must not do: offer to take you where
 * you already are.
 *
 * Four of the six health verdicts point at Knowledge, so on the Knowledge page
 * "Add knowledge" rendered a button back to the page being read — directly
 * above an empty state saying the same thing and the panel that actually does
 * the work. The band is shared with Overview, where the same action is the
 * whole point, so the rule is about the destination rather than about the page.
 */
const agent = { id: 7, name: 'Support' } as Bot;

const untrained: AgentHealth = {
  state: 'untrained',
  tone: 'warning',
  label: 'Nothing to answer from',
  detail: 'It will tell visitors it does not know.',
  needsAttention: true,
  action: { label: 'Add knowledge', segment: 'knowledge' },
};

function renderAt(path: string, health: AgentHealth = untrained) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AgentHealthStrip agent={agent} health={health} />
    </MemoryRouter>,
  );
}

describe('AgentHealthStrip', () => {
  it('offers the action from a page the work is not done on', () => {
    renderAt('/chatbots/7/overview');
    expect(screen.getByRole('link', { name: 'Add knowledge' })).toHaveAttribute(
      'href',
      '/chatbots/7/knowledge',
    );
  });

  it('drops an action that points at the page being read', () => {
    renderAt('/chatbots/7/knowledge');
    expect(screen.queryByRole('link', { name: 'Add knowledge' })).toBeNull();
  });

  it('still states the verdict and its consequence there', () => {
    // The band is not removed with the button. Its detail is the one thing the
    // page does not otherwise say: what the visitor experiences meanwhile.
    renderAt('/chatbots/7/knowledge');
    expect(screen.getByText('Nothing to answer from')).toBeInTheDocument();
    expect(screen.getByText('It will tell visitors it does not know.')).toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
  });

  it('keeps an action that genuinely leads somewhere else', () => {
    const ready: AgentHealth = {
      state: 'ready',
      tone: 'success',
      label: 'Ready, not installed',
      detail: 'Put it on your site.',
      needsAttention: true,
      action: { label: 'Install it', segment: 'deploy' },
    };
    renderAt('/chatbots/7/knowledge', ready);
    expect(screen.getByRole('link', { name: 'Install it' })).toHaveAttribute(
      'href',
      '/chatbots/7/deploy',
    );
  });

  it('renders without an action at all when the verdict carries none', () => {
    const live: AgentHealth = {
      state: 'live',
      tone: 'success',
      label: 'Live',
      detail: 'Answering on your site.',
      needsAttention: false,
    };
    renderAt('/chatbots/7/overview', live);
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
