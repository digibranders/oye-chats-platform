import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeScreen } from './RuntimeScreen';
import type { ModelConfig } from './types';

const httpClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/api', () => ({ httpClient }));

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    primary_model: 'openai/gpt-5.4-mini',
    fallback_model: 'gemini/gemini-2.5-flash',
    gate_model: 'gemini/gemini-2.5-flash',
    rag: { chunk_size: 1000, chunk_overlap: 200, rerank_top_n: 5, relevance_threshold: 0.5 },
    embed: { concurrency: 8 },
    crawler: {
      primary_provider: 'spider',
      fallback_provider: 'jina',
      jina_fetch_concurrency: 5,
      spider_fetch_concurrency: 10,
    },
    impersonation: { enabled: true, locked_by_env: false },
    known_models: [
      { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'OpenAI', tier: 'fast' },
      { id: 'gemini/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google', tier: 'fast' },
    ],
    known_crawl_providers: [
      { id: 'spider', label: 'Spider.cloud', notes: 'Bulk scraper.' },
      { id: 'jina', label: 'Jina Reader', notes: 'Markdown reader.' },
    ],
    ...overrides,
  };
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/platform/platform?view=runtime']}>
      <RuntimeScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The runtime form's one job beyond editing: refuse the chunk pair that turns
 * the next upload into an uncaught exception, and never write without saying
 * which keys are moving.
 */
describe('RuntimeScreen', () => {
  it('blocks the save on a chunk overlap at or above the chunk size', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: config() });
    renderScreen();

    const overlap = await screen.findByLabelText('Chunk overlap');
    await user.clear(overlap);
    await user.type(overlap, '1000');
    await user.click(screen.getByRole('button', { name: /Apply 1 change/ }));

    expect(await screen.findByText(/below chunk size/i)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(httpClient.put).not.toHaveBeenCalled();
  });

  it('sends only the settings that moved, after a confirmation naming them', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: config() });
    httpClient.put.mockResolvedValue({
      data: { ok: true, changed: ['rag.chunk_size'], primary_model: 'x', fallback_model: 'y', gate_model: 'z', crawl_provider_primary: 'spider' },
    });
    renderScreen();

    const size = await screen.findByLabelText('Chunk size');
    await user.clear(size);
    await user.type(size, '1200');
    await user.click(screen.getByRole('button', { name: /Apply 1 change/ }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('chunk_size: 1200');
    expect(httpClient.put).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Apply now' }));
    await waitFor(() =>
      expect(httpClient.put).toHaveBeenCalledWith('/superadmin/model-config', { chunk_size: 1200 }),
    );
  });

  it('offers nothing to apply until something changes', async () => {
    httpClient.get.mockResolvedValue({ data: config() });
    renderScreen();
    expect(await screen.findByRole('button', { name: 'No changes' })).toBeDisabled();
  });

  it('disables the impersonation switch when the environment refuses it', async () => {
    httpClient.get.mockResolvedValue({
      data: config({ impersonation: { enabled: false, locked_by_env: true } }),
    });
    renderScreen();
    // Base UI renders the switch as a span with `aria-disabled`, not a disabled
    // button, so the assertion follows what assistive tech actually reads.
    const toggle = await screen.findByRole('switch', { name: 'Impersonation enabled' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Locked by the environment')).toBeInTheDocument();
  });

  it('warns when the primary and fallback models are the same', async () => {
    httpClient.get.mockResolvedValue({
      data: config({ fallback_model: 'openai/gpt-5.4-mini' }),
    });
    renderScreen();
    expect(await screen.findByText('Primary and fallback are the same model')).toBeInTheDocument();
  });

  it('offers the loading, error and forbidden states', async () => {
    httpClient.get.mockReturnValue(new Promise(() => {}));
    const loading = renderScreen();
    expect(loading.container.querySelector('[aria-busy]')).toBeTruthy();
    loading.unmount();

    httpClient.get.mockRejectedValue({ response: { status: 500, data: { detail: 'Redis down.' } } });
    const failed = renderScreen();
    expect(await screen.findByText('Redis down.')).toBeInTheDocument();
    failed.unmount();

    httpClient.get.mockRejectedValue({ response: { status: 403, data: { detail: 'Nope.' } } });
    renderScreen();
    expect(await screen.findByText('You cannot read the runtime configuration')).toBeInTheDocument();
  });
});
