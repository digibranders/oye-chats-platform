import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { draftsEqual, stableStringify } from './draftDiff';
import { useSettingsDraft } from './useSettingsDraft';

describe('stableStringify', () => {
  it('ignores key order, so a re-serialised payload is not reported as an edit', () => {
    /* `bant_config` is an opaque server object with no ordering guarantee. A
       plain JSON.stringify comparison would raise the Save bar on a payload
       nobody touched, and hold the user hostage to a button that changes
       nothing. */
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(
      stableStringify({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(draftsEqual({ a: [1, { x: 1, y: 2 }] }, { a: [1, { y: 2, x: 1 }] })).toBe(true);
  });

  it('still sees a real difference, including array order', () => {
    expect(draftsEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(draftsEqual([1, 2], [2, 1])).toBe(false);
    expect(draftsEqual({ a: undefined }, { a: null })).toBe(true);
  });
});

interface Draft {
  value: string;
}

function Harness({ agentId, load, save }: {
  agentId: number | null;
  load: (id: number) => Promise<Draft>;
  save: (id: number, draft: Draft, initial: Draft) => Promise<void>;
}) {
  const state = useSettingsDraft<Draft>({ agentId, load, save });
  return (
    <div>
      <p data-testid="status">
        {state.loading ? 'loading' : state.loadError ? `error:${state.loadError}` : 'ready'}
      </p>
      <p data-testid="value">{state.draft?.value ?? '—'}</p>
      <p data-testid="dirty">{state.dirty ? 'dirty' : 'clean'}</p>
      <p data-testid="saved">{state.saved ? 'saved' : ''}</p>
      <button onClick={() => state.update((previous) => ({ value: `${previous.value}!` }))}>
        Edit
      </button>
      <button onClick={() => void state.commit()}>Save</button>
      <button onClick={state.discard}>Discard</button>
      <button onClick={state.retry}>Retry</button>
    </div>
  );
}

describe('useSettingsDraft', () => {
  it('resets to the loading state when the chatbot changes, with no leakage', async () => {
    /* The component stays mounted across `:agentId` changes. The reset happens
       during render, not in an effect, so no frame shows one chatbot's settings
       under the next one's name. */
    const load = vi.fn(async (id: number) => ({ value: `agent-${id}` }));
    const save = vi.fn(async () => {});

    const { rerender } = render(<Harness agentId={1} load={load} save={save} />);
    expect(await screen.findByText('agent-1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('dirty')).toHaveTextContent('dirty');

    rerender(<Harness agentId={2} load={load} save={save} />);
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    expect(screen.getByTestId('dirty')).toHaveTextContent('clean');
    expect(await screen.findByText('agent-2')).toBeInTheDocument();
  });

  it('discards a superseded load instead of painting it over the newer one', async () => {
    const resolvers: Array<(draft: Draft) => void> = [];
    const load = vi.fn(
      (id: number) =>
        new Promise<Draft>((resolve) => {
          resolvers.push(() => resolve({ value: `agent-${id}` }));
        }),
    );
    const save = vi.fn(async () => {});

    const { rerender } = render(<Harness agentId={1} load={load} save={save} />);
    rerender(<Harness agentId={2} load={load} save={save} />);

    // The first chatbot's request lands last. It must be thrown away.
    await act(async () => {
      resolvers[1]({ value: 'agent-2' });
      resolvers[0]({ value: 'agent-1' });
    });

    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('agent-2'));
  });

  it('surfaces a load failure and retries it', async () => {
    const load = vi
      .fn<(id: number) => Promise<Draft>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ value: 'ok' });

    render(<Harness agentId={1} load={load} save={vi.fn(async () => {})} />);
    expect(await screen.findByText('error:boom')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('ok')).toBeInTheDocument();
  });

  it('clears the saved confirmation on the next edit', async () => {
    /* "All changes saved" sitting above an edited field is worse than no
       confirmation at all. */
    render(
      <Harness agentId={1} load={async () => ({ value: 'a' })} save={vi.fn(async () => {})} />,
    );
    await screen.findByText('a');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('saved')).toHaveTextContent('saved'));

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('saved')).toBeEmptyDOMElement();
  });

  it('hands the save both the draft and the values it was loaded from', async () => {
    /* The Qualification page needs the pair in order to send only the slice
       that changed, rather than rewriting a rubric the customer never opened. */
    const save = vi.fn(async () => {});
    render(<Harness agentId={1} load={async () => ({ value: 'a' })} save={save} />);
    await screen.findByText('a');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(1, { value: 'a!' }, { value: 'a' }));
    expect(screen.getByTestId('dirty')).toHaveTextContent('clean');
  });

  it('stays dirty and reports the reason when a save fails', async () => {
    const save = vi.fn(async () => {
      throw new Error('nope');
    });
    render(<Harness agentId={1} load={async () => ({ value: 'a' })} save={save} />);
    await screen.findByText('a');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByTestId('dirty')).toHaveTextContent('dirty'));
    expect(screen.getByTestId('saved')).toBeEmptyDOMElement();
  });

  it('discards back to the loaded values', async () => {
    render(
      <Harness agentId={1} load={async () => ({ value: 'a' })} save={vi.fn(async () => {})} />,
    );
    await screen.findByText('a');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.getByTestId('value')).toHaveTextContent('a');
    expect(screen.getByTestId('dirty')).toHaveTextContent('clean');
  });
});
