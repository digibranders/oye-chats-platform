import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Home's data layer is irrelevant here - the header renders while loading, so
// the page is held in its skeleton state and only the salutation is asserted.
vi.mock('./useHomeData', () => ({
  useHomeData: () => ({ data: null, loading: true, error: null, reload: vi.fn() }),
}));
vi.mock('../../context/BotContext', () => ({
  useBotContext: () => ({ selectedBot: null }),
}));
vi.mock('../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    isFree: false,
    planName: 'Professional',
    limitFor: () => -1,
    hasFeature: () => true,
  }),
}));
// The workspace context resolves to `company_name`. It is mocked to the prod
// value so a regression that reads it again fails loudly on "Fynix".
vi.mock('../../context/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspaceName: 'Fynix' }),
}));

import { HomePage } from './HomePage';

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('HomePage salutation', () => {
  beforeEach(() => {
    // Client 18 as it exists in prod: person "Gaurav", company "Fynix".
    localStorage.setItem('admin_name', 'Gaurav');
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('greets the person, not the company', () => {
    renderHome();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('Gaurav');
    // The defect this covers: "Good afternoon, Fynix 👋".
    expect(heading.textContent).not.toContain('Fynix');
  });

  it('uses the first name only', () => {
    localStorage.setItem('admin_name', 'Gaurav Sharma');

    renderHome();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('Gaurav');
    expect(heading.textContent).not.toContain('Sharma');
  });

  it('drops the name entirely rather than falling back to the workspace', () => {
    localStorage.removeItem('admin_name');

    renderHome();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).not.toContain('Fynix');
    // No name → no comma; just "Good <time of day> 👋".
    expect(heading.textContent).not.toContain(',');
  });
});
