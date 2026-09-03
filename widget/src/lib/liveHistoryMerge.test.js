import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRestoredLiveMessages } from './liveHistoryMerge.js';

test('returns the restored rows when nothing is in memory', () => {
    const restored = [{ id: 'srv-1', dbId: 1, timestamp: '2026-09-02T10:00:00Z' }];
    assert.deepEqual(mergeRestoredLiveMessages([], restored), restored);
    assert.deepEqual(mergeRestoredLiveMessages(null, restored), restored);
});

test('does not re-append a message already acked with the same db id', () => {
    // The local copy carries the client clock; the restored row carries the
    // later server clock. Timestamp alone would append it again.
    const prev = [{
        id: 'live-1',
        dbId: 42,
        sender: 'user',
        timestamp: '2026-09-02T10:00:00.000Z',
        status: 'delivered',
    }];
    const restored = [{
        id: 'srv-42',
        dbId: 42,
        sender: 'user',
        timestamp: '2026-09-02T10:00:00.900Z',
    }];
    assert.deepEqual(mergeRestoredLiveMessages(prev, restored), prev);
});

test('does not re-append a restored row already merged under the same id', () => {
    const prev = [{ id: 'srv-7', timestamp: '2026-09-02T10:00:00Z' }];
    const restored = [{ id: 'srv-7', timestamp: '2026-09-02T10:00:05Z' }];
    assert.deepEqual(mergeRestoredLiveMessages(prev, restored), prev);
});

test('appends genuinely new operator messages missed while the socket was down', () => {
    const prev = [{ id: 'live-1', dbId: 42, timestamp: '2026-09-02T10:00:00.000Z' }];
    const restored = [
        { id: 'srv-42', dbId: 42, timestamp: '2026-09-02T10:00:00.900Z' },
        { id: 'srv-43', dbId: 43, timestamp: '2026-09-02T10:01:00.000Z', sender: 'operator' },
    ];
    const merged = mergeRestoredLiveMessages(prev, restored);
    assert.equal(merged.length, 2);
    assert.equal(merged[1].id, 'srv-43');
});

test('keeps local state on existing entries instead of replacing them', () => {
    const prev = [{ id: 'live-1', dbId: 9, status: 'failed', timestamp: '2026-09-02T10:00:00Z' }];
    const merged = mergeRestoredLiveMessages(prev, [{ id: 'srv-9', dbId: 9, status: 'delivered', timestamp: '2026-09-02T10:00:02Z' }]);
    assert.equal(merged[0].status, 'failed');
});

test('falls back to the timestamp rule when no ids are known', () => {
    const prev = [{ id: 'live-1', timestamp: '2026-09-02T10:00:00Z' }];
    const restored = [
        { id: 'restored-a', timestamp: '2026-09-02T09:59:00Z' },
        { id: 'restored-b', timestamp: '2026-09-02T10:05:00Z' },
    ];
    const merged = mergeRestoredLiveMessages(prev, restored);
    assert.deepEqual(merged.map((m) => m.id), ['live-1', 'restored-b']);
});
