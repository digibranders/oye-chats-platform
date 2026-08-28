import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ZoomPanCanvas } from './ZoomPanCanvas';

describe('ZoomPanCanvas', () => {
  it('is a focusable region with an accessible label', () => {
    render(
      <ZoomPanCanvas label="Journey diagram" viewBoxWidth={1200} viewBoxHeight={420}>
        <circle cx={50} cy={50} r={10} />
      </ZoomPanCanvas>,
    );
    const region = screen.getByRole('application', { name: 'Journey diagram' });
    // `tabindex`, lowercase. SVG attribute names are case-sensitive, and this
    // assertion used to read a camelCase `tabIndex` that an effect set by hand
    // beside React's own — so it passed on the junk copy and would have gone on
    // passing if the real one ever went away. Focusing it is the actual proof.
    expect(region).toHaveAttribute('tabindex', '0');
    region.focus();
    expect(region).toHaveFocus();
  });

  it('rings on a keyboard arrival and stays quiet on a click', async () => {
    // Drag-to-pan is this canvas's primary interaction, so a ring on every
    // click meant a blue outline around the whole diagram all the time.
    // `:focus-visible` does not save us here — on a focusable SVG the
    // browser counts a plain click as focus-visible — but the ring still has
    // to exist for the keyboard, which owns arrow keys / +/- / 0 on this
    // widget (WCAG 2.2 SC 2.4.7).
    const user = userEvent.setup();
    render(
      <ZoomPanCanvas label="Journey diagram" viewBoxWidth={1200} viewBoxHeight={420}>
        <circle cx={50} cy={50} r={10} />
      </ZoomPanCanvas>,
    );
    const region = screen.getByRole('application', { name: 'Journey diagram' });

    await user.click(region);
    expect(region).toHaveFocus();
    expect(region.getAttribute('class')).not.toMatch(/\boutline-2\b/);

    region.blur();
    await user.tab();
    expect(region).toHaveFocus();
    expect(region.getAttribute('class')).toMatch(/\boutline-2\b/);
  });

  it('zooms in on ArrowUp/+ and out on ArrowDown/-, clamped to bounds', async () => {
    const user = userEvent.setup();
    render(
      <ZoomPanCanvas label="Journey diagram" viewBoxWidth={1200} viewBoxHeight={420}>
        <circle cx={50} cy={50} r={10} />
      </ZoomPanCanvas>,
    );
    const region = screen.getByRole('application', { name: 'Journey diagram' });
    region.focus();
    await user.keyboard('+');
    expect(screen.getByText('110%')).toBeInTheDocument();
    for (let i = 0; i < 30; i++) await user.keyboard('+');
    expect(screen.getByText('400%')).toBeInTheDocument();
    for (let i = 0; i < 40; i++) await user.keyboard('-');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('pans on arrow keys and resets on 0', async () => {
    const user = userEvent.setup();
    render(
      <ZoomPanCanvas label="Journey diagram" viewBoxWidth={1200} viewBoxHeight={420}>
        <circle cx={50} cy={50} r={10} />
      </ZoomPanCanvas>,
    );
    const region = screen.getByRole('application', { name: 'Journey diagram' });
    region.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await user.keyboard('0');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('exposes zoom in/out/reset as real buttons, each independently reachable by Tab', async () => {
    const user = userEvent.setup();
    render(
      <ZoomPanCanvas label="Journey diagram" viewBoxWidth={1200} viewBoxHeight={420}>
        <circle cx={50} cy={50} r={10} />
      </ZoomPanCanvas>,
    );
    await user.tab();
    expect(screen.getByRole('application', { name: 'Journey diagram' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Reset view' })).toHaveFocus();
  });
});
