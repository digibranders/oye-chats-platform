/**
 * When, and how often, to ask the server whether the quote card should open.
 *
 * The pre-handoff quotation flow activates once BANT extraction has marked
 * enough dimensions. Extraction is an LLM call the backend runs AFTER the
 * answer stream closes (measured 2.5s to 4.0s), so a probe fired the moment
 * the stream ends can be a turn behind. The widget bridges that with a short
 * series of polls spaced out to outlast the extraction.
 *
 * That series is only worth running while extraction can actually be in
 * flight. Before this module existed the full series ran unconditionally in
 * front of every handoff form: a visitor who tapped "Talk to a human" from the
 * welcome screen, with no message sent and nothing to extract, still waited
 * through five serial requests and 4.5s of spacing (about ten seconds on a
 * phone) before the form appeared. The schedule below keys off the moment the
 * last answer stream closed instead.
 */

/**
 * How long after an answer stream closes BANT extraction may still be running.
 * Above the slowest measured extraction (about 4.0s) with headroom; the poll
 * never extends past this point.
 */
export const QUOTE_EXTRACTION_WINDOW_MS = 4500;

/** Spacing (ms) between polls while extraction may be in flight. */
export const FULL_PROBE_DELAYS_MS = Object.freeze([0, 700, 1000, 1300, 1500]);

/** A single immediate poll. */
export const SINGLE_PROBE_DELAYS_MS = Object.freeze([0]);

/**
 * Decide the poll schedule for one probe.
 *
 * @param {object} args
 * @param {boolean} args.probedBefore   a full series already ran this widget lifetime
 * @param {number} args.lastStreamClosedAt  epoch ms when the last answer stream closed,
 *   0 when no answer has streamed this lifetime
 * @param {number} args.now             epoch ms
 * @returns {{ delays: readonly number[], deadline: number }} `delays` are the
 *   gaps to wait before each poll; `deadline` is the epoch ms past which no
 *   further poll should start.
 */
export function quotationProbeSchedule({ probedBefore, lastStreamClosedAt, now }) {
    if (probedBefore || !lastStreamClosedAt) {
        return { delays: SINGLE_PROBE_DELAYS_MS, deadline: now };
    }
    const deadline = lastStreamClosedAt + QUOTE_EXTRACTION_WINDOW_MS;
    if (now >= deadline) {
        return { delays: SINGLE_PROBE_DELAYS_MS, deadline: now };
    }
    return { delays: FULL_PROBE_DELAYS_MS, deadline };
}
