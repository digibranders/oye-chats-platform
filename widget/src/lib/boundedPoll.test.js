import test from 'node:test';
import assert from 'node:assert/strict';

import { startBoundedPoll } from './boundedPoll.js';

// A minimal manual interval clock. Real timers would make these tests slow and
// flaky; what is under test is the stop conditions, not the scheduler.
function fakeTimers() {
    let next = 1;
    const jobs = new Map();
    return {
        timers: {
            setInterval(fn) {
                const id = next++;
                jobs.set(id, fn);
                return id;
            },
            clearInterval(id) {
                jobs.delete(id);
            },
        },
        get live() {
            return jobs.size;
        },
        async advance(times = 1) {
            for (let i = 0; i < times; i += 1) {
                // Copy: a job may clear itself while we iterate.
                for (const fn of [...jobs.values()]) await fn();
            }
        },
    };
}

// ── W4: the offline-form re-poll that never stopped ──────────────────────────

test('a probe that answers stops the poll', async () => {
    // The regression, in one line. The offline-form availability probe re-fired
    // the whole operator handoff fan-out (push + an email per recipient + a
    // bell row) every 15s. Nothing cleared it: the state it waited on was the
    // state its own success handler preserved, so the effect's deps never
    // changed. One visitor with a tab open generated that fan-out forever.
    const clock = fakeTimers();
    let probes = 0;
    startBoundedPoll({
        tick: () => {
            probes += 1;
            return probes >= 2; // second probe sees the operator come online
        },
        intervalMs: 15000,
        maxTicks: 40,
        timers: clock.timers,
    });

    await clock.advance(10);
    assert.equal(probes, 2, 'polling must stop on the tick that answers');
    assert.equal(clock.live, 0, 'the interval must actually be cleared');
});

test('a probe that never answers is still bounded', async () => {
    const clock = fakeTimers();
    let probes = 0;
    startBoundedPoll({
        tick: () => { probes += 1; return false; },
        intervalMs: 15000,
        maxTicks: 40,
        timers: clock.timers,
    });

    await clock.advance(500);
    assert.equal(probes, 40, 'the ceiling is the ceiling regardless of the answer');
    assert.equal(clock.live, 0);
});

test('a failing probe is retried, not treated as an answer — but still spends its budget', async () => {
    const clock = fakeTimers();
    let probes = 0;
    startBoundedPoll({
        tick: () => { probes += 1; throw new Error('network'); },
        intervalMs: 15000,
        maxTicks: 3,
        timers: clock.timers,
    });

    await clock.advance(20);
    assert.equal(probes, 3);
    assert.equal(clock.live, 0);
});

test('an async probe is awaited before the next tick is counted', async () => {
    const clock = fakeTimers();
    const seen = [];
    startBoundedPoll({
        tick: async () => {
            seen.push('start');
            await Promise.resolve();
            seen.push('end');
            return seen.length >= 4;
        },
        intervalMs: 15000,
        maxTicks: 40,
        timers: clock.timers,
    });

    await clock.advance(5);
    assert.deepEqual(seen, ['start', 'end', 'start', 'end']);
});

test('the returned stop is idempotent and safe from effect cleanup', async () => {
    const clock = fakeTimers();
    let probes = 0;
    const stop = startBoundedPoll({
        tick: () => { probes += 1; return false; },
        intervalMs: 15000,
        maxTicks: 40,
        timers: clock.timers,
    });

    stop();
    stop();
    await clock.advance(5);
    assert.equal(probes, 0);
    assert.equal(clock.live, 0);
});

test('a stop during an in-flight probe does not resurrect the timer', async () => {
    const clock = fakeTimers();
    let resolveProbe;
    let probes = 0;
    const stop = startBoundedPoll({
        tick: () => {
            probes += 1;
            return new Promise((resolve) => { resolveProbe = resolve; });
        },
        intervalMs: 15000,
        maxTicks: 40,
        timers: clock.timers,
    });

    const inFlight = clock.advance(1);
    stop();
    resolveProbe(true);
    await inFlight;

    assert.equal(probes, 1);
    assert.equal(clock.live, 0);
});
