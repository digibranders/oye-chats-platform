import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AuthShell } from './AuthShell';

function mount(props: Partial<Parameters<typeof AuthShell>[0]> = {}) {
  return render(
    <MemoryRouter>
      <AuthShell title="Sign in" {...props}>
        <button type="button">Continue</button>
      </AuthShell>
    </MemoryRouter>,
  );
}

describe('AuthShell', () => {
  it('names the screen with the form’s own heading, not the panel', () => {
    mount({ description: 'Welcome back.' });
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Welcome back.')).toBeInTheDocument();
  });

  /**
   * The panel is the design, so it is pinned.
   *
   * It was once removed as redundant — the reasoning being that one centred
   * column needs no breakpoint fork — and the split is a deliberate product
   * decision that outranks that tidiness. A test says so where the next person
   * simplifying this file will read it.
   */
  it('renders the ink panel beside the form', () => {
    const { container } = mount();
    const panel = container.querySelector('aside');
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('bg-rail');
    // Hidden below `xl` rather than stacked: a phone must not scroll past a
    // marketing panel to reach a password field, and at `lg` (1024) neither half
    // had room — the card sat in 44px gutters and the headline wrapped to three
    // lines.
    expect(panel).toHaveClass('hidden', 'xl:flex');
  });

  /**
   * Everything in the panel restates the page the form already titles, so to a
   * screen reader it is preamble between the landmark and the task.
   */
  it('hides the panel from assistive technology', () => {
    const { container } = mount();
    expect(container.querySelector('aside')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows exactly one visible wordmark at a time', () => {
    const { container } = mount();
    // Two <img> exist — one per breakpoint — but only the form's carries alt
    // text, so assistive technology is told about the brand once.
    const named = screen.getAllByAltText('OyeChats');
    expect(named).toHaveLength(1);
    expect(named[0]).toHaveClass('xl:hidden');
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  it('offers a way back out of a multi-step flow when given one', () => {
    mount({ back: { to: '/login', label: 'Back to sign in' } });
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('omits the back link when the flow has no step behind it', () => {
    mount();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
