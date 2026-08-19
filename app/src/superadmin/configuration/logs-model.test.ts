import { describe, expect, it } from 'vitest';
import {
  LOG_SERVICES,
  coerceGrep,
  coerceLevel,
  coerceLines,
  coerceService,
  isAllowedService,
  levelCounts,
  logsAsText,
  logsParams,
} from './logs-model';
import type { LogsResponse } from './types';

const response: LogsResponse = {
  available: true,
  service: 'oyechats-api',
  entries: [
    { timestamp: '2026-08-19T10:00:00Z', level: 'error', message: 'Traceback: boom', unit: 'x', pid: 1234 },
    { timestamp: '2026-08-19T10:00:01Z', level: 'info', message: 'started', unit: 'x', pid: 1234 },
    { timestamp: null, level: 'info', message: 'no stamp', unit: null, pid: null },
  ],
};

describe('the service allow-list', () => {
  it('offers exactly the two units the server permits', () => {
    expect(LOG_SERVICES.map((service) => service.value)).toEqual(['oyechats-api', 'oyechats-worker']);
  });

  it('refuses anything else rather than passing it through to journalctl', () => {
    expect(isAllowedService('oyechats-api')).toBe(true);
    expect(isAllowedService('postgresql')).toBe(false);
    expect(isAllowedService('oyechats-api; rm -rf /')).toBe(false);
    expect(coerceService('postgresql')).toBe('oyechats-api');
  });
});

describe('bounds', () => {
  it('clamps the line count to the range the endpoint accepts', () => {
    expect(coerceLines('5')).toBe(10);
    expect(coerceLines('99999')).toBe(5000);
    expect(coerceLines('500')).toBe(500);
    expect(coerceLines('nonsense')).toBe(500);
  });

  it('drops a level the endpoint does not know', () => {
    expect(coerceLevel('error')).toBe('error');
    expect(coerceLevel('verbose')).toBe('');
    expect(coerceLevel('')).toBe('');
  });

  it('trims the grep term to the length the endpoint allows', () => {
    expect(coerceGrep('  boom  ')).toBe('boom');
    expect(coerceGrep('x'.repeat(500))).toHaveLength(200);
  });
});

describe('the request params', () => {
  it('sends only the parameters that are set', () => {
    expect(logsParams({ service: 'oyechats-worker', lines: '250', level: '', grep: '' })).toEqual({
      service: 'oyechats-worker',
      lines: 250,
    });
  });

  it('includes an allowed level and a bounded grep', () => {
    expect(logsParams({ service: 'oyechats-api', lines: '500', level: 'error', grep: ' boom ' })).toEqual({
      service: 'oyechats-api',
      lines: 500,
      level: 'error',
      grep: 'boom',
    });
  });

  it('never forwards a service outside the allow-list', () => {
    expect(logsParams({ service: '../../etc/passwd', lines: '10', level: '', grep: '' }).service).toBe(
      'oyechats-api',
    );
  });
});

describe('copying the page out', () => {
  it('renders one line per entry with its stamp and level', () => {
    const text = logsAsText(response);
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('# oyechats-api.service — 3 lines');
    expect(text).toContain('ERROR');
    expect(text).toContain('[1234] Traceback: boom');
  });

  it('says so when the host has no journal, rather than presenting the placeholder as real', () => {
    expect(logsAsText({ ...response, available: false })).toContain('journalctl unavailable');
  });

  it('is empty before anything is fetched', () => {
    expect(logsAsText(null)).toBe('');
  });
});

describe('level counts', () => {
  it('counts what is on screen, for the summary above the block', () => {
    expect(levelCounts(response.entries)).toEqual({ error: 1, info: 2 });
    expect(levelCounts([])).toEqual({});
  });
});
