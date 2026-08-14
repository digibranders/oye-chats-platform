import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtectedLayout } from './ProtectedLayout';

// The layout mounts the whole data-provider tree below its guards. None of that
// is under test here - only which of the two redirects fires - so the providers
// are stubbed to pass children straight through.
vi.mock('../context/WorkspaceContext', () => ({
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../context/BotContext', () => ({
  BotProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../context/CrawlContext', () => ({
  CrawlProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../context/CurrencyContext', () => ({
  CurrencyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../context/NotificationContext', () => ({
  NotificationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../context/EntitlementsContext', () => ({
  EntitlementsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../context/UpgradeModalContext', () => ({
  UpgradeModalProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/ImpersonationBanner', () => ({ default: () => null }));

/** Render the guarded tree at `entry`, with stand-ins for both redirect targets. */
function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<div>LOGIN SCREEN</div>} />
        <Route path="/verify-email" element={<div>VERIFY SCREEN</div>} />
        <Route element={<ProtectedLayout />}>
          <Route path="/workspace/billing" element={<div>BILLING PAGE</div>} />
          <Route path="/" element={<div>HOME PAGE</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function signIn(overrides: Record<string, string> = {}) {
  localStorage.setItem('admin_token', 'tok');
  localStorage.setItem('auth_type', 'client');
  localStorage.setItem('is_superadmin', 'false');
  Object.entries(overrides).forEach(([key, value]) => localStorage.setItem(key, value));
}

describe('ProtectedLayout - email-verification gate', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('holds an unverified client on the verify screen', () => {
    signIn({ admin_is_verified: 'false' });

    renderAt('/workspace/billing');

    expect(screen.getByText('VERIFY SCREEN')).toBeInTheDocument();
    expect(screen.queryByText('BILLING PAGE')).not.toBeInTheDocument();
  });

  it('lets a verified client reach the page', () => {
    signIn({ admin_is_verified: 'true' });

    renderAt('/workspace/billing');

    expect(screen.getByText('BILLING PAGE')).toBeInTheDocument();
  });

  it('does not gate when verification state is unknown', () => {
    signIn();

    renderAt('/');

    expect(screen.getByText('HOME PAGE')).toBeInTheDocument();
  });

  it('does not gate an operator', () => {
    // The flag mirrors the workspace OWNER's state for an operator session.
    signIn({ admin_is_verified: 'false', auth_type: 'operator' });

    renderAt('/');

    expect(screen.getByText('HOME PAGE')).toBeInTheDocument();
  });

  it('does not gate a super-admin', () => {
    signIn({ admin_is_verified: 'false', is_superadmin: 'true' });

    renderAt('/');

    expect(screen.getByText('HOME PAGE')).toBeInTheDocument();
  });

  it('still sends a signed-out visitor to login, not to verify', () => {
    // The auth guard runs first; an anonymous visitor has no email to verify.
    renderAt('/workspace/billing');

    expect(screen.getByText('LOGIN SCREEN')).toBeInTheDocument();
    expect(screen.queryByText('VERIFY SCREEN')).not.toBeInTheDocument();
  });
});
