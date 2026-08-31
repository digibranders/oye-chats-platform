import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActivityStats, httpClient, readerTimeZone } from './api';

/**
 * `/analytics/activity` must be asked in the reader's own timezone.
 *
 * The endpoint cuts its day buckets in the zone it is given and the client
 * reads every `date` key back as a LOCAL date. Sending no zone means the
 * buckets are cut in UTC and read in Asia/Kolkata, which files every message an
 * IST visitor sent between 00:00 and 05:30 under the previous day — the
 * month-edge off-by-one, present on every chart the series feeds.
 *
 * Asserted against the URL rather than against a mocked module, because the
 * query string is the contract: a call site that passes an option the client
 * then drops would satisfy any assertion made one layer higher.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function capture() {
  return vi.spyOn(httpClient, 'get').mockResolvedValue({ data: [] });
}

describe('getActivityStats', () => {
  it('sends the reader’s IANA zone so day buckets are cut on their midnight', async () => {
    const get = capture();
    await getActivityStats(7);

    const url = String(get.mock.calls[0]?.[0]);
    expect(url).toContain('tz=');
    const tz = new URLSearchParams(url.split('?')[1]).get('tz');
    expect(tz).toBe(readerTimeZone());
    // Whatever the runtime resolves to, it is a real zone name, never blank.
    expect(tz).toBeTruthy();
  });

  it('bounds the aggregate when the caller names a window', async () => {
    const get = capture();
    await getActivityStats(7, { days: 60 });

    const params = new URLSearchParams(String(get.mock.calls[0]?.[0]).split('?')[1]);
    expect(params.get('days')).toBe('60');
    expect(params.get('bot_id')).toBe('7');
  });

  it('omits days entirely when the caller wants all of history', async () => {
    const get = capture();
    await getActivityStats(undefined, { days: null });

    const params = new URLSearchParams(String(get.mock.calls[0]?.[0]).split('?')[1]);
    expect(params.has('days')).toBe(false);
    expect(params.has('bot_id')).toBe(false);
    expect(params.get('tz')).toBeTruthy();
  });
});
