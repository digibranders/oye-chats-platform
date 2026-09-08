import { Bell, BellOff, X } from 'lucide-react';
import { Avatar, Button, cn } from '../ui';
import { ageBand, waitWords, waitedMs, type LobbyAlert } from './lobbyModel';
import { useTranslation } from '../i18n/useTranslation';

/**
 * One visitor who needs the operator, wherever the operator happens to be.
 *
 * A floating card rather than a banner, and the reason is a click rather than
 * taste. A shell banner is a layout row: it arrives on its own schedule and
 * pushes the page down, and a reflow between a `mousedown` and a `mouseup`
 * means the browser dispatches no `click` at all. That defect shipped on the
 * auth pages and cost every visitor two clicks on "Sign in". A card floats, so
 * whatever the operator was doing underneath is untouched.
 *
 * A toast was the other candidate and is what the report asked for. It removes
 * itself after a few seconds, which is the reported failure exactly: a signal
 * that disappears on its own can be missed the same way the notification panel
 * is missed. This one leaves when the visitor is answered or gives up, and not
 * before.
 */

export interface LobbyCardProps {
  alert: LobbyAlert;
  /** One clock for the whole stack, so ten cards are not ten timers. */
  now: number;
  busy?: boolean;
  /** Accept and go to the conversation, or open the thread for a held chat. */
  onTake: () => void;
  onOpenInbox: () => void;
  onDismiss: () => void;
  /** Only the top card carries the mute; it is one setting, not one per card. */
  onToggleMute?: () => void;
  muted?: boolean;
  /** "Asha took this one" and similar, shown briefly before the card leaves. */
  resolution?: string | null;
}

/**
 * The stripe, and why the timer is never left to it alone.
 *
 * `--color-danger` on a 3px rule is the only difference between "arrived" and
 * "about to leave", and roughly one operator in twelve cannot see it. The wait
 * is printed beside the eyebrow at every band for that reason, not as a detail.
 */
const STRIPE: Record<ReturnType<typeof ageBand>, string> = {
  fresh: 'bg-accent-500',
  ageing: 'bg-warning',
  overdue: 'bg-danger',
};

const DOT: Record<ReturnType<typeof ageBand>, string> = {
  fresh: 'bg-accent-500',
  ageing: 'bg-warning',
  overdue: 'bg-danger',
};

export function LobbyCard({
  alert,
  now,
  busy = false,
  onTake,
  onOpenInbox,
  onDismiss,
  onToggleMute,
  muted = false,
  resolution = null,
}: LobbyCardProps) {
  const { t } = useTranslation();
  const waited = waitedMs(alert, now);
  // A held chat never turns red. Its visitor already knows somebody is there,
  // so ageing it the same way would spend the loudest signal this stack has on
  // the less urgent of the two events. Neither does a card with no start time:
  // an unknown wait is not an urgent one.
  const band = alert.kind === 'waiting' && waited !== null ? ageBand(waited) : 'fresh';
  const visitorName = alert.name || (t('shell.lobbyVisitor') || 'Visitor');

  const heading =
    alert.kind === 'waiting'
      ? t('shell.lobbyWaitingForAPerson') || 'Waiting for a person'
      : t('shell.lobbyMessageInYourChat') || 'Message in your chat';

  return (
    <div
      data-lobby-card
      data-band={band}
      // `role="status"` and not `alert`: an alert interrupts a screen reader
      // mid-sentence, and this arrives while the operator may be reading or
      // typing something else. Polite is the right register for "somebody is
      // here", and the card does not go away on its own.
      role="status"
      className={cn(
        'pointer-events-auto w-80 overflow-hidden rounded-lg border bg-surface shadow-md',
        // The token layer clears Tailwind's default ramps, so there is no
        // `danger-200` to reach for: the status hues are one value each. On a
        // 1px edge the full-strength colour is the subtle option anyway.
        band === 'overdue' ? 'border-danger' : band === 'ageing' ? 'border-warning' : 'border-border',
      )}
    >
      <div aria-hidden className={cn('h-[3px]', alert.kind === 'waiting' ? STRIPE[band] : 'bg-border-strong')} />

      <div className="p-3.5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', alert.kind === 'waiting' ? DOT[band] : 'bg-text-tertiary')}
          />
          <p className="min-w-0 flex-1 truncate font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
            {heading}
            {/* The number whenever there is one to print. See `STRIPE`: the
                stripe must never be the only thing carrying the urgency. A card
                whose payload had no timestamp says nothing rather than "0s". */}
            {waited !== null ? (
              <>
                {' · '}
                <span className="figure normal-case tracking-normal">{waitWords(waited)}</span>
              </>
            ) : null}
          </p>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t('shell.lobbyDismissFor', { name: visitorName }) || `Dismiss ${visitorName}`}
            className="-me-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <Avatar size="sm" name={visitorName} className="shrink-0" />
          <span className="min-w-0">
            <span className="block truncate text-prose font-semibold leading-tight text-text-primary">
              {visitorName}
            </span>
            {alert.detail ? (
              <span className="block truncate text-2xs text-text-secondary">{alert.detail}</span>
            ) : null}
          </span>
        </div>

        {alert.preview ? (
          <p className="mt-2 line-clamp-2 text-xs text-text-secondary">{alert.preview}</p>
        ) : null}

        {resolution ? (
          // The card does not vanish the instant a colleague takes the visitor.
          // An operator whose pointer is already travelling toward "Take it"
          // would land on whatever slid up into the gap.
          <p className="mt-3 text-xs text-text-secondary">{resolution}</p>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" className="flex-1" onClick={onTake} loading={busy} disabled={busy}>
              {alert.kind === 'waiting'
                ? t('shell.lobbyTakeIt') || 'Take it'
                : t('shell.lobbyReply') || 'Reply'}
            </Button>
            <Button size="sm" variant="secondary" className="flex-1" onClick={onOpenInbox} disabled={busy}>
              {t('shell.lobbyOpenInbox') || 'Open inbox'}
            </Button>
            {onToggleMute ? (
              <Button
                size="icon-sm"
                variant="secondary"
                onClick={onToggleMute}
                aria-pressed={muted}
                aria-label={
                  muted
                    ? t('shell.lobbyUnmuteAlerts') || 'Unmute alert sound'
                    : t('shell.lobbyMuteAlerts') || 'Mute alert sound'
                }
              >
                {muted ? <BellOff aria-hidden /> : <Bell aria-hidden />}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
