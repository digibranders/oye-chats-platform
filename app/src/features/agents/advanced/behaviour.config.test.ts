import { describe, expect, it } from 'vitest';
import {
  CONFIG_FIELDS,
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS,
  OPERATOR_TIMEOUT,
  STRICTNESS_LEVELS,
  matchesLevel,
  operatorTimeoutError,
  parseBehaviour,
  toBehaviourPayload,
  toDisplay,
  toStored,
} from './behaviour.config';

describe('parseBehaviour', () => {
  it('fills every flag and knob from the defaults when the payload is empty', () => {
    const draft = parseBehaviour({});
    expect(draft.relevanceThreshold).toBeNull();
    expect(draft.featureFlags).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(draft.operatorTimeoutSeconds).toBe(OPERATOR_TIMEOUT.default);
    expect(Object.keys(draft.widgetConfig)).toHaveLength(CONFIG_FIELDS.length);
  });

  it('keeps a stored flag over its default', () => {
    const draft = parseBehaviour({ feature_flags: { typing_preview: false } });
    expect(draft.featureFlags.typing_preview).toBe(false);
    expect(draft.featureFlags.post_chat_rating).toBe(true);
  });

  it('ignores a non-numeric stored knob rather than writing NaN back', () => {
    const draft = parseBehaviour({ widget_config: { greeting_delay_ms: 'soon' } });
    expect(draft.widgetConfig.greeting_delay_ms).toBe(3000);
  });

  it('does not carry show_branding, which Experience owns', () => {
    /* An ungated copy here would be a silent no-op on every plan the server
       forces `show_branding` true for. */
    expect(FEATURE_FLAGS.map((flag) => flag.key)).not.toContain('show_branding');
  });
});

describe('toBehaviourPayload', () => {
  it('sends every field this page owns, and nothing else', () => {
    const payload = toBehaviourPayload(parseBehaviour({ relevance_threshold: 0.65 }));
    expect(Object.keys(payload).sort()).toEqual([
      'feature_flags',
      'operator_timeout_seconds',
      'relevance_threshold',
      'widget_config',
    ]);
    expect(payload.relevance_threshold).toBe(0.65);
  });

  it('sends a null threshold rather than omitting it, so "reset to default" persists', () => {
    const payload = toBehaviourPayload({ ...parseBehaviour({ relevance_threshold: 0.65 }), relevanceThreshold: null });
    expect(payload).toHaveProperty('relevance_threshold', null);
  });
});

describe('unit conversion', () => {
  it('shows a millisecond value in seconds without float noise', () => {
    const field = CONFIG_FIELDS.find((item) => item.key === 'welcome_exit_duration_ms')!;
    expect(toDisplay(field, 350)).toBe(0.35);
  });

  it('stores seconds back as milliseconds', () => {
    const field = CONFIG_FIELDS.find((item) => item.key === 'greeting_delay_ms')!;
    expect(toStored(field, '2.5')).toBe(2500);
  });

  it('clamps above the maximum, because widget_config has no server-side bounds', () => {
    /* The API accepts `widget_config` as an open map with no per-key validation,
       so a mistyped 5000-second heartbeat would store fine and simply stop the
       widget reconnecting. These bounds are the only thing in the way. */
    const field = CONFIG_FIELDS.find((item) => item.key === 'heartbeat_visible_ms')!;
    expect(toStored(field, '99999')).toBe(field.max * 1000);
  });

  it('clamps below the minimum', () => {
    const field = CONFIG_FIELDS.find((item) => item.key === 'max_reconnect_attempts')!;
    expect(toStored(field, '0')).toBe(field.min);
  });

  it('falls back to the default for unparseable input rather than storing NaN', () => {
    const field = CONFIG_FIELDS.find((item) => item.key === 'typing_timeout_ms')!;
    expect(toStored(field, '')).toBe(field.defaultValue);
  });

  it('rounds a count to a whole number', () => {
    const field = CONFIG_FIELDS.find((item) => item.key === 'frustration_threshold_messages')!;
    expect(Number.isInteger(toStored(field, '4.7'))).toBe(true);
  });

  it('every field declares bounds that contain its own default', () => {
    for (const field of CONFIG_FIELDS) {
      const shown = toDisplay(field, field.defaultValue);
      expect(shown, field.key).toBeGreaterThanOrEqual(field.min);
      expect(shown, field.key).toBeLessThanOrEqual(field.max);
    }
  });
});

describe('operatorTimeoutError', () => {
  it('accepts a value inside the server’s own range', () => {
    expect(operatorTimeoutError(OPERATOR_TIMEOUT.default)).toBeNull();
    expect(operatorTimeoutError(OPERATOR_TIMEOUT.min)).toBeNull();
    expect(operatorTimeoutError(OPERATOR_TIMEOUT.max)).toBeNull();
  });

  it('names the range and the offending value rather than saying "invalid"', () => {
    /* `Field(None, ge=5, le=3600)` on UpdateBotRequest. A 422 after the fact is
       not an error message. */
    expect(operatorTimeoutError(4)).toMatch(/5 to 3600 seconds\. 4 would be rejected/);
    expect(operatorTimeoutError(3601)).toMatch(/3601 would be rejected/);
  });

  it('rejects a fractional value', () => {
    expect(operatorTimeoutError(12.5)).toMatch(/whole number/i);
  });
});

describe('matchesLevel', () => {
  it('treats a null threshold as the platform default', () => {
    expect(matchesLevel(null, 0.55)).toBe(true);
    expect(matchesLevel(null, 0.65)).toBe(false);
  });

  it('tolerates float drift', () => {
    expect(matchesLevel(0.6500000000000001, 0.65)).toBe(true);
  });

  it('offers three levels, one of which is the platform default', () => {
    expect(STRICTNESS_LEVELS).toHaveLength(3);
    expect(STRICTNESS_LEVELS.some((level) => matchesLevel(null, level.value))).toBe(true);
  });
});
