// Bounded polling driver. Extracted so the stop conditions are unit-tested
// independently of the React effect that uses them (see boundedPoll.test.js).

/**
 * Run `tick` every `intervalMs` until it reports success, `maxTicks` ticks have
 * elapsed, or the caller stops it — whichever comes first.
 *
 * The bound is the point. A poll whose only exit is a dependency change is a
 * poll that never exits when nothing changes: the offline-form availability
 * probe re-fired the entire operator handoff fan-out (a push, an email per
 * recipient, a bell row) every 15 seconds for as long as one visitor left a tab
 * open, because the state it waited on was exactly the state it preserved.
 *
 * `tick` may be async; a truthy resolution means "done, stop polling". A
 * rejection is treated as "not done" — a transient probe failure should be
 * retried, not treated as an answer — but still spends a tick, so a permanently
 * failing probe stops at the bound like any other.
 *
 * @param {object} options
 * @param {() => (boolean | Promise<boolean>)} options.tick   one probe.
 * @param {number} options.intervalMs                          gap between probes.
 * @param {number} options.maxTicks                            hard ceiling on probes.
 * @param {{setInterval: Function, clearInterval: Function}} [options.timers]
 *        Injectable for tests; defaults to the ambient timers.
 * @returns {() => void} stop — idempotent, safe to call from effect cleanup.
 */
export function startBoundedPoll({ tick, intervalMs, maxTicks, timers = globalThis }) {
    let ticks = 0;
    let stopped = false;
    let handle = null;

    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (handle !== null) timers.clearInterval(handle);
        handle = null;
    };

    handle = timers.setInterval(async () => {
        if (stopped) return;
        ticks += 1;
        let done = false;
        try {
            done = await tick();
        } catch {
            done = false;
        }
        // The caller may have stopped us while `tick` was in flight.
        if (stopped) return;
        if (done || ticks >= maxTicks) stop();
    }, intervalMs);

    return stop;
}
