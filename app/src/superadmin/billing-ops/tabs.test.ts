import { describe, expect, it } from 'vitest';
import {
  BILLING_OPS_BASE,
  BILLING_OPS_TABS,
  billingOpsTabFor,
  billingOpsTabPath,
} from './tabs';

describe('billing operations sub-navigation', () => {
  it('opens on dunning, because that is the time-critical screen', () => {
    expect(BILLING_OPS_TABS[0].value).toBe('dunning');
    expect(BILLING_OPS_TABS[0].path).toBe('');
    expect(billingOpsTabFor(BILLING_OPS_BASE)).toBe('dunning');
  });

  it('reads the tab out of the pathname', () => {
    expect(billingOpsTabFor(`${BILLING_OPS_BASE}/gstr`)).toBe('gstr');
    expect(billingOpsTabFor(`${BILLING_OPS_BASE}/seller`)).toBe('seller');
    expect(billingOpsTabFor(`${BILLING_OPS_BASE}/webhooks`)).toBe('webhooks');
  });

  it('falls back to dunning for an unknown or foreign path', () => {
    expect(billingOpsTabFor(`${BILLING_OPS_BASE}/nonsense`)).toBe('dunning');
    expect(billingOpsTabFor('/platform/revenue/invoices')).toBe('dunning');
  });

  it('round-trips every tab through its path', () => {
    for (const tab of BILLING_OPS_TABS) {
      const path = billingOpsTabPath(tab.value);
      expect(path).not.toBeNull();
      expect(billingOpsTabFor(path as string)).toBe(tab.value);
    }
  });

  it('reports no path for a value that is not a tab', () => {
    expect(billingOpsTabPath('does-not-exist')).toBeNull();
  });
});
