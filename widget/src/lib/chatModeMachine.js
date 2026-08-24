/**
 * The widget's chat-mode state machine.
 *
 * Extracted from ChatWindow so it can be tested. It used to be a module-private
 * const inside a 3000-line component, which is why a missing transition sat
 * there unnoticed: the only way to exercise it was to drive a real browser
 * through a timing race.
 *
 * The modes:
 *   bot          the AI conversation (the default)
 *   connecting   the brief "checking with our team" state after a handoff
 *                submission, while the resolver re-checks operator availability
 *   waiting      queued for an operator
 *   live         an operator is connected
 *   unavailable  no operator available; the compact offline-message form
 */

/**
 * Allowed transitions, keyed by current mode.
 *
 * `→ live` is reachable from EVERY non-terminal state, and deliberately so. A
 * `status: connected` frame is not a client-side guess: it means the server has
 * already moved the session to `live` in the database and assigned an operator
 * who is now sitting in the console waiting for a reply. Refusing that
 * transition does not keep the widget consistent, it desynchronises it from the
 * server.
 *
 * The gap that made this concrete: an operator accepting a chat AFTER the queue
 * timeout (`live_chat_queue_timeout_seconds`, 20s by default) had already
 * pushed the visitor to `unavailable`. The visitor saw the "Leave a message"
 * offline form, then watched "<operator> joined the chat" render above it, and
 * had no composer to answer with, because `unavailable` only allowed `bot`. The
 * same race exists in `connecting`, where a fast accept can land inside the
 * ~10s availability re-check.
 *
 * `bot → live` covers the operator-initiated connect-request consent flow:
 * the operator clicks Connect in the dashboard, the visitor accepts the popup,
 * and the session promotes to live chat without ever queueing.
 *
 * `bot → unavailable` covers the "Leave a message" CTA (the header menu option
 * and the inline [LEAVE_MESSAGE_CARD]) that drops the visitor straight from the
 * AI chat into the offline form without a live-chat handoff first.
 */
export const VALID_TRANSITIONS = {
    bot: ['waiting', 'unavailable', 'connecting', 'live'],
    connecting: ['waiting', 'unavailable', 'bot', 'live'],
    waiting: ['live', 'bot', 'unavailable'],
    live: ['bot', 'unavailable'],
    unavailable: ['bot', 'live'],
};

/** Every mode the machine knows about. */
export const CHAT_MODES = Object.keys(VALID_TRANSITIONS);

/**
 * Resolve the next chat mode.
 *
 * Returns `prev` unchanged when the transition is not allowed, so the caller
 * can use it directly as a `setState` updater. Self-transitions are treated as
 * no-ops rather than rejections: re-delivering the same status (a reconnect
 * replaying state, say) is normal and must not log noise.
 *
 * @param {string} prev current mode
 * @param {string} next requested mode
 * @returns {string} the mode to apply
 */
export function nextChatMode(prev, next) {
    if (prev === next) return prev;
    const allowed = VALID_TRANSITIONS[prev];
    return allowed && allowed.includes(next) ? next : prev;
}

/**
 * True when a transition would be rejected, so the caller can log it.
 * A self-transition is not "invalid", just uneventful.
 */
export function isInvalidTransition(prev, next) {
    if (prev === next) return false;
    const allowed = VALID_TRANSITIONS[prev];
    return !(allowed && allowed.includes(next));
}
