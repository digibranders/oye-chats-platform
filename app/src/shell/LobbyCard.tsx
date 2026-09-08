import { Bell, BellOff, X } from "lucide-react";
import { Avatar, Button, cn } from "../ui";
import {
  ageBand,
  waitWords,
  waitedMs,
  type LobbyAlert,
  type LobbyBand,
} from "./lobbyModel";
import { useTranslation } from "../i18n/useTranslation";

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
 * **The wait is the signal; the card is the alarm.** An earlier version carried
 * a 3px accent bar across its top, an uppercase mono eyebrow, and two outlined
 * buttons of equal width. The bar was decoration doing information's job: it
 * said "urgent" without saying how urgent, and the number underneath already
 * did. The urgency still rides on the wait itself, set as a plain tabular
 * figure in the band's own colour: because it always spells the duration out,
 * colour is never left working alone.
 *
 * What that version got wrong was PRESENCE. A white card with a hairline is a
 * fine way to render a fact, and a poor way to interrupt somebody who is deep
 * in the quotation editor — which is the entire job here. So the whole surface
 * now carries the band: it arrives tinted and bordered in the accent, warms to
 * amber, then to danger, and a pulse beside the name says the visitor is still
 * unanswered. The colour is not decoration, it is the same escalation the badge
 * states in words, made large enough to catch an eye that is looking somewhere
 * else. It also enters with a short slide, because a thing that was not there a
 * moment ago is the cheapest attention there is.
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
 * The card's own ground, by band.
 *
 * Tinted from the first second rather than only once a wait turns bad. A
 * visitor who has just arrived is not an emergency, but the card still has to
 * be seen, and accent is the console's "this concerns you" colour rather than a
 * severity. Amber then means what it always means.
 *
 * `overdue` inverts instead of tinting, and the border thickens a step before
 * it. Three minutes is past the point where the widget's own "someone will be
 * with you shortly" is still true, and a card that has to be caught by an
 * operator looking somewhere else needs more than a warmer wash of the same
 * idea. The inversion is reserved for this one band on purpose: a stack where
 * every card is solid colour has no step left to take, which is how the first
 * version of this ended up needing a redesign.
 */
const SURFACE: Record<LobbyBand, string> = {
  fresh: "border-accent-500 bg-accent-50",
  ageing: "border-2 border-warning bg-warning-tint",
  overdue: "border-2 border-danger-fill bg-danger-fill",
};

/**
 * The wait's colour.
 *
 * A plain figure, not a `Badge`. `Badge` maps `warning` to `bg-warning-tint`
 * and `danger` to `bg-danger-tint` — the exact colours the ageing and overdue
 * cards use as their GROUND — so the number was the same colour as the card it
 * sat on, on the two cards that most needed it read. No tone in the system
 * fixes that: `Badge` assumes a neutral surface. Worse, `fresh` mapped to
 * `ink`, the one solid tone, so the calmest state had the loudest chip and the
 * most urgent had the quietest.
 *
 * Colour still never works alone here: the duration is always spelled out.
 */
const FIGURE: Record<LobbyBand, string> = {
  fresh: "text-accent-700",
  ageing: "text-warning",
  overdue: "text-text-inverse",
};

