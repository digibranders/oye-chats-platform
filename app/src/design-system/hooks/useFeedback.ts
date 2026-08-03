import { useCallback, useEffect, useRef, useState } from 'react';

/** Semantic weight of a feedback message. */
export type FeedbackTone = 'success' | 'error' | 'info';

/** A single transient message shown after a user-initiated action. */
export interface Feedback {
  readonly tone: FeedbackTone;
  readonly message: string;
}

export interface UseFeedbackOptions {
  /**
   * How long a transient message (`success` / `info`) stays on screen, in ms.
   * Errors ignore this - they persist until dismissed or replaced.
   */
  readonly autoDismissMs?: number;
  /**
   * Scope the message to a piece of context - the selected agent, an open
   * dialog, a route param. When the key changes the message is dropped, so a
   * confirmation never bleeds into a context it wasn't about.
   */
  readonly resetKey?: string | number | null;
}

export interface UseFeedbackResult {
  /** The message to render, or `null` when nothing is showing. */
  readonly feedback: Feedback | null;
  /** Show a message, replacing whatever is on screen and restarting the timer. */
  readonly notify: (feedback: Feedback) => void;
  /** Clear the current message immediately. */
  readonly dismiss: () => void;
}

const DEFAULT_AUTO_DISMISS_MS = 5000;

/**
 * useFeedback - owns the state and lifetime of a page's inline confirmation.
 *
 * Pairs with `<FeedbackBanner>`. Success and info messages are transient
 * confirmations of something the user just did; they auto-hide so they don't
 * linger over the page long after the user has moved on. Errors are different
 * - they carry information the user still needs, so they stay until dismissed
 * or replaced by the next result.
 *
 *   const { feedback, notify, dismiss } = useFeedback();
 *   ...
 *   notify({ tone: 'success', message: 'Setup guide copied.' });
 *   ...
 *   <FeedbackBanner feedback={feedback} onDismiss={dismiss} />
 */
export function useFeedback(options: UseFeedbackOptions = {}): UseFeedbackResult {
  const { autoDismissMs = DEFAULT_AUTO_DISMISS_MS, resetKey } = options;

  // `seq` makes each notify() distinct even when the same message is sent
  // twice in a row (copy a value, copy it again) - without it the dismiss
  // timer would keep running from the first call and cut the second short.
  const [entry, setEntry] = useState<{ feedback: Feedback; seq: number } | null>(null);
  const seqRef = useRef(0);

  // Render-time state adjustment (the React-sanctioned reset pattern), guarded
  // to run once per change so it can't loop.
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey);
    setEntry(null);
  }

  const notify = useCallback((next: Feedback): void => {
    seqRef.current += 1;
    setEntry({ feedback: next, seq: seqRef.current });
  }, []);

  const dismiss = useCallback((): void => setEntry(null), []);

  const seq = entry?.seq;
  const tone = entry?.feedback.tone;
  useEffect(() => {
    if (tone === undefined || tone === 'error') return;
    const timer = window.setTimeout(() => setEntry(null), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [seq, tone, autoDismissMs]);

  return { feedback: entry?.feedback ?? null, notify, dismiss };
}
