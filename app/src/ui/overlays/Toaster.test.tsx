import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Toaster } from './Toaster';
import { toast } from './toast';

/**
 * Where a toast is allowed to appear, which is a shorter list than it looks.
 *
 * Every other corner of this app is spoken for:
 *
 * - bottom-right is the OyeChats widget's own launcher, because the app embeds
 *   its own widget;
 * - bottom-centre is the inbox composer, and that is not theoretical — the
 *   live-chat toasts ("You are now talking to X", an accepted invitation, a
 *   transfer) fire at exactly the moment an operator is typing a reply, and
 *   the toast landed on the box they were typing into;
 * - the left edge is the navigation rail.
 *
 * So: top-right, pushed below the top bar. This is pinned because the position
 * reads like a free choice and is not one.
 */
describe('Toaster', () => {
  afterEach(() => {
    toast.dismiss();
  });

  it('sits top-right, away from the composer and the widget launcher', async () => {
    render(<Toaster />);
    toast.success('You are now talking to Siddique Ahmed');

    await screen.findByText('You are now talking to Siddique Ahmed');
    const container = document.querySelector('[data-sonner-toaster]');
    expect(container).not.toBeNull();
    expect(container).toHaveAttribute('data-y-position', 'top');
    expect(container).toHaveAttribute('data-x-position', 'right');
  });

  it('clears the top bar rather than sitting over the breadcrumb', async () => {
    render(<Toaster />);
    toast.info('Priya accepted your invitation');

    await screen.findByText('Priya accepted your invitation');
    const container = document.querySelector<HTMLElement>('[data-sonner-toaster]');
    // Sonner writes the offset onto the container as a custom property. The
    // value is the top-bar token plus a gap, so it is asserted by reference to
    // the token rather than as a pixel count that would need editing whenever
    // the bar's height changes.
    await waitFor(() => {
      expect(container!.style.getPropertyValue('--offset-top')).toContain('--spacing-topbar');
    });
  });
});
