import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../ui';
import { Rail } from './Rail';
import { __resetI18nForTests, preloadDictionary, setLocale } from '../i18n/i18n';

/**
 * The rail, in Hindi.
 *
 * This is the defect the whole nav-copy change exists to fix, and it was
 * invisible from the diff: the dictionary carried Hindi for every rail
 * destination, the runtime switched correctly, and `useBreadcrumbs` translated
 * — so the top bar moved to Hindi while the rail beside it stayed English.
 * Half a translated screen reads worse than an untranslated one, because it
 * looks broken rather than unlocalized.
 *
 * Asserting on the RENDERED rail rather than on the dictionary: a key that
 * exists but that nothing reads is exactly the state this started from.
 */

vi.mock('../context/BotContext', () => ({
  useBotContext: () => ({ bots: [], selectedBot: null, loading: false }),
}));
vi.mock('../context/NotificationContext', () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, incomingHandoff: null }),
}));
vi.mock('../context/WorkspaceContext', () => ({
  useWorkspace: () => ({ isOperator: false, currentWorkspaceName: 'Acme' }),
}));

function renderRail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/']}>
          <Rail collapsed={false} inboxCount={0} onToggle={() => {}} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the rail follows the dashboard language', () => {
  afterAll(() => __resetI18nForTests());

  it('renders English destinations by default', () => {
    __resetI18nForTests();
    renderRail();
    const nav = screen.getByRole('navigation', { name: /primary navigation/i });
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Leads' })).toBeTruthy();
  });

  describe('with Hindi selected', () => {
    beforeAll(async () => {
      await preloadDictionary('hi-IN');
      setLocale('hi-IN');
    });

    it('translates the destinations and the landmark', () => {
      renderRail();
      // The landmark itself is chrome copy: an English "Primary navigation"
      // announced over a Hindi rail is the same half-translated failure, just
      // only audible to a screen-reader user.
      const nav = screen.getByRole('navigation', { name: 'मुख्य नेविगेशन' });
      expect(within(nav).getByRole('link', { name: 'होम' })).toBeTruthy();
      expect(within(nav).getByRole('link', { name: 'लीड' })).toBeTruthy();
      expect(within(nav).getByRole('link', { name: 'यात्रा' })).toBeTruthy();

      // And the English is genuinely gone, not merely joined by Hindi.
      expect(within(nav).queryByRole('link', { name: 'Home' })).toBeNull();
      expect(within(nav).queryByRole('link', { name: 'Leads' })).toBeNull();
    });
  });
});

/**
 * The greeting lives in a module-level table, so it cannot be translated where
 * it is declared. The inventory cannot see a key/text pair inside an object
 * literal either — it only recognises the one-line `t('k') || 'English'` shape
 * — so this is the only thing that proves the table resolves at render.
 */
describe('the home greeting resolves from its table', () => {
  it('translates the greeting word without touching the customer name', async () => {
    const { greetingFor } = await import('../features/home/greeting');
    __resetI18nForTests();
    expect(greetingFor(new Date('2026-08-28T09:00:00'))).toBe('Good morning');
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');
    expect(greetingFor(new Date('2026-08-28T09:00:00'))).toBe('सुप्रभात');
    __resetI18nForTests();
  });
});
