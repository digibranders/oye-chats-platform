import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
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

/**
 * A data router, not `MemoryRouter`: the form's `SaveBar` blocks navigation
 * while the draft is dirty, and `useBlocker` only exists on a data router.
 */
function renderScreen() {
  const router = createMemoryRouter(
    [{ path: '/platform/platform/runtime', element: <RuntimeScreen /> }],
    { initialEntries: ['/platform/platform/runtime'] },
  );
  return render(<RouterProvider router={router} />);
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
    // The bar names the field that is blocking the save rather than telling the
    // reader to go and find it.
    expect(await screen.findByText(/Chunk overlap —/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review and apply' })).toBeDisabled();
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
    await user.click(screen.getByRole('button', { name: 'Review and apply' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('chunk_size: 1200');
    expect(httpClient.put).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Apply now' }));
    await waitFor(() =>
      expect(httpClient.put).toHaveBeenCalledWith('/superadmin/model-config', { chunk_size: 1200 }),
    );
  });

  /** The sticky bar floats, so it appears only once there is something to save. */
  it('offers nothing to apply until something changes', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: config() });
    renderScreen();
    await screen.findByLabelText('Chunk size');
    expect(screen.queryByRole('button', { name: 'Review and apply' })).not.toBeInTheDocument();

    const size = screen.getByLabelText('Chunk size');
    await user.clear(size);
    await user.type(size, '1200');
    expect(await screen.findByRole('button', { name: 'Review and apply' })).toBeEnabled();
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
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
  });
});
