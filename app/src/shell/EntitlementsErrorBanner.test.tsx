import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EntitlementsErrorBanner } from './EntitlementsErrorBanner';

/**
 * A failed entitlements read must not be indistinguishable from a downgrade.
 *
 * The provider falls back to Free defaults on error, which is the right
 * policy, but `error` was read by none of the thirty-four `useEntitlements()`
 * call sites. A Professional customer meeting one 500 saw their team locked,
 * their plan reported as Free and top-ups refused, with nothing anywhere
 * saying a request had failed.
 */

const state = vi.hoisted(() => ({
  error: null as Error | null,
  loading: false,
  refresh: vi.fn(),
}));

vi.mock('../hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    entitlements: {},
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
  }),
}));

describe('the entitlements error banner', () => {
  it('says nothing while the plan reads correctly', () => {
    state.error = null;
    state.loading = false;
    render(<EntitlementsErrorBanner />);
    expect(screen.queryByTestId('entitlements-error-banner')).not.toBeInTheDocument();
  });

  it('explains a failed read, and says it is not a subscription change', () => {
    state.error = new Error('500');
    state.loading = false;
    render(<EntitlementsErrorBanner />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/could not read your plan/i)).toBeInTheDocument();
    expect(screen.getByText(/not a change to your subscription/i)).toBeInTheDocument();
  });

  it('stays quiet while its own retry is still in flight', () => {
    /* The provider keeps the previous error until the new response lands, so a
       banner that ignored `loading` would sit there through its own retry and
       read as a retry that did nothing. */
    state.error = new Error('500');
    state.loading = true;
    render(<EntitlementsErrorBanner />);
    expect(screen.queryByTestId('entitlements-error-banner')).not.toBeInTheDocument();
  });

  it('offers a retry that re-reads the plan', async () => {
    state.error = new Error('500');
    state.loading = false;
    state.refresh.mockClear();
    render(<EntitlementsErrorBanner />);

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it('cannot be dismissed', () => {
    /* Everything it explains is still locked. A dismiss control would restore
       the silent-downgrade state the banner exists to prevent. */
    state.error = new Error('500');
    state.loading = false;
    render(<EntitlementsErrorBanner />);

    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it('paints from real tokens, not a Tailwind palette tokens.css deletes', () => {
    state.error = new Error('500');
    state.loading = false;
    render(<EntitlementsErrorBanner />);

    const cls = screen.getByTestId('entitlements-error-banner').className;
    expect(cls).toMatch(/\bbg-warning-tint\b/);
    expect(cls).not.toMatch(/\bbg-warning-\d/);
  });
});
