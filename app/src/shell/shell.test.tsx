import { render, renderHook, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider, formatBadgeCount } from '../ui';
import { Rail } from './Rail';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { ImpersonationBanner } from './ImpersonationBanner';
import { WORKSPACE_NAV } from './nav';
import { useBreadcrumbs } from './useBreadcrumbs';
import { startImpersonationSession, clearImpersonationSession } from '../utils/impersonation';

/**
 * The chrome, at the two points where a defect is invisible in the diff.
 *
 * The impersonation bar shipped every colour class it needed and rendered
 * *nothing*: `tokens.css` opens its `@theme` with `--color-*: initial`, which
 * drops Tailwind's whole default palette including `white` and `black`, so
 * `bg-rose-600 text-white` compiled to no rule at all. The built stylesheet
 * contained zero occurrences of any of them. A bar whose stated job is to make
 * a support session impossible to forget was a transparent strip with
 * near-black text, and nothing about the source said so.
 *
 * The breadcrumb had the mirror-image problem: it rendered confidently and was
 * wrong. Eleven routes named their parent while carrying `aria-current="page"`,
 * and six rendered an empty `<ol>`.
 */

const SOURCES = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Source with comments stripped: a docblock naming a banned class is prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SHELL_FILES = Object.entries(SOURCES)
  .filter(([name]) => !/\.test\.tsx?$/.test(name))
  .map(([name, source]) => ({ name, source: code(source as string) }));

function startSession() {
  startImpersonationSession('tok', {
    client_id: 42,
    name: 'Northwind Ltd',
    email: 'ana@northwind.com',
    actor_email: 'staff@oyechats.com',
    expires_at: '2099-01-01T09:30:00Z',
    is_impersonation: true,
  });
}