/** Every ink that has to survive the inverted ground at `overdue`. */
const INK: Record<LobbyBand, { title: string; body: string; dismiss: string }> =
  {
    fresh: {
      title: "text-text-primary",
      body: "text-text-secondary",
      dismiss: "text-text-tertiary",
    },
    ageing: {
      title: "text-text-primary",
      body: "text-text-secondary",
      dismiss: "text-text-tertiary",
    },
    overdue: {
      // Full strength, all of it, and `scale.test.ts` already bans the
      // alternative: measured on this card, white at 85% over `danger-fill`
      // comes out at 3.19:1 on the 11px context line, which fails AA outright.
      // The dimming that reads as gentle hierarchy on a light ground is
      // unaffordable on this one, so the hierarchy comes from size and weight.
      title: "text-text-inverse",
      body: "text-text-inverse",
      dismiss: "text-text-inverse",
    },
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
  const band =
    alert.kind === "waiting" && waited !== null ? ageBand(waited) : "fresh";
  const visitorName = alert.name || t("shell.lobbyVisitor") || "Visitor";

  // The state sits on the context line rather than in an eyebrow above the
  // name: 11px uppercase mono across the top of a 320px card is a lot of
  // furniture for something a subtitle carries in passing.
  // A re-queued visitor has already been let down once. The clock restarted
  // when they re-entered the queue, and that IS the honest answer to "how long
  // has this person been ignored right now", so the fact that they have been
  // here before is said in words rather than smuggled into the timer.
  const requeued =
    alert.requeueReason === "operator_dropped"
      ? t("shell.lobbyOperatorDropped") || "Operator dropped · waiting again"
      : alert.requeueReason === "transfer"
        ? t("shell.lobbyTransferred") || "Transferred · waiting again"
        : null;
  const state =
    alert.kind === "waiting"
      ? requeued || t("shell.lobbyWaitingForAPerson") || "Waiting for a person"
      : t("shell.lobbyMessageInYourChat") || "Message in your chat";
  const context = [alert.detail, state].filter(Boolean).join(" · ");

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
        // `shadow-md`, not `lg`: DESIGN.md reserves `lg` for modals and
        // drawers. The tint and the border are what make this card carry.
        "motion-arrive pointer-events-auto w-80 rounded-lg border p-3.5 shadow-md",
        SURFACE[band],
      )}
    >
      {/* The name shares its line with the wait and the dismiss; the context
          gets a line of its own. Nested under the name, the two controls took
          about 110px of a 320px card and truncated the subtitle to
          "Eventussecurity · Waiting for ...", which is where the useful half
          of that sentence lives.

          No pulsing dot here, though it was the obvious reach. `StatusDot`
          reserves the pulse for state that is live right now and warns that one
          which never stops stops meaning anything — and its tone union has no
          accent, so a fresh card would have had to borrow grey or amber and lie
          about severity. The tint, the border and the arrival carry the
          attention instead. */}
      <div className="flex items-start gap-2.5">
        <Avatar size="sm" name={visitorName} className="mt-0.5 shrink-0" />
        <p
          className={cn(
            "min-w-0 flex-1 truncate text-prose font-semibold leading-tight",
            INK[band].title,
          )}
        >
          {visitorName}
        </p>
        {/* The number, always, whatever the tone. A card whose payload carried
            no timestamp shows nothing rather than "0s": an invented duration is
            worse than an absent one. */}
        {waited !== null ? (
          <span
            className={cn(
              "figure mt-px shrink-0 text-sm font-semibold tabular-nums",
              FIGURE[band],
            )}
          >
            {waitWords(waited)}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={
            t("shell.lobbyDismissFor", { name: visitorName }) ||
            `Dismiss ${visitorName}`
          }
          className={cn(
            "-me-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-xs",
            INK[band].dismiss,
            band === "overdue"
              ? "hover:bg-surface/15 hover:text-text-inverse"
              : "hover:bg-surface-hover hover:text-text-primary",
          )}
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className={cn("mt-1 truncate text-2xs", INK[band].body)}>{context}</p>

      {/* What they said, which is most of how an operator decides who to take
          first. It was cut from the first version to make room for the bar. */}
      {alert.preview ? (
        <p className={cn("mt-2 line-clamp-2 text-xs", INK[band].body)}>
          {alert.preview}
        </p>
      ) : null}

      {resolution ? (
        // The card does not vanish the instant a colleague takes the visitor.
        // An operator whose pointer is already travelling toward "Take it"
        // would land on whatever slid up into the gap.
        <p className={cn("mt-3 text-xs", INK[band].body)}>{resolution}</p>
      ) : (
        <div className="mt-3 flex items-center gap-1">
          {/* One filled button. Two outlined ones of equal width made the
              operator choose between two things of equal weight: taking the
              conversation is the action, the inbox is a way out, and the mute
              is a preference. */}
          {/* On the inverted card a near-black `primary` is the one thing that
              does NOT read against a solid danger ground, so it flips to white
              on red. Everywhere else it stays the console's primary. */}
          <Button
            size="sm"
            variant={band === "overdue" ? "secondary" : "primary"}
            className={
              band === "overdue"
                ? "border-transparent bg-surface text-danger hover:bg-surface/90"
                : undefined
            }
            onClick={onTake}
            loading={busy}
            disabled={busy}
          >
            {alert.kind === "waiting"
              ? t("shell.lobbyTakeIt") || "Take it"
              : t("shell.lobbyReply") || "Reply"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={
              band === "overdue"
                ? "text-text-inverse hover:bg-surface/15 hover:text-text-inverse"
                : undefined
            }
            onClick={onOpenInbox}
            disabled={busy}
          >
            {t("shell.lobbyOpenInbox") || "Open inbox"}
          </Button>
          {onToggleMute ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className={cn(
                "ms-auto",
                band === "overdue" &&
                  "text-text-inverse hover:bg-surface/15 hover:text-text-inverse",
              )}
              onClick={onToggleMute}
              aria-pressed={muted}
              aria-label={
                muted
                  ? t("shell.lobbyUnmuteAlerts") || "Unmute alert sound"
                  : t("shell.lobbyMuteAlerts") || "Mute alert sound"
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
