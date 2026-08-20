import { Inbox as InboxIcon, Settings } from 'lucide-react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RailBackLink, RailFrame, RailGroupLabel, RailItem } from './RailFrame';
import { TooltipProvider } from '../overlays/Tooltip';

function rail(children: React.ReactNode, path = '/inbox') {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <RailFrame navLabel="Main" header={<span>Acme</span>} footer={<span>Account</span>}>
          {children}
        </RailFrame>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

describe('RailFrame', () => {
  it('is a named nav landmark holding a real list of destinations', () => {
    rail(
      <>
        <RailItem to="/inbox" label="Inbox" glyph={<InboxIcon aria-hidden />} />
        <RailItem to="/settings" label="Settings" glyph={<Settings aria-hidden />} />
      </>,
    );

    const nav = screen.getByRole('navigation', { name: 'Main' });
    // A list, so a screen-reader user is told how many destinations there are
    // before they start moving through them. One rail used `ul`/`li` and the
    // other used bare divs.
    expect(within(nav).getAllByRole('listitem')).toHaveLength(2);
  });

  it('marks the current destination with aria-current, not only with a fill', () => {
    rail(
      <>
        <RailItem to="/inbox" label="Inbox" glyph={<InboxIcon aria-hidden />} />
        <RailItem to="/settings" label="Settings" glyph={<Settings aria-hidden />} />
      </>,
    );
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
  });

  it('lets a shell that computes its own active state say so', () => {
    // The platform console does: several of its destinations are prefixes of
    // each other and `NavLink`'s own matching gets it wrong.
    rail(<RailItem to="/platform/revenue" label="Revenue" glyph={<Settings aria-hidden />} active />);
    expect(screen.getByRole('link', { name: 'Revenue' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps a collapsed item named, and explains it on hover', async () => {
    const user = userEvent.setup();
    rail(<RailItem to="/inbox" label="Inbox" glyph={<InboxIcon aria-hidden />} collapsed />);

    // The visible label is gone; the accessible one is not. A 60px rail of
    // unlabelled icons is unusable with a screen reader and merely a guessing
    // game with one.
    const link = screen.getByRole('link', { name: 'Inbox' });
    await user.hover(link);
    // Twice: once in the link's own screen-reader-only label, once in the
    // tooltip that just opened. `findAllBy` would resolve on the first of the
    // two and never wait for the second.
    await waitFor(() => expect(screen.getAllByText('Inbox')).toHaveLength(2));
  });

  it('drops a group label to a hairline when the rail is collapsed', () => {
    const { rerender } = rail(<RailGroupLabel>Money</RailGroupLabel>);
    expect(screen.getByText('Money')).toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <MemoryRouter>
          <RailFrame navLabel="Main" header={<span>Acme</span>}>
            <RailGroupLabel collapsed>Money</RailGroupLabel>
          </RailFrame>
        </MemoryRouter>
      </TooltipProvider>,
    );
    expect(screen.queryByText('Money')).not.toBeInTheDocument();
  });

  it('closes the mobile drawer when a destination is chosen', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    rail(
      <>
        <RailBackLink to="/agents" onNavigate={onNavigate}>
          All chatbots
        </RailBackLink>
        <RailItem
          to="/settings"
          label="Settings"
          glyph={<Settings aria-hidden />}
          onNavigate={onNavigate}
        />
      </>,
    );

    await user.click(screen.getByRole('link', { name: 'All chatbots' }));
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
});
