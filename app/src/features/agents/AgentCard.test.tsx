import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AgentCard } from './AgentCard';
import { type Bot } from '../../types/domain';

describe('AgentCard', () => {
  it('renders creation date when valid created_at is provided', () => {
    const bot: Bot = {
      id: 17,
      name: 'Support Concierge',
      created_at: '2026-07-12T00:00:00.000Z',
    };

    render(
      <MemoryRouter>
        <AgentCard bot={bot} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Created 12 Jul 2026/)).toBeInTheDocument();
  });

  it('does not render created date caption when created_at is missing or invalid', () => {
    const bot: Bot = {
      id: 18,
      name: 'Support Concierge',
      created_at: 'invalid-date',
    };

    render(
      <MemoryRouter>
        <AgentCard bot={bot} />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Created/)).not.toBeInTheDocument();
  });
});
