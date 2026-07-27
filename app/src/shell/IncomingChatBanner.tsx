import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquareText, X } from 'lucide-react';
import { Button } from '../design-system';
import { useNotifications } from '../context/NotificationContext';
import { playPing } from '../features/inbox/notifications';

/** How long the banner stays before auto-dismissing. */
const AUTO_DISMISS_MS = 30_000;

/**
 * IncomingChatBanner — app-wide slide-in toast for a new live-chat handoff
 * request, mirroring the legacy console's `LiveChatRequestBanner`. Subscribes to
 * the `incomingHandoff` slot on `NotificationProvider` (fed by the
 * `/ws/notifications` stream), chimes once on arrival, counts down a 30s
 * progress bar, and routes the operator to the Inbox on "Open chat". Rendered
 * once in `AppShell`, so a waiting visitor is never missed regardless of route.
 */
export function IncomingChatBanner(): ReactElement | null {
  const { incomingHandoff, dismissIncomingHandoff } = useNotifications();
  const navigate = useNavigate();
  const [progress, setProgress] = useState(1);
  const shownIdRef = useRef<number | null>(null);

  const sessionId =
    (incomingHandoff?.data?.session_id as string | number | undefined) ?? null;
  const botName = (incomingHandoff?.data?.bot_name as string | undefined) ?? null;

  // Chime once per distinct handoff.
  useEffect(() => {
    if (!incomingHandoff) return;
    if (shownIdRef.current === incomingHandoff.id) return;
    shownIdRef.current = incomingHandoff.id;
    playPing();
  }, [incomingHandoff]);

  // Countdown + auto-dismiss, restarted for each new handoff. Each run drives
  // `progress` from its own `start` via rAF, so a fresh handoff resets the bar
  // without a synchronous setState here.
  useEffect(() => {
    if (!incomingHandoff) return undefined;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const remaining = Math.max(0, 1 - (now - start) / AUTO_DISMISS_MS);
      setProgress(remaining);
      if (remaining <= 0) {
        dismissIncomingHandoff();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [incomingHandoff, dismissIncomingHandoff]);

  if (!incomingHandoff) return null;

  const title = incomingHandoff.title || 'New chat request';
  const body =
    incomingHandoff.body ||
    (botName ? `A visitor on ${botName} wants to talk to a person.` : 'A visitor wants to talk to a person.');

  const openChat = (): void => {
    dismissIncomingHandoff();
    const params = new URLSearchParams({ tab: 'live' });
    if (sessionId != null) params.set('session', String(sessionId));
    navigate(`/inbox?${params.toString()}`);
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed bottom-5 right-5 z-[60] w-[min(22rem,calc(100vw-2.5rem))] overflow-hidden rounded-[var(--ds-radius-xl)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]"
    >
      <div className="flex items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
          <MessageSquareText size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-[var(--ds-text)]">{title}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">{body}</p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={openChat}>
              Open chat
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissIncomingHandoff}>
              Later
            </Button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismissIncomingHandoff}
          className="-mr-1 -mt-1 rounded-md p-1 text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="h-0.5 w-full bg-[var(--ds-bg-hover)]">
        <div
          className="h-full bg-[var(--ds-accent)] transition-none"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}
