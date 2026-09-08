import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Drawer } from './Drawer';

/**
 * A drawer the reader can set the width of, and keep.
 *
 * The lead drawer holds a transcript somebody sits and reads. The right width
 * for that is a property of their monitor and their habit, not of the content:
 * on a 1440 screen they want the panel wider, and on a 1280 laptop they want
 * the table behind it to stay legible. A fixed 768 answers neither.
 *
 * The separator itself is `useResizeHandle`, shared with `SplitPane`, so what
 * is asserted here is the drawer's half of the contract: that the stops are the
 * drawer's stops, that the width is remembered, and that a phone gets no
 * handle at all.
 */

const STORAGE_KEY = 'test.drawer.width';

function open(props: Record<string, unknown> = {}) {
  return render(
    <Drawer open onOpenChange={() => {}} title="Siddique" resizable storageKey={STORAGE_KEY} {...props}>
      <p>Body</p>
    </Drawer>,
  );
}

function handle(): HTMLElement {
  return screen.getByRole('separator', { name: /resize the panel/i });
}

function panelWidth(): string {
  const popup = handle().parentElement as HTMLElement;
  return popup.style.getPropertyValue('--drawer-width');
}

describe('a resizable Drawer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // jsdom reports 1024; the ceiling is derived from it, so it is pinned here
    // rather than assumed.
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true });
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('opens at the width its `width` prop names', () => {
    open({ width: 'xl' });
    expect(panelWidth()).toBe('768px');
  });

  it('widens toward the page and narrows back, from the keyboard', async () => {
    // The panel is at the inline end, so the handle is on its left and the key
    // that widens is the one pointing away from the panel: Left, in LTR.
    open({ width: 'xl' });
    const user = userEvent.setup();
    handle().focus();

    await user.keyboard('{ArrowLeft}');
    expect(panelWidth()).toBe('784px');

    await user.keyboard('{ArrowRight}');
    expect(panelWidth()).toBe('768px');
  });

  it('moves in bigger steps with shift held', async () => {
    open({ width: 'xl' });
    const user = userEvent.setup();
    handle().focus();
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(panelWidth()).toBe('832px');
  });

  it('stops at a width that still leaves the page behind it visible', async () => {
    // A drawer that covers everything is a route change wearing a scrim: the
    // reader loses the row they opened it from, which is the reason this is a
    // drawer at all. 1440 viewport, 320 of page kept.
    open({ width: 'xl' });
    const user = userEvent.setup();
    handle().focus();
    await user.keyboard('{End}');
    expect(panelWidth()).toBe('1120px');
  });

  it('stops at a width a property grid can still lay out in', async () => {
    open({ width: 'xl' });
    const user = userEvent.setup();
    handle().focus();
    await user.keyboard('{Home}');
    expect(panelWidth()).toBe('512px');
  });

  it('reports where it is, so a screen-reader user hears the number change', () => {
    open({ width: 'xl' });
    expect(handle()).toHaveAttribute('aria-valuenow', '768');
    expect(handle()).toHaveAttribute('aria-valuemin', '512');
    expect(handle()).toHaveAttribute('aria-valuemax', '1120');
  });

  it('remembers the width for next time', async () => {
    const first = open({ width: 'xl' });
    const user = userEvent.setup();
    handle().focus();
    await user.keyboard('{ArrowLeft}');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('784');
    first.unmount();

    open({ width: 'xl' });
    expect(panelWidth()).toBe('784px');
  });

  it('clamps a remembered width that no longer fits the window', () => {
    // The width outlives the monitor it was chosen on. Restoring 1200px onto a
    // 900px laptop would open a drawer wider than the screen.
    window.localStorage.setItem(STORAGE_KEY, '1200');
    Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true, writable: true });
    open({ width: 'xl' });
    expect(panelWidth()).toBe('580px');
  });

  it('still drags when the browser refuses to remember anything', async () => {
    // Private browsing, a full quota, a blocked origin. A remembered width is a
    // convenience and is not worth taking the panel down for.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    open({ width: 'xl' });
    const user = userEvent.setup();
    handle().focus();
    await user.keyboard('{ArrowLeft}');
    expect(panelWidth()).toBe('784px');
  });

  it('has no handle at all when it was not asked for', () => {
    render(
      <Drawer open onOpenChange={() => {}} title="Siddique" width="xl">
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.queryByRole('separator')).toBeNull();
  });
});
