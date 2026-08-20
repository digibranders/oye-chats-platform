import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, CardBody, CardHeader } from './Card';
import { Measure } from './Measure';
import { Columns } from './Columns';
import { Grid } from './Grid';
import { Page } from './Page';
import { PaneHeader } from './PaneHeader';
import { SidebarLayout } from './SidebarLayout';

/**
 * The composition layer's contracts are mostly geometry, which a jsdom test
 * cannot see — no stylesheet is applied, so a container query is a class name
 * and nothing more. What *is* testable here is the part that goes wrong
 * silently: the elements and roles these primitives emit, and the two defaults
 * a reviewer would otherwise have to take on trust.
 */

describe('Page', () => {
  it('never centres its box, so the left edge is the same on every route', () => {
    // Both widths used to be `mx-auto`, which slid the title, the tab row and
    // every card 148px sideways at 1440 going from a wide page to a narrow one.
    const { container, rerender } = render(<Page width="page">Home</Page>);
    expect(container.firstElementChild?.className).not.toMatch(/\bmx-auto\b/);

    rerender(<Page width="default">Settings</Page>);
    expect(container.firstElementChild?.className).not.toMatch(/\bmx-auto\b/);
  });

  it('carries density as one attribute on the root rather than as forty props', () => {
    const { container, rerender } = render(<Page density="dense">Ops</Page>);
    expect(container.firstElementChild).toHaveAttribute('data-density', 'dense');

    rerender(<Page>Ops</Page>);
    expect(container.firstElementChild).not.toHaveAttribute('data-density');
  });
});

describe('Measure', () => {
  it('is a measure, not a centred column', () => {
    const { container } = render(<Measure width="form">Form</Measure>);
    expect(container.firstElementChild?.className).toContain('max-w-form');
    expect(container.firstElementChild?.className).not.toMatch(/\bmx-auto\b/);
  });
});

describe('Grid', () => {
  it('is a list when its children are a list of one kind of thing', () => {
    render(
      <Grid cols={3} as="ul" label="Chatbots">
        <Card as="li">One</Card>
        <Card as="li">Two</Card>
      </Grid>,
    );
    const list = screen.getByRole('list', { name: 'Chatbots' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('Columns', () => {
  it('puts an aside on the start edge first in the DOM as well as visually', () => {
    // Reordering with `order-*` leaves the tab sequence in source order, so a
    // keyboard user tabs from the first visible column into the last one.
    const { container } = render(
      <Columns asidePosition="start" asideLabel="Summary" main={<p>Main</p>} aside={<p>Aside</p>} />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.firstElementChild?.tagName).toBe('ASIDE');
    expect(screen.getByRole('complementary', { name: 'Summary' })).toBeInTheDocument();
  });
});

describe('SidebarLayout', () => {
  it('names its nav landmark and owns the list direction', () => {
    render(
      <SidebarLayout navLabel="Workspace settings" nav={<a href="/general">General</a>}>
        <p>Content</p>
      </SidebarLayout>,
    );
    const nav = screen.getByRole('navigation', { name: 'Workspace settings' });
    expect(within(nav).getByRole('link', { name: 'General' })).toBeInTheDocument();
  });
});

describe('PaneHeader', () => {
  it('gives a pane a real heading, at the level the caller asks for', () => {
    render(<PaneHeader title="Conversations" titleAs="h3" actions={<button type="button">Filter</button>} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Conversations' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
  });
});

describe('Card', () => {
  it('marks its bands so the card, not the band, draws the rule between them', () => {
    // A header drawing `border-b` and a section drawing `border-t` painted a
    // doubled 2px rule, and a header-only card drew a square-ended line across
    // its own rounded bottom edge.
    const { container } = render(
      <Card>
        <CardHeader title="Usage" />
        <CardBody>Body</CardBody>
      </Card>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.querySelectorAll('[data-card-band]')).toHaveLength(2);
    expect(card.querySelector('[data-card-band]')?.className).not.toContain('border-b');
  });

  it('is a div unless the caller says otherwise', () => {
    // `section` was the default, so a grid of cards was a grid of would-be
    // landmarks, and `AgentsPage` renders its cards inside a `ul`.
    const { container } = render(<Card>Body</Card>);
    expect(container.firstElementChild?.tagName).toBe('DIV');
  });

  it('drops the eyebrow at widget size, where the whole header is 40px', () => {
    render(<CardHeader size="sm" eyebrow="Conversations" title="Conversations" />);
    expect(screen.queryByText('Conversations', { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Conversations' })).toBeInTheDocument();
  });
});
