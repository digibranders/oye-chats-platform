/**
 * Step 2 must never mint a second chatbot for someone who already has one.
 *
 * The create-vs-rename branch keys on `selectedBot`, which is null for EVERY
 * user until `BotContext` finishes loading - so "no agent" and "don't know yet"
 * look identical at the moment the user clicks Continue. On a plan with
 * unlimited agents nothing downstream catches the mistake: the account just
 * accumulates junk chatbots.
 *
 * The prefill has the matching async defect - a one-shot `useState` initialiser
 * reads `undefined` on a fresh load and never corrects itself.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateAgentStep } from './CreateAgentStep';
import type { Bot } from '../../../types/domain';

const createBot = vi.fn();
const updateBot = vi.fn();

vi.mock('../../../services/api', () => ({
  createBot: (...args: unknown[]) => createBot(...args),
  updateBot: (...args: unknown[]) => updateBot(...args),
  recordActivationEvent: vi.fn(),
}));

interface BotContextStub {
  bots: Bot[];
  selectedBot: Bot | null;
  loading: boolean;
  error: { message: string; status: number | null } | null;
}

const selectBot = vi.fn();
const refreshBots = vi.fn();

let botCtx: BotContextStub;

vi.mock('../../../context/BotContext', () => ({
  useBotContext: () => ({ ...botCtx, selectBot, refreshBots }),
}));

const openUpgradeModal = vi.fn();

vi.mock('../../../context/UpgradeModalContext', () => ({
  useUpgradeModal: () => ({ openUpgradeModal }),
}));

vi.mock('../../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ planName: 'Enterprise' }),
}));

const stepProps = {
  onContinue: vi.fn(),
  onBack: vi.fn(),
  isFirst: false,
  isLast: false,
};

const EXISTING: Bot = { id: 7, name: 'Ava' };

function nameField(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement;
}

function continueButton(): HTMLButtonElement {
  const button = screen
    .getAllByRole('button')
    .find((b) => /continue|finish|saving|loading/i.test(b.textContent ?? ''));
  if (!button) throw new Error('Continue button not found');
  return button as HTMLButtonElement;
}

async function clickContinue(): Promise<void> {
  await act(async () => {
    fireEvent.click(continueButton());
  });
}

describe('CreateAgentStep create-vs-rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    botCtx = { bots: [EXISTING], selectedBot: EXISTING, loading: false, error: null };
    createBot.mockResolvedValue({ id: 9, name: 'New agent' });
    updateBot.mockResolvedValue({});
    refreshBots.mockResolvedValue([]);
  });

  it('renames the existing agent instead of creating a second one', async () => {
    render(<CreateAgentStep {...stepProps} />);
    fireEvent.change(nameField(), { target: { value: 'Ava Support' } });

    await clickContinue();

    await waitFor(() => expect(updateBot).toHaveBeenCalledWith(7, { name: 'Ava Support' }));
    expect(createBot).not.toHaveBeenCalled();
    expect(stepProps.onContinue).toHaveBeenCalled();
  });

  it('never creates while the bot list is still loading', async () => {
    botCtx = { bots: [], selectedBot: null, loading: true, error: null };
    const { rerender } = render(<CreateAgentStep {...stepProps} />);

    // A returning user is indistinguishable from a new one at this moment.
    fireEvent.change(nameField(), { target: { value: 'Support' } });
    await clickContinue();
    expect(createBot).not.toHaveBeenCalled();
    expect(stepProps.onContinue).not.toHaveBeenCalled();

    // Their agent arrives - Continue must now rename, never create.
    botCtx = { bots: [EXISTING], selectedBot: EXISTING, loading: false, error: null };
    rerender(<CreateAgentStep {...stepProps} />);
    await clickContinue();

    await waitFor(() => expect(updateBot).toHaveBeenCalledWith(7, { name: 'Support' }));
    expect(createBot).not.toHaveBeenCalled();
  });

  it('never creates when the bot list failed to load', async () => {
    botCtx = {
      bots: [],
      selectedBot: null,
      loading: false,
      error: { message: 'Network error', status: null },
    };
    render(<CreateAgentStep {...stepProps} />);
    fireEvent.change(nameField(), { target: { value: 'Support' } });

    await clickContinue();

    expect(createBot).not.toHaveBeenCalled();
    expect(stepProps.onContinue).not.toHaveBeenCalled();
    expect(screen.getByText(/couldn't load your existing chatbots/i)).toBeTruthy();
  });

  it('creates exactly one agent for a genuinely new account', async () => {
    botCtx = { bots: [], selectedBot: null, loading: false, error: null };
    render(<CreateAgentStep {...stepProps} />);
    fireEvent.change(nameField(), { target: { value: 'Support' } });

    await clickContinue();

    await waitFor(() => expect(createBot).toHaveBeenCalledWith({ name: 'Support' }));
    expect(createBot).toHaveBeenCalledTimes(1);
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('creates once, not twice, when Continue is double-clicked', async () => {
    botCtx = { bots: [], selectedBot: null, loading: false, error: null };
    let release!: (bot: Bot) => void;
    createBot.mockReturnValue(
      new Promise<Bot>((resolve) => {
        release = resolve;
      }),
    );

    render(<CreateAgentStep {...stepProps} />);
    fireEvent.change(nameField(), { target: { value: 'Support' } });

    await act(async () => {
      const button = continueButton();
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(createBot).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ id: 9, name: 'Support' });
    });
    expect(createBot).toHaveBeenCalledTimes(1);
  });

  it('lets a returning user continue with a blank field, renaming nothing', async () => {
    render(<CreateAgentStep {...stepProps} />);
    fireEvent.change(nameField(), { target: { value: '' } });

    expect(continueButton().disabled).toBe(false);
    await clickContinue();

    expect(createBot).not.toHaveBeenCalled();
    expect(updateBot).not.toHaveBeenCalled();
    expect(stepProps.onContinue).toHaveBeenCalled();
  });

  it('still requires a name from a genuinely new account', async () => {
    botCtx = { bots: [], selectedBot: null, loading: false, error: null };
    render(<CreateAgentStep {...stepProps} />);

    expect(continueButton().disabled).toBe(true);
    await clickContinue();

    expect(createBot).not.toHaveBeenCalled();
    expect(stepProps.onContinue).not.toHaveBeenCalled();
  });
});

describe('CreateAgentStep name prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    botCtx = { bots: [], selectedBot: null, loading: true, error: null };
    createBot.mockResolvedValue({ id: 9, name: 'New agent' });
    updateBot.mockResolvedValue({});
    refreshBots.mockResolvedValue([]);
  });

  it('populates from a late-arriving agent', async () => {
    const { rerender } = render(<CreateAgentStep {...stepProps} />);
    expect(nameField().value).toBe('');

    botCtx = { bots: [EXISTING], selectedBot: EXISTING, loading: false, error: null };
    rerender(<CreateAgentStep {...stepProps} />);

    await waitFor(() => expect(nameField().value).toBe('Ava'));
  });

  it('is empty for a new account with no agent', async () => {
    botCtx = { bots: [], selectedBot: null, loading: false, error: null };
    render(<CreateAgentStep {...stepProps} />);

    expect(nameField().value).toBe('');
  });

  it('never overwrites what the user typed before the agent arrived', async () => {
    const { rerender } = render(<CreateAgentStep {...stepProps} />);
    fireEvent.change(nameField(), { target: { value: 'My own name' } });

    botCtx = { bots: [EXISTING], selectedBot: EXISTING, loading: false, error: null };
    rerender(<CreateAgentStep {...stepProps} />);

    expect(nameField().value).toBe('My own name');
  });

  it('keeps the field empty when the user deliberately cleared it', async () => {
    const { rerender } = render(<CreateAgentStep {...stepProps} />);
    fireEvent.change(nameField(), { target: { value: 'typed' } });
    fireEvent.change(nameField(), { target: { value: '' } });

    botCtx = { bots: [EXISTING], selectedBot: EXISTING, loading: false, error: null };
    rerender(<CreateAgentStep {...stepProps} />);

    expect(nameField().value).toBe('');
  });
});
