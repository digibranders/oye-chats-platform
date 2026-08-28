import { describe, expect, it } from 'vitest';
import type { NotificationPreferences } from '../../services/api';
import {
  defaultPreferences,
  describeQuietHours,
  fromWire,
  isFullySilenced,
  preferencesChanged,
  toWire,
  validateTime,
} from './notificationPreferences';

/**
 * The alert preferences' arithmetic.
 *
 * This whole surface is new — `GET/PUT /operators/me/notification-preferences`
 * had no client function at all — so what is pinned is the boundary: a missing
 * field must never read as "off", the PUT must always carry a complete object,
 * and the round trip must not report a change where there is none.
 */

describe('notificationPreferences', () => {
  it('reads absent preferences as fully opted in, never as silence', () => {
    // Telling somebody their alerts are off when they are on is the failure
    // that costs a live conversation.
    expect(fromWire(undefined)).toEqual(defaultPreferences());
    expect(fromWire(null)).toEqual(defaultPreferences());
    expect(fromWire({} as NotificationPreferences)).toEqual(defaultPreferences());
  });

  it('keeps an explicit opt-out, and defaults only what is missing', () => {
    const wire = {
      push: {
        enabled: true,
        events: { handoff_request: false },
        quiet_hours: null,
      },
    } as unknown as NotificationPreferences;
    const read = fromWire(wire);
    expect(read.events.handoff_request).toBe(false);
    expect(read.events.chat_transferred).toBe(true);
  });

  it('drops quiet hours it could not make sense of, rather than half-applying them', () => {
    const wire = {
      push: { enabled: true, events: {}, quiet_hours: { start: '25:00', end: '07:00', tz: 'UTC' } },
    } as unknown as NotificationPreferences;
    expect(fromWire(wire).quietHours).toBeNull();
  });

  it('defaults a quiet-hours timezone to UTC, as the server does', () => {
    const wire = {
      push: { enabled: true, events: {}, quiet_hours: { start: '22:00', end: '07:00', tz: '' } },
    } as unknown as NotificationPreferences;
    expect(fromWire(wire).quietHours?.tz).toBe('UTC');
  });

  it('always sends a complete push object, because the PUT replaces it', () => {
    const wire = toWire({
      enabled: false,
      events: { handoff_request: true, chat_transferred: false, offline_message: true },
      quietHours: null,
    });
    expect(wire.push.enabled).toBe(false);
    expect(Object.keys(wire.push.events).sort()).toEqual([
      'chat_transferred',
      'handoff_request',
      'offline_message',
    ]);
    expect(wire.push.quiet_hours).toBeNull();
  });

  it('survives a round trip without reporting a change', () => {
    const original = defaultPreferences();
    expect(preferencesChanged(original, fromWire(toWire(original)))).toBe(false);
    expect(preferencesChanged(original, { ...original, enabled: false })).toBe(true);
  });

  it('rejects a time the server would reject', () => {
    expect(validateTime('22:00')).toBeNull();
    expect(validateTime('07:05')).toBeNull();
    expect(validateTime('24:00')).not.toBeNull();
    expect(validateTime('7:00')).not.toBeNull();
    expect(validateTime('')).not.toBeNull();
  });

  it('says a window that wraps midnight wraps midnight', () => {
    expect(describeQuietHours(null)).toContain('any hour');
    expect(describeQuietHours({ start: '22:00', end: '07:00', tz: 'Asia/Kolkata' })).toContain(
      'the next morning',
    );
    expect(describeQuietHours({ start: '09:00', end: '17:00', tz: 'UTC' })).not.toContain(
      'the next morning',
    );
  });

  it('knows when nothing at all can reach the user', () => {
    const all = defaultPreferences();
    expect(isFullySilenced(all)).toBe(false);
    expect(isFullySilenced({ ...all, enabled: false })).toBe(true);
    expect(
      isFullySilenced({
        ...all,
        events: { handoff_request: false, chat_transferred: false, offline_message: false },
      }),
    ).toBe(true);
  });
});
