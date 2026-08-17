/**
 * `useEntitlements` is the typed selector every feature gate reads through, so
 * its derivations must match the backend resolver exactly:
 *   - `hasFeature` treats the one string flag (`integrations`) as "on" for any
 *     non-empty value, booleans as themselves,
 *   - `limitFor` returns the configured ceiling, or `0` (deny-by-default) for a
 *     missing/non-numeric key,
 *   - `-1` is the UNLIMITED sentinel: `withinLimit` is always true and
 *     `remaining` is `Infinity`,
 *   - `withinLimit`/`remaining` respect the boundary at exactly the limit,
 *   - `isFree` is true for the `is_free` flag OR the `free` slug.
 *
 * The context is mocked so each case controls the entitlements snapshot; the
 * hook's pure logic is what's under test.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entitlements } from '../types/domain';
import { useEntitlements } from './useEntitlements';

const ctx = vi.hoisted(() => ({
  value: {
    entitlements: {} as Entitlements,
    loading: false,
    error: null as Error | null,
    refresh: vi.fn(),
  },
}));

vi.mock('../context/EntitlementsContext', () => ({
  useEntitlementsContext: () => ctx.value,
}));

function makeEntitlements(overrides: Partial<Entitlements> = {}): Entitlements {
  return {
    plan_slug: 'professional',
    plan_name: 'Professional',
    subscription_status: 'active',
    limits: {
      credits: 10000,
      bots: 3,
      operators: 5,
      leads: -1,
      page_scraping: 100,
      documents: 50,
      chat_history_days: 90,
    },
    features: {
      live_chat: true,
      bant: false,
      branding_removable: true,
      webhooks: false,
      api_access: true,
      online_support: false,
      topup_allowed: true,
      integrations: 'all',
    },
    usage: {},
    is_free: false,
    topup_allowed: true,
    ...overrides,
  };
}

function setEntitlements(overrides: Partial<Entitlements> = {}): void {
  ctx.value = {
    entitlements: makeEntitlements(overrides),
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
}

beforeEach(() => {
  setEntitlements();
});

describe('useEntitlements — passthrough fields', () => {
  it('forwards loading, error and refresh from the context', () => {
    const refresh = vi.fn();
    const error = new Error('boom');
    ctx.value = { entitlements: makeEntitlements(), loading: true, error, refresh };

    const { result } = renderHook(() => useEntitlements());

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe(error);
    expect(result.current.refresh).toBe(refresh);
    expect(result.current.planSlug).toBe('professional');
    expect(result.current.planName).toBe('Professional');
  });
});

describe('useEntitlements — isFree', () => {
  it('is false for a paid plan', () => {
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.isFree).toBe(false);
  });

  it('is true when the is_free flag is set', () => {
    setEntitlements({ is_free: true, plan_slug: 'professional' });
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.isFree).toBe(true);
  });

  it('is true when the slug is free even if the flag is not set', () => {
    setEntitlements({ is_free: false, plan_slug: 'free' });
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.isFree).toBe(true);
  });
});

describe('useEntitlements — hasFeature', () => {
  it('reflects boolean flags directly', () => {
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.hasFeature('live_chat')).toBe(true);
    expect(result.current.hasFeature('bant')).toBe(false);
    expect(result.current.hasFeature('api_access')).toBe(true);
    expect(result.current.hasFeature('webhooks')).toBe(false);
  });

  it('treats the "all" integrations value as on', () => {
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.hasFeature('integrations')).toBe(true);
  });

  it('treats "reply_to_only" as on (any non-empty string counts)', () => {
    ctx.value.entitlements.features.integrations = 'reply_to_only';
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.hasFeature('integrations')).toBe(true);
  });

  it('treats an empty integrations string as off', () => {
    ctx.value.entitlements.features.integrations = '' as 'all';
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.hasFeature('integrations')).toBe(false);
  });
});

describe('useEntitlements — limitFor', () => {
  it('returns the configured numeric ceiling', () => {
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.limitFor('bots')).toBe(3);
    expect(result.current.limitFor('documents')).toBe(50);
  });

  it('returns the -1 unlimited sentinel unchanged', () => {
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.limitFor('leads')).toBe(-1);
  });

  it('returns 0 (deny-by-default) for a non-numeric/missing key', () => {
    ctx.value.entitlements.limits = {
      ...ctx.value.entitlements.limits,
      bots: undefined as unknown as number,
    };
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.limitFor('bots')).toBe(0);
  });
});

describe('useEntitlements — withinLimit', () => {
  it('is true below the limit and false at or above it', () => {
    const { result } = renderHook(() => useEntitlements()); // bots limit = 3
    expect(result.current.withinLimit('bots', 2)).toBe(true);
    expect(result.current.withinLimit('bots', 3)).toBe(false); // boundary is exclusive
    expect(result.current.withinLimit('bots', 4)).toBe(false);
  });

  it('is always true when the limit is unlimited (-1)', () => {
    const { result } = renderHook(() => useEntitlements()); // leads limit = -1
    expect(result.current.withinLimit('leads', 0)).toBe(true);
    expect(result.current.withinLimit('leads', 1_000_000)).toBe(true);
  });

  it('is false at zero when the limit is a deny-by-default 0', () => {
    setEntitlements({
      limits: { ...makeEntitlements().limits, operators: 0 },
    });
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.withinLimit('operators', 0)).toBe(false);
  });
});

describe('useEntitlements — remaining', () => {
  it('counts down to the ceiling and floors at zero', () => {
    const { result } = renderHook(() => useEntitlements()); // bots limit = 3
    expect(result.current.remaining('bots', 0)).toBe(3);
    expect(result.current.remaining('bots', 2)).toBe(1);
    expect(result.current.remaining('bots', 3)).toBe(0);
    expect(result.current.remaining('bots', 5)).toBe(0); // never negative
  });

  it('is Infinity when the limit is unlimited (-1)', () => {
    const { result } = renderHook(() => useEntitlements()); // leads = -1
    expect(result.current.remaining('leads', 42)).toBe(Infinity);
  });
});
