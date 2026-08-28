import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitPane } from './SplitPane';

/**
 * Rendered as the inbox will render it: a queue with a draft in it, a detail
 * pane, and a separator an operator has to be able to move without a mouse.
 */
function Draft() {
  const [value, setValue] = useState('');
  return (
    <label>
      Reply
      <input value={value} onChange={(event) => setValue(event.target.value)} />
    </label>
  );
}

function Inbox(props: Partial<React.ComponentProps<typeof SplitPane>> = {}) {
  return (
    <SplitPane
      selected
      list={<Draft />}
      detail={<p>Transcript</p>}
      listLabel="Conversations"
      detailLabel="Conversation"
      {...props}
    />
  );
}

describe('SplitPane', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps the list mounted while the detail is showing, so a draft survives', async () => {
    // The panes stack below the two-pane step, and the stacked one is hidden
    // rather than unmounted. Unmounting is what made list→detail a route change
    // on three surfaces, and a route change throws away the queue's scroll
    // position and anything half-typed in it.
    const user = userEvent.setup();
    render(<Inbox />);

    const reply = screen.getByLabelText('Reply');
    await user.type(reply, 'On it');
    expect(reply).toHaveValue('On it');
    expect(screen.getByText('Transcript')).toBeInTheDocument();
  });

  it('names each pane as a region so a keyboard user can move between them', () => {
    render(<Inbox inspector={<p>Visitor</p>} inspectorLabel="Visitor" />);
    expect(screen.getByRole('region', { name: 'Conversations' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Visitor' })).toBeInTheDocument();
  });

  it('offers a way back only when a back handler was given', () => {
    const onBack = vi.fn();
    const { rerender } = render(<Inbox />);
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    rerender(<Inbox onBack={onBack} backLabel="All conversations" />);
    expect(screen.getByRole('button', { name: 'All conversations' })).toBeInTheDocument();
  });

  it('resizes from the keyboard and reports the width it moved to', async () => {
    // A drag handle that only responds to a pointer is not a control. Arrow
    // keys move it a step, shift moves it four, and Home/End go to the stops.
    const user = userEvent.setup();
    render(<Inbox resizable storageKey="test:inbox-split" />);

    const separator = screen.getByRole('separator', { name: 'Resize the list' });
    expect(separator).toHaveAttribute('aria-valuenow', '288');

    separator.focus();
    await user.keyboard('{ArrowRight}');
    expect(separator).toHaveAttribute('aria-valuenow', '304');

    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(separator).toHaveAttribute('aria-valuenow', '240');

    await user.keyboard('{End}');
    expect(separator).toHaveAttribute('aria-valuenow', '480');
  });

  it('clamps to its stops rather than letting the list swallow the detail', async () => {
    const user = userEvent.setup();
    render(<Inbox resizable />);
    const separator = screen.getByRole('separator', { name: 'Resize the list' });

    separator.focus();
    await user.keyboard('{Home}');
    await user.keyboard('{ArrowLeft}');
    expect(separator).toHaveAttribute('aria-valuenow', '240');
  });

  it('remembers the width it was dragged to, and ignores a corrupt stored value', () => {
    window.localStorage.setItem('test:inbox-split', '360');
    const { unmount } = render(<Inbox resizable storageKey="test:inbox-split" />);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '360');
    unmount();

    window.localStorage.setItem('test:inbox-split', 'not-a-number');
    render(<Inbox resizable storageKey="test:inbox-split" />);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '288');
  });

  it('has no separator at all when the split is fixed', () => {
    render(<Inbox />);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});
