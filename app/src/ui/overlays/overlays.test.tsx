import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Alert } from '../feedback/Alert';
import { Button } from '../primitives/Button';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { Drawer } from './Drawer';
import {
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from './Menu';
import { PopoverBody, PopoverContent, PopoverFooter, PopoverHeader, PopoverRoot, PopoverTrigger } from './Popover';

/**
 * Overlay contracts that are invisible until someone opens the thing.
 *
 * The first case here is the reason the file exists: a menu containing a group
 * label threw and unmounted the whole route, and the suite passed because
 * nothing in it had ever opened one.
 */

function classesOf(element: Element | null): string {
  return element?.getAttribute('class') ?? '';
}

describe('Menu', () => {
  it('opens a menu containing a group label without throwing', async () => {
    // `Menu.GroupLabel` is a part of `Menu.Group` and throws
    // `MenuGroupContext is missing` outside one. `MenuLabel` rendered the label
    // alone, so clicking "Row actions" in `/dev/ui` took the page down.
    const user = userEvent.setup();
    render(
      <MenuRoot>
        <MenuTrigger render={<Button>Row actions</Button>} />
        <MenuContent>
          <MenuLabel>Chatbot</MenuLabel>
          <MenuItem onSelect={() => {}}>Rename</MenuItem>
          <MenuSeparator />
          <MenuGroup label="Columns">
            <MenuCheckboxItem checked onCheckedChange={() => {}}>
              Status
            </MenuCheckboxItem>
          </MenuGroup>
        </MenuContent>
      </MenuRoot>,
    );

    await user.click(screen.getByRole('button', { name: 'Row actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Chatbot')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Status' })).toBeChecked();
  });

  it('indents a plain item and a checkbox item to the same column', async () => {
    const user = userEvent.setup();
    render(
      <MenuRoot>
        <MenuTrigger render={<Button>Columns</Button>} />
        <MenuContent>
          <MenuItem onSelect={() => {}}>Reset columns</MenuItem>
          <MenuCheckboxItem checked onCheckedChange={() => {}}>
            Status
          </MenuCheckboxItem>
        </MenuContent>
      </MenuRoot>,
    );
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const menu = await screen.findByRole('menu');
    // A column picker with a "Reset" command beside it showed a ragged left
    // edge: 8px against 28px.
    expect(classesOf(within(menu).getByRole('menuitem', { name: 'Reset columns' }))).toContain(
      'pl-7',
    );
    expect(classesOf(within(menu).getByRole('menuitemcheckbox', { name: 'Status' }))).toContain(
      'pl-7',
    );
  });

  it('lets a plain item report that it is the current choice', async () => {
    const user = userEvent.setup();
    render(
      <MenuRoot>
        <MenuTrigger render={<Button>Sort</Button>} />
        <MenuContent>
          <MenuItem selected onSelect={() => {}}>
            Newest first
          </MenuItem>
          <MenuItem onSelect={() => {}}>Oldest first</MenuItem>
        </MenuContent>
      </MenuRoot>,
    );
    await user.click(screen.getByRole('button', { name: 'Sort' }));
    const menu = await screen.findByRole('menu');
    const current = within(menu).getByRole('menuitem', { name: 'Newest first' });
    const other = within(menu).getByRole('menuitem', { name: 'Oldest first' });
    expect(current.querySelector('svg')).not.toBeNull();
    expect(other.querySelector('svg')).toBeNull();
  });

  it('puts the z-index on the positioned element, not on the static popup', async () => {
    const user = userEvent.setup();
    render(
      <MenuRoot>
        <MenuTrigger render={<Button>Actions</Button>} />
        <MenuContent>
          <MenuItem onSelect={() => {}}>Rename</MenuItem>
        </MenuContent>
      </MenuRoot>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const popup = await screen.findByRole('menu');
    // Base UI positions the parent and leaves the popup static, where a
    // `z-index` is simply ignored — so the documented ladder governed nothing.
    expect(classesOf(popup)).not.toContain('z-[var(--z-overlay)]');
    expect(classesOf(popup.parentElement)).toContain('z-[var(--z-overlay)]');
  });

  it('opens a submenu from its trigger', async () => {
    const user = userEvent.setup();
    render(
      <MenuRoot>
        <MenuTrigger render={<Button>More</Button>} />
        <MenuContent>
          <MenuSub>
            <MenuSubTrigger>Move to</MenuSubTrigger>
            <MenuSubContent>
              <MenuItem onSelect={() => {}}>Archive</MenuItem>
            </MenuSubContent>
          </MenuSub>
        </MenuContent>
      </MenuRoot>,
    );
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
  });
});

describe('Popover', () => {
  it('scrolls its body, not the panel, so a header and a footer survive a long list', async () => {
    const user = userEvent.setup();
    render(
      <PopoverRoot>
        <PopoverTrigger render={<Button>Filters</Button>} />
        <PopoverContent>
          <PopoverHeader>Filter leads</PopoverHeader>
          <PopoverBody>
            <p>Everything</p>
          </PopoverBody>
          <PopoverFooter>
            <Button size="sm">Apply</Button>
          </PopoverFooter>
        </PopoverContent>
      </PopoverRoot>,
    );
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const popup = await screen.findByRole('dialog');
    expect(classesOf(popup)).toContain('overflow-hidden');
    expect(classesOf(popup)).not.toContain('overflow-y-auto');
    // The scroll region is the body, and it carries the 20px inset a focus ring
    // needs in order not to be clipped by its own scroll container.
    const body = within(popup).getByText('Everything').parentElement;
    expect(classesOf(body)).toContain('overflow-y-auto');
    expect(classesOf(body)).toContain('p-5');
    expect(within(popup).getByRole('button', { name: 'Apply' })).toBeInTheDocument();
  });
});

describe('Dialog and Drawer share one padding contract', () => {
  it('clips its own body so a footerless dialog cannot square off the panel corners', () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Invite a teammate">
        <p>Body</p>
      </Dialog>,
    );
    expect(classesOf(screen.getByRole('dialog'))).toContain('overflow-hidden');
  });

  it('keeps the close button on the title when an eyebrow pushes it down', () => {
    render(
      <Dialog
        open
        onOpenChange={() => {}}
        eyebrow="You already have one chatbot on Free"
        title="Upgrade to add another"
      >
        <p>Body</p>
      </Dialog>,
    );
    // Positioned rather than laid out: in a flex row it top-aligned and drifted
    // 21px above the title the moment an eyebrow existed.
    const close = screen.getByRole('button', { name: 'Close' });
    expect(classesOf(close.parentElement)).toContain('absolute');
  });

  it('gives the drawer the eyebrow and the leading radius the doc asks for', () => {
    render(
      <Drawer open onOpenChange={() => {}} eyebrow="Lead" title="Ana Ruiz">
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.getByText('Lead')).toBeInTheDocument();
    expect(classesOf(screen.getByRole('dialog'))).toContain('sm:rounded-l-xl');
  });
});

describe('ConfirmDialog', () => {
  it('keeps the confirm label while the action is in flight', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete chatbot"
        description="Its knowledge base goes with it."
        confirmLabel="Delete chatbot"
        destructive
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete chatbot' }));
    // It used to swap the label for "Working…", reflowing the footer and losing
    // the spinner, in the one dialog where the user most needs to know what
    // they pressed.
    const confirm = screen.getByRole('button', { name: 'Delete chatbot' });
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    release();
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
  });

  it('says why the confirm button is blocked, and wires the reason to the button', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete chatbot"
        description="This cannot be undone."
        confirmLabel="Delete"
        confirmPhrase="Acme Support"
        onConfirm={() => {}}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription('Type the name exactly to continue.');
  });
});

