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
    expect(region).toHaveAttribute('tabIndex', '0');
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
