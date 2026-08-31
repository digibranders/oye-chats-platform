/**
 * The first run's contract.
 *
 * Three things must hold, and all three are things the wizard this replaces got
 * wrong: a customer with no crawlable website still has a way in, the crawl is
 * NOT awaited before the customer is let through, and a failure to create the
 * chatbot is explained on the screen rather than swallowed.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstRunPage } from './FirstRunPage';

const createBot = vi.fn();
const crawlWebsite = vi.fn();
vi.mock('../services/api', () => ({
  createBot: (...args: unknown[]) => createBot(...args),
  crawlWebsite: (...args: unknown[]) => crawlWebsite(...args),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const botContext = { bots: [] as unknown[], loading: false, refreshBots: vi.fn() };
vi.mock('../context/BotContext', () => ({
  useBotContext: () => botContext,
}));
vi.mock('../context/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspaceName: 'Northwind' }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <FirstRunPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  botContext.bots = [];
  botContext.loading = false;
});

describe('FirstRunPage', () => {
  it('names the chatbot after the website as it is typed, until the user says otherwise', async () => {
    const user = userEvent.setup();
    renderPage();

    const name = screen.getByLabelText(/what is it called/i);
    expect(name).toHaveValue('Northwind');

    await user.type(screen.getByLabelText(/your website/i), 'acme.com');
    await waitFor(() => expect(name).toHaveValue('Acme'));

    await user.clear(name);
    await user.type(name, 'Concierge');
    await user.type(screen.getByLabelText(/your website/i), '.au');
    // Their own name survives every later keystroke in the website field.
    expect(name).toHaveValue('Concierge');
  });

  it('refuses to submit without a website, and says so on the field', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /check my site/i }));
    expect(await screen.findByText(/enter the address of the site/i)).toBeInTheDocument();
    expect(createBot).not.toHaveBeenCalled();
  });

  it('lets the customer through without waiting for the crawl', async () => {
    const user = userEvent.setup();
    createBot.mockResolvedValue({ id: 42 });
    // A crawl that never settles: the wizard this replaces would have hung here.
    crawlWebsite.mockReturnValue(new Promise(() => {}));
    renderPage();

    await user.type(screen.getByLabelText(/your website/i), 'acme.com');
    await user.click(screen.getByRole('button', { name: /check my site/i }));

    // The Knowledge page, where the crawl it just kicked off reports itself.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/chatbots/42/knowledge', { replace: true }),
    );
    expect(createBot).toHaveBeenCalledWith({ name: 'Acme', website: 'https://acme.com' });
    // The crawl is NOT started here any more. The customer is handed to the
    // Knowledge page with the address saved, where they see the page count
    // before committing to a read of the whole site.
    expect(crawlWebsite).not.toHaveBeenCalled();
  });

  it('starts with no website at all, and routes to where the content goes', async () => {
    const user = userEvent.setup();
    createBot.mockResolvedValue({ id: 7 });
    renderPage();

    await user.click(screen.getByRole('radio', { name: /documents/i }));
    expect(screen.queryByLabelText(/your website/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create my chatbot/i }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/chatbots/7/knowledge?add=upload', { replace: true }),
    );
    expect(createBot).toHaveBeenCalledWith({ name: 'Northwind' });
    expect(crawlWebsite).not.toHaveBeenCalled();
  });

  it('explains a plan limit instead of failing silently', async () => {
    const user = userEvent.setup();
    createBot.mockRejectedValue(new Error('Your plan allows one chatbot.'));
    renderPage();

    await user.type(screen.getByLabelText(/your website/i), 'acme.com');
    await user.click(screen.getByRole('button', { name: /check my site/i }));

    expect(await screen.findByText(/your plan allows one chatbot/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /check your plan/i })).toHaveAttribute('href', '/billing');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends a workspace that already has a chatbot straight back', () => {
    botContext.bots = [{ id: 1 }];
    renderPage();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});

/*
 * The handoff race is deliberately NOT unit-tested here.
 *
 * `submit` awaits `refreshBots()` before navigating, which makes `bots.length`
 * non-zero, and the render-level `<Navigate to="/">` guard at the top of this
 * screen then beat the imperative navigate — so every website signup landed on
 * Home. The fix is the `handedOff` latch.
 *
 * A test was written for it and deleted again: `useBotContext` is stubbed with
 * a plain object here, so mutating `botContext.bots` re-renders nothing and the
 * guard is never re-evaluated. The test passed identically with the latch
 * removed, which makes it a claim of coverage rather than coverage. Reproducing
 * it faithfully needs a real provider and React's own scheduling; it was
 * verified in the browser instead.
 */
