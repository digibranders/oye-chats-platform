import { describe, expect, it } from 'vitest';
import { mergeHistoryWithLive } from './liveChatHelpers';
import type { OperatorMessage } from './liveChatProtocol';

const message = (over: Partial<OperatorMessage> = {}): OperatorMessage => ({
  key: 'k',
  dbId: null,
  role: 'operator',
  content: 'Hello there',
  timestamp: '2026-09-02T10:00:00.000Z',
  ...over,
});

describe('mergeHistoryWithLive', () => {
  it('returns history untouched when there is nothing live', () => {
    const history = [message({ key: 'srv-1', dbId: 1 })];
    expect(mergeHistoryWithLive(history, undefined)).toBe(history);
    expect(mergeHistoryWithLive(history, [])).toBe(history);
  });

  it('drops a persisted duplicate by dbId', () => {
    const history = [message({ key: 'srv-1', dbId: 1 })];
    const live = [message({ key: 'ws-1', dbId: 1 })];
    expect(mergeHistoryWithLive(history, live)).toEqual(history);
  });

  it('drops the operator echo the reloaded history already contains', () => {
    const history = [message({ key: 'srv-7', dbId: 7, timestamp: '2026-09-02T10:00:02.000Z' })];
    const live = [message({ key: 'local-1' })];
    expect(mergeHistoryWithLive(history, live)).toEqual(history);
  });

  it('keeps an echo whose persisted row has not arrived yet', () => {
    const history = [message({ key: 'srv-7', dbId: 7, content: 'Something else' })];
    const live = [message({ key: 'local-1' })];
    expect(mergeHistoryWithLive(history, live)).toHaveLength(2);
  });

  it('keeps an echo that is too far from the persisted row to be the same send', () => {
    const history = [message({ key: 'srv-7', dbId: 7, timestamp: '2026-09-02T09:30:00.000Z' })];
    const live = [message({ key: 'local-1' })];
    expect(mergeHistoryWithLive(history, live)).toHaveLength(2);
  });

  it('does not let one persisted row absorb two identical echoes', () => {
    const history = [message({ key: 'srv-7', dbId: 7 })];
    const live = [message({ key: 'local-1' }), message({ key: 'local-2' })];
    const merged = mergeHistoryWithLive(history, live);
    expect(merged).toHaveLength(2);
    expect(merged[1].key).toBe('local-2');
  });

  it('does not match an echo against a message from another role', () => {
    const history = [message({ key: 'srv-7', dbId: 7, role: 'user' })];
    const live = [message({ key: 'local-1' })];
    expect(mergeHistoryWithLive(history, live)).toHaveLength(2);
  });
});