describe('Alert', () => {
  it('draws the neutral rule as a clipped block, not as a mitred border', () => {
    const { container } = render(<Alert>Training finished.</Alert>);
    const alert = container.firstElementChild;
    // A 3px left border on an 8px radius is mitred into the corner arc and
    // tapers to a point at both ends — the system's signature notice, visibly
    // broken everywhere it appeared.
    expect(classesOf(alert)).toContain('overflow-hidden');
    expect(classesOf(alert)).toContain('before:w-[3px]');
    expect(classesOf(alert)).not.toContain('border-l-');
  });

  it('never borders a tinted alert with an opacity modifier', () => {
    const { container } = render(
      <Alert tone="danger" title="Payment failed">
        Your card was declined.
      </Alert>,
    );
    expect(classesOf(container.firstElementChild)).not.toMatch(/border-\w+\/\d+/);
  });

  it('tone-matches an action sitting on a tint instead of painting it white', () => {
    const { container } = render(
      <Alert tone="warning" action={<Button size="sm">Buy credits</Button>}>
        You are nearly out of credits.
      </Alert>,
    );
    const slot = screen.getByRole('button', { name: 'Buy credits' }).parentElement;
    expect(classesOf(slot)).toContain('[&_button]:bg-transparent');
    // A one-line alert centres its action; a titled one pins it to the title.
    expect(classesOf(slot)).toContain('self-center');
    expect(container.firstElementChild).toHaveAttribute('data-tone', 'warning');
  });
});

describe('a dialog that owns state', () => {
  it('returns focus to its trigger when it closes', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open</Button>
          <Dialog open={open} onOpenChange={setOpen} title="Invite a teammate">
            <p>Body</p>
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
