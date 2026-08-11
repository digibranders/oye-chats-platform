/**
 * Continue must not write the avatar back off.
 *
 * Launch Studio runs Train (step 3) before Customize (step 6), and the crawl
 * sets the agent's avatar from the site's favicon asynchronously after training
 * reports done. This step loads `bot_logo` once on mount, so on the ordinary
 * onboarding path that snapshot can be older than the derived avatar — and the
 * PATCH merges by key, so sending `bot_logo: null` is an instruction to clear
 * it, not an absence of opinion.
 *
 * The rule is "did the user change the image on this screen", not "is it
 * empty": removing the avatar here must still be saved as a removal.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomizeStep } from './CustomizeStep';

const getClientSettings = vi.fn();
const updateClientSettings = vi.fn();
const uploadLogo = vi.fn();

vi.mock('../../../services/api', () => ({
  getClientSettings: (...args: unknown[]) => getClientSettings(...args),
  updateClientSettings: (...args: unknown[]) => updateClientSettings(...args),
  uploadLogo: (...args: unknown[]) => uploadLogo(...args),
  previewChatStream: vi.fn(),
}));

vi.mock('../../../context/BotContext', () => ({
  useBotContext: () => ({ selectedBot: { id: 7, bot_logo: null, primary_color: '#7C3AED' } }),
}));

const previewState = {
  primaryColor: '#7C3AED',
  userBubbleColor: '#DBE9FF',
  avatarType: 'upload' as const,
  orbColor: '',
  botLogo: null as string | null,
  messages: [],
  pending: false,
};

vi.mock('../preview/preview-context', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    usePreview: () => ({
      preview: previewState,
      setPreview: (patch: Record<string, unknown>) => Object.assign(previewState, patch),
      ask: vi.fn(),
    }),
  };
});

const stepProps = {
  onContinue: vi.fn(),
  onBack: vi.fn(),
  isFirst: false,
  isLast: false,
};

async function renderLoaded() {
  render(<CustomizeStep {...stepProps} />);
  await waitFor(() => expect(screen.getByText('Avatar')).toBeTruthy());
}

function clickContinue() {
  const button = screen
    .getAllByRole('button')
    .find((b) => /continue|next|finish/i.test(b.textContent ?? ''));
  if (!button) throw new Error('Continue button not found');
  fireEvent.click(button);
}

describe('CustomizeStep avatar persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(previewState, { botLogo: null, avatarType: 'upload', orbColor: '' });
    getClientSettings.mockResolvedValue({
      primary_color: '#7C3AED',
      user_bubble_color: '#DBE9FF',
      avatar_type: 'upload',
      orb_color: '',
      bot_logo: null,
      launcher_name: 'Have Questions?',
      recommended_colors: [],
    });
    updateClientSettings.mockResolvedValue({});
  });

  it('omits the avatar image when the user never touched it', async () => {
    await renderLoaded();
    clickContinue();

    await waitFor(() => expect(updateClientSettings).toHaveBeenCalled());
    const [payload, botId] = updateClientSettings.mock.calls[0];
    expect(botId).toBe(7);
    expect('bot_logo' in payload).toBe(false);
    expect('launcher_logo' in payload).toBe(false);
    // The rest of the step still saves.
    expect(payload.primary_color).toBe('#7C3AED');
    expect(payload.launcher_name).toBe('Have Questions?');
  });

  it('sends the removal when the user removes the avatar', async () => {
    getClientSettings.mockResolvedValue({
      primary_color: '#7C3AED',
      user_bubble_color: '#DBE9FF',
      avatar_type: 'upload',
      orb_color: '',
      bot_logo: 'logos/existing.png',
      launcher_name: 'Have Questions?',
      recommended_colors: [],
    });
    Object.assign(previewState, { botLogo: 'logos/existing.png' });

    await renderLoaded();
    fireEvent.click(screen.getByText('Remove'));
    clickContinue();

    await waitFor(() => expect(updateClientSettings).toHaveBeenCalled());
    const [payload] = updateClientSettings.mock.calls[0];
    expect('bot_logo' in payload).toBe(true);
    expect(payload.bot_logo).toBeNull();
    expect(payload.launcher_logo).toBeNull();
  });
});