describe('the impersonation bar', () => {
  afterEach(() => {
    clearImpersonationSession();
    sessionStorage.clear();
  });

  it('renders nothing when the tab holds no support session', () => {
    const { container } = render(<ImpersonationBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the account and the super-admin acting as it', () => {
    startSession();
    render(<ImpersonationBanner />);

    const bar = screen.getByRole('alert');
    expect(bar).toHaveTextContent('Northwind Ltd');
    expect(bar).toHaveTextContent('staff@oyechats.com');
    expect(bar).toHaveTextContent(/limited actions/i);
    expect(within(bar).getByRole('button', { name: /exit/i })).toBeInTheDocument();
  });

  it('paints itself with tokens that survive the theme reset', () => {
    startSession();
    render(<ImpersonationBanner />);

    const bar = screen.getByRole('alert');
    // The fill and the text are the assertion, not a class-name spot check:
    // these two are the difference between a red bar and an invisible one.
    expect(bar.className).toMatch(/\bbg-danger-fill\b/);
    expect(bar.className).toMatch(/\btext-text-inverse\b/);
  });

  it('reaches for no Tailwind default palette anywhere in the shell', () => {
    // `--color-*: initial` deletes all of them, so any of these compiles to
    // nothing and the element renders transparent — which is exactly how this
    // bar shipped invisible.
    const banned =
      /\b(?:bg|text|border|ring|stroke|fill)-(?:white|black|slate|gray|zinc|neutral-[1-9]|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-?\d*\b/;
    const offenders = SHELL_FILES.filter(({ source }) => banned.test(source)).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

});

describe('the rail', () => {
  it('borrows no paper status token onto the ink ground', () => {
    // Six components needed a status colour on the rail and all six reached for
    // a paper one: `--color-danger-fill` measures 2.94:1 against `--color-rail`
    // and fails SC 1.4.11. The rail has its own scale now.
    const paperStatus = /\b(?:bg|text|stroke|border)-(?:success|warning|danger)(?:-fill|-tint)?\b/;
    const offenders = SHELL_FILES.filter(
      ({ name, source }) =>
        // The impersonation bar is paper on purpose: it is a canvas-side banner,
        // not rail chrome. The feedback dialog is the same case — it renders in
        // a `Dialog` on the paper canvas, not on the rail; it lives under
        // `shell/` only because its launcher tab is shell chrome. The
        // entitlements banner is a third: a flex child of the shell rendered
        // above the top bar on the paper canvas, sharing the page gutter, and
        // it carries a status colour because a plan that could not be read is
        // a warning rather than a decorative accent.
        !name.includes('ImpersonationBanner') &&
        !name.includes('FeedbackModal') &&
        !name.includes('EntitlementsErrorBanner') &&
        paperStatus.test(source),
    ).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('writes no rail row geometry of its own', () => {
    // Three row heights and six left text edges lived in `Rail.tsx`. The
    // geometry belongs to `RailFrame`, and there is one of it.
    const offenders = SHELL_FILES.filter(
      ({ name, source }) => name.includes('Rail') && /\bpy-1\.5\b|\bpy-2\b/.test(source),
    ).map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});

describe('formatBadgeCount', () => {
  it('caps a queue at 99, not at 9', () => {
    expect(formatBadgeCount(3)).toBe('3');
    expect(formatBadgeCount(14)).toBe('14');
    expect(formatBadgeCount(99)).toBe('99');
    expect(formatBadgeCount(140)).toBe('99+');
  });
});

describe('the top bar', () => {
  function renderBar(pathname: string, isMobile: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[pathname]}>
            <TopBar isMobile={isMobile} onToggleRail={() => {}} onOpenSearch={() => {}} />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('carries the trail on the page gutter above 1024', () => {
    renderBar('/billing/usage', false);
    const trail = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(trail).getByRole('link', { name: 'Billing' })).toHaveAttribute(
      'href',
      '/billing',
    );
    expect(within(trail).getByText('Usage')).toHaveAttribute('aria-current', 'page');
    // Nothing stands in front of it: the collapse control is on the rail, so
    // the first crumb and the page's `h1` start on one left edge.
    expect(screen.queryByRole('button', { name: /open navigation/i })).toBeNull();
  });

  it('drops the trail below 1024, where the drawer trigger takes that edge', () => {
    renderBar('/billing/usage', true);
    // Measured at 1000px: a 28px trigger and a 12px gap put the crumb at x=58
    // against a page title at x=24. Every link the trail offers is a row in the
    // drawer this button opens, and its last crumb is the `h1` below it.
    expect(screen.getByRole('button', { name: /open navigation/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).toBeNull();
  });

  it('carries the wordmark below 1024, where the rail is behind a drawer', () => {
    // The brand lives at the top of the rail, so on a phone it is off screen
    // until the drawer opens and the bar read as a menu button and a gap.
    renderBar('/billing/usage', true);
    const home = screen.getByRole('link', { name: 'Home' });
    expect(home).toHaveAttribute('href', '/');
    expect(within(home).getByRole('img', { name: 'OyeChats' })).toHaveAttribute('src', '/new_dark.png');
  });

  it('does not repeat the wordmark above 1024, where the rail already shows it', () => {
    renderBar('/billing/usage', false);
    expect(screen.queryByRole('img', { name: 'OyeChats' })).toBeNull();
  });
});

/** Render the hook at a path, with a stubbed chatbot list. */
function crumbsAt(pathname: string) {
  return renderHook(() => useBreadcrumbs(), {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[pathname]}>{children}</MemoryRouter>,
  }).result.current;
}

vi.mock('../context/BotContext', () => ({
  useBotContext: () => ({
    bots: [
      { id: 12, name: 'Northwind Support', indexed_chunk_count: 40, is_active: true },
      { id: 13, name: 'Acme Docs', indexed_chunk_count: 0, is_active: true },
    ],
    loading: false,
  }),
}));

vi.mock('../context/NotificationContext', () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, markAllRead: vi.fn(), loading: false }),
}));

vi.mock('../services/api', () => ({
  // No `trial`, so the rail's trial card renders nothing here. Its own states
  // are covered in TrialCard.test.tsx; this file is about the rail's structure.
  getCurrentUser: async () => ({ id: 1, name: 'Ana Ruiz', email: 'ana@acme.com' }),
  getCreditBalance: async () => ({ balance: 0 }),
  getDashboardStats: async () => ({}),
  getLeadStats: async () => ({}),
}));

/** The rail, in the tree it actually renders in. */
function renderRail(pathname: string, collapsed = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[pathname]}>
          <Rail collapsed={collapsed} inboxCount={140} onToggle={() => {}} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the rail, rendered', () => {
  it('names the workspace destinations and the chatbots once each', () => {
    renderRail('/');
    const nav = screen.getByRole('navigation', { name: /primary navigation/i });

    // "Chatbots" used to be a nav row *and* the label of the group listing
    // them, forty pixels apart. The group's tail row is the destination now.
    expect(within(nav).queryByRole('link', { name: 'Chatbots' })).toBeNull();
    expect(within(nav).getByRole('link', { name: /all chatbots/i })).toHaveAttribute(
      'href',
      '/chatbots',
    );
    expect(within(nav).getByRole('link', { name: /northwind support/i })).toBeInTheDocument();
  });

  it('caps the inbox count rather than printing it raw', () => {
    renderRail('/');
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('swaps to the chatbot scope from the URL alone', () => {
    renderRail('/chatbots/12/knowledge');
    const nav = screen.getByRole('navigation', { name: /chatbot navigation/i });
    expect(within(nav).getByRole('link', { name: /all chatbots/i })).toHaveAttribute(
      'href',
      '/chatbots',
    );
    expect(within(nav).getByRole('link', { name: 'Knowledge' })).toHaveAttribute(
      'href',
      '/chatbots/12/knowledge',
    );
  });

  it('offers a way to create a chatbot, at a real target size', () => {
    renderRail('/');
    const create = screen.getByRole('link', { name: /new chatbot/i });
    // 24px, not the 18px `rounded-xs p-0.5` it was: `CLAUDE.md` non-negotiable 4
    // and WCAG 2.2 SC 2.5.8 both ask for 24 in a dense row.
    expect(create.className).toMatch(/\bh-6\b/);
    expect(create.className).toMatch(/\bw-6\b/);
  });

  it('renders the brand mark as a static block, not a workspace-switcher menu', () => {
    // `RailBrand` replaced the old `WorkspaceSwitcher` menu: the current
    // workspace's name was stated twice — once here as an interactive menu,
    // once 48px below in the account menu — so this became the plain wordmark.
    //
    // Switching is its own row below this one now, but only for an identity
    // that can act in more than one workspace. This fixture is a solo account,
    // so neither the menu nor that row may appear here — the duplication the
    // wordmark was argued for must stay absent.
    renderRail('/');
    expect(screen.getByRole('img', { name: 'OyeChats' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /workspace/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /workspace/i })).not.toBeInTheDocument();
  });

  it('does not announce the create control as the page you are on', () => {
    // `/chatbots?new=1` matches the path `/chatbots`, so as a `NavLink` this
    // button carried `aria-current="page"` on the list page — two current
    // destinations in one rail, one of which was a button that opens a dialog.
    renderRail('/chatbots');
    expect(screen.getByRole('link', { name: /new chatbot/i })).not.toHaveAttribute(
      'aria-current',
    );
    expect(screen.getByRole('link', { name: /all chatbots/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it.each(['/welcome', '/welcome/12'])('reads Home as current at %s', (path) => {
    // The first run *is* Home for a workspace with no chatbot — `HomePage`
    // redirects there rather than rendering a page of zeros. `NavLink end`
    // matched neither address, so the rail was blank on the first two screens a
    // new customer ever sees.
    renderRail(path);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('WORKSPACE_NAV', () => {
  it('lists Journey as its own top-level sidebar entry', () => {
    const journey = WORKSPACE_NAV.find((item) => item.label === 'Journey');
    expect(journey).toBeDefined();
    expect(journey?.to).toBe('/journey');
  });
});

describe('the breadcrumb', () => {
  it.each([
    ['/billing/usage', ['Billing', 'Usage']],
    ['/billing/reports', ['Billing', 'Reports']],
    ['/settings/workspace', ['Settings', 'Workspace']],
    ['/settings/team', ['Settings', 'Team']],
    ['/settings/integrations', ['Settings', 'Integrations']],
    ['/settings/developers', ['Settings', 'Developers']],
    ['/settings/affiliate', ['Settings', 'Affiliate']],
    ['/account/preferences', ['Account', 'Preferences']],
  ])('names the section, not only its parent, at %s', (path, expected) => {
    expect(crumbsAt(path).map((crumb) => crumb.label)).toEqual(expected);
  });

  it.each([
    ['/setup', 'Setup'],
    ['/welcome', 'Welcome'],
    ['/welcome/12', 'Welcome'],
    ['/account', 'Account'],
    ['/journey', 'Journey'],
  ])('never renders an empty trail at %s', (path, expected) => {
    expect(crumbsAt(path).map((crumb) => crumb.label)).toEqual([expected]);
  });

  it('says so rather than going blank on an address that resolves to nothing', () => {
    expect(crumbsAt('/definitely-not-a-page').map((crumb) => crumb.label)).toEqual(['Not found']);
  });

  it('links the parent only when there is a child to come back from', () => {
    expect(crumbsAt('/billing')).toEqual([{ label: 'Billing' }]);
    expect(crumbsAt('/billing/usage')[0]).toEqual({ label: 'Billing', to: '/billing' });
  });

  it('names the chatbot, and holds a placeholder until the name arrives', () => {
    expect(crumbsAt('/chatbots/12/knowledge').map((crumb) => crumb.label)).toEqual([
      'Chatbots',
      'Northwind Support',
      'Knowledge',
    ]);
    // An id the list does not hold: the crumb is pending, never `Chatbot 99`
    // swapped for a real name a frame later.
    expect(crumbsAt('/chatbots/99/knowledge')[1]).toMatchObject({ pending: true });
  });
});

describe('the command palette', () => {
  function renderPalette() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CommandPalette open onOpenChange={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('groups its results instead of tagging every row with the group name', () => {
    renderPalette();
    // Two group headers, in order. The group name used to be stamped on every
    // row instead: twelve chatbots meant eighty-four rows each reading
    // "Chatbots" down the right-hand edge. The palette is portalled, so this
    // reads the document rather than the render container.
    const headers = Array.from(document.body.querySelectorAll('.tracking-eyebrow')).map(
      (node) => node.textContent,
    );
    expect(headers).toEqual(['Go to', 'Chatbots']);
  });

  it('carries no explanatory sentence per row', () => {
    renderPalette();
    // The hint stays searchable on the command, but it is not rendered — it is
    // what made a 56px row and put 5.7 of them in a 320px list.
    expect(screen.queryByText('Open this chatbot')).toBeNull();
    expect(screen.queryByText('What does it know?')).toBeNull();
  });

  it('names the two keys a first-time user needs, permanently', () => {
    renderPalette();
    expect(screen.getByText(/navigate/)).toBeInTheDocument();
    expect(screen.getByText(/open/)).toBeInTheDocument();
    expect(screen.getByText(/close/)).toBeInTheDocument();
  });
});

describe('the scroll container', () => {
  // `overflow` clips only descendants whose containing block runs through
  // the element. An `sr-only` live region is `position: absolute`; with no
  // positioned ancestor its containing block is the initial one, so it sits
  // at its static spot in the page flow, past the fold on a tall page, and
  // grows the document's scrollable area beyond the viewport. The first
  // focus or trackpad flick then scrolls the entire shell, rail included,
  // out of view. Seen on /account in production: 309px. `relative` on the
  // scroll container and on the shell root is what keeps such elements
  // inside them, and jsdom does no layout, so the class itself is pinned.
  const source = SHELL_FILES.find((f) => f.name === './AppShell.tsx')?.source ?? '';

  it('is the containing block for anything absolutely positioned inside it', () => {
    const main = source.match(/<main id="main" className="([^"]+)"/);
    expect(main).not.toBeNull();
    const classes = main![1].split(/\s+/);
    expect(classes).toContain('relative');
    expect(classes).toContain('overflow-y-auto');
  });

  it('sits in a shell root that contains what the rail and banners position', () => {
    expect(source).toMatch(/'relative grid h-dvh overflow-hidden/);
  });
});
