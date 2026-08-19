import { describe, expect, it } from 'vitest';
import { REVENUE_BASE, REVENUE_TABS, revenueTabFor, revenueTabPath } from './tabs';

describe('revenue sub-navigation', () => {
  it('reads the tab out of the pathname', () => {
    expect(revenueTabFor(REVENUE_BASE)).toBe('overview');
    expect(revenueTabFor(`${REVENUE_BASE}/`)).toBe('overview');
    expect(revenueTabFor(`${REVENUE_BASE}/invoices`)).toBe('invoices');
    expect(revenueTabFor(`${REVENUE_BASE}/usage`)).toBe('usage');
  });

  it('ignores anything after the tab segment', () => {
    // A deeper path is still that tab, so the row does not blank out.
    expect(revenueTabFor(`${REVENUE_BASE}/invoices/1284`)).toBe('invoices');
  });

  it('falls back to the overview for an unknown or foreign path', () => {
    expect(revenueTabFor(`${REVENUE_BASE}/nonsense`)).toBe('overview');
    expect(revenueTabFor('/platform/customers')).toBe('overview');
  });

  it('round-trips every tab through its path', () => {
    for (const tab of REVENUE_TABS) {
      const path = revenueTabPath(tab.value);
      expect(path).not.toBeNull();
      expect(revenueTabFor(path as string)).toBe(tab.value);
    }
  });

  it('reports no path for a value that is not a tab', () => {
    expect(revenueTabPath('does-not-exist')).toBeNull();
  });
});
