import test from 'node:test';
import assert from 'node:assert/strict';

import {
    FULL_PROBE_DELAYS_MS,
    QUOTE_EXTRACTION_WINDOW_MS,
    SINGLE_PROBE_DELAYS_MS,
    quotationProbeSchedule,
} from './quotationProbe.js';

const NOW = 1_700_000_000_000;

test('no answer has streamed yet: one immediate poll, nothing to outwait', () => {
    // "Talk to a human" from the welcome screen. Nothing was sent, so no BANT
    // extraction can be pending; the old unconditional series cost a phone
    // visitor about ten seconds here.
    const { delays, deadline } = quotationProbeSchedule({ probedBefore: false, lastStreamClosedAt: 0, now: NOW });
    assert.deepEqual([...delays], [...SINGLE_PROBE_DELAYS_MS]);
    assert.equal(deadline, NOW);
});

test('a stream just closed: the full series, bounded by the extraction window', () => {
    const closedAt = NOW - 600; // the 600ms handoff delay after suggest_handoff
    const { delays, deadline } = quotationProbeSchedule({ probedBefore: false, lastStreamClosedAt: closedAt, now: NOW });
    assert.deepEqual([...delays], [...FULL_PROBE_DELAYS_MS]);
    assert.equal(deadline, closedAt + QUOTE_EXTRACTION_WINDOW_MS);
});

test('the last stream closed long ago: extraction is done, one poll', () => {
    const closedAt = NOW - QUOTE_EXTRACTION_WINDOW_MS - 1;
    const { delays, deadline } = quotationProbeSchedule({ probedBefore: false, lastStreamClosedAt: closedAt, now: NOW });
    assert.deepEqual([...delays], [...SINGLE_PROBE_DELAYS_MS]);
    assert.equal(deadline, NOW);
});

test('a full series already ran this lifetime: later probes stay single', () => {
    const { delays } = quotationProbeSchedule({ probedBefore: true, lastStreamClosedAt: NOW - 100, now: NOW });
    assert.deepEqual([...delays], [...SINGLE_PROBE_DELAYS_MS]);
});

test('the window is wider than the slowest measured extraction', () => {
    // 4.0s was the slowest sample; a 2s cap was tried and missed the quote.
    assert.ok(QUOTE_EXTRACTION_WINDOW_MS > 4000);
});
