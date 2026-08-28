import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ErrorDetails } from './ErrorDetails';
import { NotFoundPage } from './NotFoundPage';
import { PageErrorBoundary } from './PageErrorBoundary';
import { RootErrorBoundary } from './RootErrorBoundary';

/**
 * The screens a customer sees at the worst moment.
 *
 * Two things are pinned here that no amount of reading the components proves.
 * First, that the stack stays folded: a crash screen that opens with a
 * `TypeError` and a source path tells a customer nothing and looks like data
 * loss. Second, that each surface offers a way out — a page with no route
 * forward is where a session ends, and every one of these screens is reached by
 * someone who was in the middle of something.
 */

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

function Boom(): never {
  throw new Error('KnowledgeTable is not defined');
}

function renderBoundary(Boundary: () => React.ReactElement) {
  const router = createMemoryRouter(
    [{ path: '/', element: <Boom />, errorElement: <Boundary /> }],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

function renderRoute(element: React.ReactElement) {
  const router = createMemoryRouter([{ path: '*', element }], { initialEntries: ['/nope'] });
  return render(<RouterProvider router={router} />);
}

describe('ErrorDetails', () => {
  it('renders nothing when there is no technical detail', () => {
    const { container } = render(<ErrorDetails />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the stack folded away and marked as a diagnostic', () => {
    render(<ErrorDetails detail={'TypeError: x is not a function\n  at Knowledge.tsx:42'} />);

    const disclosure = screen.getByText(/technical details/i).closest('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute('open');
    // The summary names it as a diagnostic; the stack itself is not the label.
    expect(disclosure?.querySelector('summary')?.textContent).not.toMatch(/TypeError/);
  });

  it('opens on request and offers the stack as something to send to support', async () => {
    const user = userEvent.setup();
    render(<ErrorDetails detail="TypeError: x is not a function" />);

    await user.click(screen.getByText(/technical details/i));
    expect(screen.getByText('TypeError: x is not a function')).toBeVisible();
    expect(screen.getByRole('button', { name: /copy details/i })).toBeInTheDocument();
  });
});

describe('RootErrorBoundary', () => {
  it('says what happened in the user’s terms, with no stack in the heading', () => {
    renderBoundary(RootErrorBoundary);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Something went wrong');
    expect(heading.textContent).not.toMatch(/KnowledgeTable is not defined/);
  });

  it('offers both ways out — reload, and somewhere that works', () => {
    renderBoundary(RootErrorBoundary);

    expect(screen.getByRole('button', { name: /reload the page/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to home/i })).toHaveAttribute('href', '/');
  });

  it('tells the customer their workspace is not what broke', () => {
    renderBoundary(RootErrorBoundary);
    expect(screen.getByText(/your data is safe/i)).toBeInTheDocument();
  });
});

describe('PageErrorBoundary', () => {
  it('leans on the shell surviving, and leads with navigating away', () => {
    renderBoundary(PageErrorBoundary);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Something went wrong');
    expect(screen.getByText(/everything else still works/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to home/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('button', { name: /reload this page/i })).toBeInTheDocument();
  });
});

describe('NotFoundPage', () => {
  it('carries exactly one h1, and it names the problem', () => {
    renderRoute(<NotFoundPage />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('We could not find that page');
  });

  it('offers the console’s own destinations rather than a lone way home', () => {
    renderRoute(<NotFoundPage />);

    const list = screen.getByRole('list');
    expect(within(list).getByRole('link', { name: /inbox/i })).toHaveAttribute('href', '/inbox');
    expect(within(list).getByRole('link', { name: /billing/i })).toHaveAttribute('href', '/billing');
  });
});
