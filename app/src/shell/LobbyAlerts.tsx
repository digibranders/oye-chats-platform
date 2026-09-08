import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { acceptChat } from '../services/api';
import { useInboxSocket } from '../features/inbox/inboxSocket';
import { LobbyCard } from './LobbyCard';
import { useLobbyAlerts } from './useLobbyAlerts';
import { useWaitingTitle } from './useWaitingTitle';
import { useTranslation } from '../i18n/useTranslation';

/**
 * The lobby stack: who is waiting for this operator, wherever they are.
 *
 * Positioned, never laid out. Every other way of putting this on screen moves
 * the page: a shell banner is a flex row above the top bar, and one arriving
 * between a `mousedown` and a `mouseup` swallows the click, which is a defect
 * this console shipped on the auth pages and fixed the same week. Nothing here
 * touches the document flow.
 *
 * Top-right, below the bar, because every other corner is spoken for:
 * bottom-right is the OyeChats widget's own launcher (the console embeds its
 * own widget), bottom-centre is the inbox composer, and the leading edge is the
 * navigation rail. It shares that corner with the toaster, and sits below it,
 * because a toast is a reply to something the operator just did and this is
 * not.
 */

/** How long a resolved card stays before it leaves. */
const RESOLVED_MS = 3_000;

export function LobbyAlerts() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const socket = useInboxSocket();
  const { alerts, now, muted, toggleMute, dismiss } = useLobbyAlerts();
  // Only people in the lobby count toward the tab title. A message in a chat
  // the operator already holds is a nudge; it does not belong in the number
  // that says how many strangers are unattended.
  useWaitingTitle(alerts.filter((alert) => alert.kind === 'waiting').length);
  const [busy, setBusy] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});

  // A resolution is a goodbye, not a state: the card says what happened, then
  // goes. Cleaning up here rather than in the model keeps the model pure.
  useEffect(() => {
    const pending = Object.keys(resolutions);
    if (pending.length === 0) return undefined;
    const timer = window.setTimeout(() => {
      pending.forEach((key) => {
        const [sessionId, since] = JSON.parse(key) as [string, string | null];
        dismiss(sessionId, since);
      });
      setResolutions({});
    }, RESOLVED_MS);
    return () => window.clearTimeout(timer);
  }, [resolutions, dismiss]);

  const openConversation = useCallback(
    (sessionId: string) => {
      navigate(`/inbox?session=${encodeURIComponent(sessionId)}`);
    },
    [navigate],
  );

  const take = useCallback(
    async (sessionId: string, kind: 'waiting' | 'message', since: string | null) => {
      // A held chat is already theirs. "Reply" is a navigation, not a claim.
      if (kind === 'message') {
        openConversation(sessionId);
        return;
      }
      setBusy(sessionId);
      try {
        await acceptChat(sessionId, socket.operatorId);
        openConversation(sessionId);
      } catch (error) {
        // Almost always a colleague got there first. The card says so and stays
        // put for a moment rather than disappearing under a pointer that is
        // still moving toward it.
        setResolutions((current) => ({
          ...current,
          [JSON.stringify([sessionId, since])]:
            error instanceof Error && error.message
              ? error.message
              : t('shell.lobbyCouldNotTakeThisOne') || 'Could not take this one. It may already be answered.',
        }));
      } finally {
        setBusy(null);
      }
    },
    [openConversation, socket.operatorId, t],
  );

  if (alerts.length === 0) return null;

  // At most three on screen. Beyond that the stack is taller than the viewport
  // on a laptop and the oldest, which is the one that matters, is the one that
  // scrolls off.
  const visible = alerts.slice(0, 3);
  const overflow = alerts.length - visible.length;

  return (
    <div
      // `pointer-events-none` on the column and `auto` on each card: the gaps
      // between them are 12px of dead space over the page, and an operator
      // aiming at something underneath should not be blocked by a container.
      className="pointer-events-none fixed end-4 z-[var(--z-toast)] flex flex-col gap-3"
      style={{ top: 'calc(var(--spacing-topbar) + 0.75rem)' }}
      aria-label={t('shell.lobbyAlerts') || 'Waiting visitors'}
    >
      {visible.map((alert, index) => (
        <LobbyCard
          key={alert.key}
          alert={alert}
          now={now}
          busy={busy === alert.sessionId}
          resolution={resolutions[JSON.stringify([alert.sessionId, alert.since])] ?? null}
          // The mute is one setting, so it rides on the first card rather than
          // appearing three times.
          onToggleMute={index === 0 ? toggleMute : undefined}
          muted={muted}
          onTake={() => void take(alert.sessionId, alert.kind, alert.since)}
          onOpenInbox={() => navigate('/inbox')}
          onDismiss={() => dismiss(alert.sessionId, alert.since)}
        />
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          onClick={() => navigate('/inbox')}
          className="pointer-events-auto w-80 rounded-lg border border-border bg-surface px-3.5 py-2 text-start text-xs text-text-secondary shadow-md hover:bg-surface-hover"
        >
          {t('shell.lobbyNMoreWaiting', { count: overflow }) || `${overflow} more waiting`}
        </button>
      ) : null}
    </div>
  );
}
