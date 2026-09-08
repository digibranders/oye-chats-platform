import { Bell, BellOff, X } from 'lucide-react';
import { Avatar, Badge, Button, cn, type BadgeTone } from '../ui';
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
 *
 * **The wait is the whole signal.** The first version carried a 3px accent bar
 * across its top, an uppercase mono eyebrow, and two outlined buttons of equal
 * width. The bar was decoration doing information's job: it said "urgent"
 * without saying how urgent, and the number underneath already did. The urgency
 * now rides on the wait itself as a `Badge` — the design system's own component
 * for a short state, which brings its own tabular figures and, because it
 * always carries a word, never leaves colour working alone.
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

/** The wait's tone. The badge's own word is what a reader who cannot separate
 *  the amber from the red is left with, which is why it is a number. */
const TONE: Record<ReturnType<typeof ageBand>, BadgeTone> = {
  fresh: 'neutral',
  ageing: 'warning',
  overdue: 'danger',
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
  // A held chat never reddens. Its visitor already knows somebody is there, so
  // ageing it the same way would spend the loudest signal in the stack on the
  // less urgent of the two events. Neither does a card with no start time: an
  // unknown wait is not an urgent one.
  const band = alert.kind === 'waiting' && waited !== null ? ageBand(waited) : 'fresh';
  const visitorName = alert.name || (t('shell.lobbyVisitor') || 'Visitor');

  // The state sits on the context line rather than in an eyebrow above the
  // name: 11px uppercase mono across the top of a 320px card is a lot of
  // furniture for something a subtitle carries in passing.
  const state =
    alert.kind === 'waiting'
      ? t('shell.lobbyWaitingForAPerson') || 'Waiting for a person'
      : t('shell.lobbyMessageInYourChat') || 'Message in your chat';
  const context = [alert.detail, state].filter(Boolean).join(' · ');

  return (
    <div
      data-lobby-card
      data-band={band}
      // `role="status"` and not `alert`: an alert interrupts a screen reader
      // mid-sentence, and this arrives while the operator may be reading or
      // typing something else. Polite is the right register for "somebody is
      // here", and the card does not go away on its own.
      role="status"
      className="pointer-events-auto w-80 rounded-lg border border-border bg-surface p-3.5 shadow-md"
    >
      <div className="flex items-start gap-2.5">
        <Avatar size="sm" name={visitorName} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-prose font-semibold leading-tight text-text-primary">
            {visitorName}
          </p>
          <p className="truncate text-2xs text-text-secondary">{context}</p>
        </div>
        {/* The number, always, whatever the tone. A card whose payload carried
            no timestamp shows nothing rather than "0s": an invented duration is
            worse than an absent one. */}
        {waited !== null ? (
          <Badge tone={TONE[band]} className="figure mt-px shrink-0">
            {waitWords(waited)}
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('shell.lobbyDismissFor', { name: visitorName }) || `Dismiss ${visitorName}`}
          className={cn(
            '-me-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-xs',
            'text-text-tertiary hover:bg-surface-hover hover:text-text-primary',
          )}
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* What they said, which is most of how an operator decides who to take
          first. It was cut from the first version to make room for the bar. */}
      {alert.preview ? (
        <p className="mt-2 line-clamp-2 text-xs text-text-secondary">{alert.preview}</p>
      ) : null}

      {resolution ? (
        // The card does not vanish the instant a colleague takes the visitor.
        // An operator whose pointer is already travelling toward "Take it"
        // would land on whatever slid up into the gap.
        <p className="mt-3 text-xs text-text-secondary">{resolution}</p>
      ) : (
        <div className="mt-3 flex items-center gap-1">
          {/* One filled button. Two outlined ones of equal width made the
              operator choose between two things of equal weight: taking the
              conversation is the action, the inbox is a way out, and the mute
              is a preference. */}
          <Button size="sm" variant="primary" onClick={onTake} loading={busy} disabled={busy}>
            {alert.kind === 'waiting'
              ? t('shell.lobbyTakeIt') || 'Take it'
              : t('shell.lobbyReply') || 'Reply'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenInbox} disabled={busy}>
            {t('shell.lobbyOpenInbox') || 'Open inbox'}
          </Button>
          {onToggleMute ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="ms-auto"
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
  );
}
