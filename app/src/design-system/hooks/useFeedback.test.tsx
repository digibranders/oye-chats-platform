import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFeedback } from './useFeedback';
import { FeedbackBanner } from '../components/FeedbackBanner';

describe('useFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-dismisses a success message after the default delay', () => {
    const { result } = renderHook(() => useFeedback());

    act(() => result.current.notify({ tone: 'success', message: 'Setup guide copied.' }));
    expect(result.current.feedback?.message).toBe('Setup guide copied.');

    act(() => vi.advanceTimersByTime(4999));
    expect(result.current.feedback).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.feedback).toBeNull();
  });

  it('auto-dismisses an info message', () => {
    const { result } = renderHook(() => useFeedback());

    act(() => result.current.notify({ tone: 'info', message: 'Downgrade scheduled.' }));
    act(() => vi.advanceTimersByTime(5000));

    expect(result.current.feedback).toBeNull();
  });

  it('keeps an error on screen indefinitely', () => {
    const { result } = renderHook(() => useFeedback());

    act(() => result.current.notify({ tone: 'error', message: 'Failed to save.' }));
    act(() => vi.advanceTimersByTime(60_000));

    expect(result.current.feedback?.message).toBe('Failed to save.');
  });

  it('honours a custom delay', () => {
    const { result } = renderHook(() => useFeedback({ autoDismissMs: 1000 }));

    act(() => result.current.notify({ tone: 'success', message: 'Saved.' }));
    act(() => vi.advanceTimersByTime(1000));

    expect(result.current.feedback).toBeNull();
  });

  it('restarts the timer when the same message is sent twice', () => {
    const { result } = renderHook(() => useFeedback());
    const message = { tone: 'success', message: 'Copied.' } as const;

    act(() => result.current.notify(message));
    act(() => vi.advanceTimersByTime(4000));

    // Re-copying with 1s left on the clock must buy a fresh 5s, not 1s.
    act(() => result.current.notify(message));
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.feedback).not.toBeNull();

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.feedback).toBeNull();
  });

  it('drops the message when the reset key changes', () => {
    const { result, rerender } = renderHook(({ botId }) => useFeedback({ resetKey: botId }), {
      initialProps: { botId: 1 },
    });

    act(() => result.current.notify({ tone: 'error', message: 'Failed to save.' }));
    expect(result.current.feedback).not.toBeNull();

    rerender({ botId: 2 });
    expect(result.current.feedback).toBeNull();
  });

  it('dismisses on demand', () => {
    const { result } = renderHook(() => useFeedback());

    act(() => result.current.notify({ tone: 'error', message: 'Failed to save.' }));
    act(() => result.current.dismiss());

    expect(result.current.feedback).toBeNull();
  });
});

describe('FeedbackBanner', () => {
  it('renders an empty live region when there is no message', () => {
    const { container } = render(<FeedbackBanner feedback={null} />);
    const region = container.querySelector('[aria-live="polite"]');

    expect(region).toBeInTheDocument();
    expect(region).toBeEmptyDOMElement();
  });

  it('renders the message and omits the close button when onDismiss is not given', () => {
    const { getByText, queryByLabelText } = render(
      <FeedbackBanner feedback={{ tone: 'success', message: 'Setup guide copied.' }} />,
    );

    expect(getByText('Setup guide copied.')).toBeInTheDocument();
    expect(queryByLabelText('Dismiss message')).not.toBeInTheDocument();
  });
});
