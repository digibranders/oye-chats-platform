import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupJourney } from './SetupJourney';
import { useSetupChecklist } from './useSetupChecklist';

/**
 * The seam the first run used to drop people through.
 *
 * Submitting a website starts a crawl and lands on that chatbot's Knowledge
 * page. The checklist that knows what follows already existed, but only in the
 * rail's ring, on Home and on `/setup` — three places the customer is not, at
 * the moment they need it.
 *
 * What is pinned here is that this stays a strip and never becomes the wizard
 * it replaced: it gates nothing, every step is reachable, and it takes itself
 * away when the work is done or when asked.
 */
vi.mock('./useSetupChecklist', () => ({ useSetupChecklist: vi.fn() }));

const STEPS = [
  { id: 'create', label: 'Create your chatbot', description: '', done: true, to: '/welcome' },
  { id: 'train', label: 'Give it something to know', description: '', done: false, to: '/chatbots/7/knowledge' },
  { id: 'brand', label: 'Customise your chatbot', description: '', done: false, to: '/chatbots/7/experience' },
  { id: 'install', label: 'Put it on your website', description: '', done: false, to: '/chatbots/7/deploy' },
];

function mountChecklist(over: Partial<ReturnType<typeof useSetupChecklist>> = {}) {
  vi.mocked(useSetupChecklist).mockReturnValue({
    steps: STEPS,
    done: 1,
    total: 4,
    complete: false,
    loading: false,
    ...over,
  } as unknown as ReturnType<typeof useSetupChecklist>);
}

function renderStrip(at = '/') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <SetupJourney workspaceId="ws-1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mountChecklist();
});

describe('the setup journey strip', () => {
  it('names the next action, not just how far along you are', () => {
    renderStrip();
    // A progress count on its own is the thing the first run already had too
    // much of. The point is the verb.
    expect(screen.getByRole('link', { name: 'Next: Give it something to know' })).toHaveAttribute(
      'href',
      '/chatbots/7/knowledge',
    );
    expect(screen.getByText('1/4')).toBeInTheDocument();
  });

  it('shows the whole path, so what comes after this is answerable', () => {
    renderStrip();
    for (const step of STEPS) {
      expect(screen.getAllByRole('link', { name: new RegExp(step.label) }).length).toBeGreaterThan(0);
    }
  });

  it('marks where you are for a screen reader, not only with colour', () => {
    renderStrip();
    // The position is announced, not just tinted: the accessible name carries
    // "(next step)" and the link carries aria-current.
    // The position is announced, not just tinted. Matched loosely because
    // dom-accessibility-api concatenates sibling text nodes without a
    // separator, where a real screen reader inserts one.
    const current = screen.getByRole('link', { name: /Give it something to know\s*\(next step\)/ });
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('link', { name: /Create your chatbot\s*\(done\)/ })).toBeInTheDocument();
  });

  it('gates nothing: a step ahead of the current one is still reachable', () => {
    renderStrip();
    // The flow this replaces trapped people on a step they could not satisfy.
    // Every one of these is a plain link into the real surface.
    expect(screen.getAllByRole('link', { name: /Put it on your website/ })[0]).toHaveAttribute(
      'href',
      '/chatbots/7/deploy',
    );
  });

  it('takes itself away once the work is done', () => {
    mountChecklist({ complete: true });
    const { container } = renderStrip();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the answer is still loading, rather than shifting the page', () => {
    mountChecklist({ loading: true });
    const { container } = renderStrip();
    expect(container).toBeEmptyDOMElement();
  });

  it('can be dismissed, and stays dismissed for that workspace', async () => {
    const { container } = renderStrip();
    await userEvent.click(screen.getByRole('button', { name: /Hide setup steps/i }));
    expect(container).toBeEmptyDOMElement();
    expect(window.localStorage.getItem('oyechats_journey_dismissed_ws-1')).toBe('true');
  });

  it('dismissing one workspace does not dismiss another', () => {
    window.localStorage.setItem('oyechats_journey_dismissed_ws-other', 'true');
    renderStrip();
    expect(screen.getByText('1/4')).toBeInTheDocument();
  });
});

describe('where you are, versus what is next', () => {
  /** The step list only. The "Next: …" button is a link with the same name. */
  function stepLink(name: RegExp) {
    return within(screen.getByRole('list')).getByRole('link', { name });
  }

  /**
   * Two different questions the strip has to answer at once.
   *
   * It used to answer only the second and call it "current", so standing on
   * Deploy you saw "Customise your chatbot" highlighted and NOTHING marking
   * "Put it on your website" -- the step you were looking at. A progress bar
   * that cannot say which of its steps you are on is a list of links.
   */
  it('marks the step whose page you are on', () => {
    renderStrip('/chatbots/7/deploy');
    expect(stepLink(/put it on your website/i)).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('does not mark the next step when you are standing somewhere else', () => {
    // The regression, stated directly: `train` is the next incomplete step, but
    // the reader is on Deploy, so `train` is not where they are.
    renderStrip('/chatbots/7/deploy');
    expect(stepLink(/give it something to know/i)).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('says "you are here" for a reader who gets no ring and no tint', () => {
    renderStrip('/chatbots/7/deploy');
    expect(stepLink(/put it on your website.*you are here/i)).toBeInTheDocument();
  });

  it('still names the next step separately, so both facts survive', () => {
    renderStrip('/chatbots/7/deploy');
    expect(stepLink(/give it something to know.*next step/i)).toBeInTheDocument();
  });

  it('carries both when here and next are the same step', () => {
    renderStrip('/chatbots/7/knowledge');
    const link = stepLink(/give it something to know/i);
    expect(link).toHaveAttribute('aria-current', 'step');
    expect(link.textContent).toMatch(/you are here/i);
    expect(link.textContent).toMatch(/next step/i);
  });

  it('falls back to the next step on a page no step owns', () => {
    // Billing, say. Marking nothing would be worse than marking the truest
    // answer still available.
    renderStrip('/billing');
    expect(stepLink(/give it something to know/i)).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('gives a nested route to the step that owns its section', () => {
    renderStrip('/chatbots/7/knowledge/add');
    expect(stepLink(/give it something to know/i)).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('marks exactly one step, never two', () => {
    renderStrip('/chatbots/7/deploy');
    const marked = within(screen.getByRole('list'))
      .getAllByRole('link')
      .filter((el) => el.getAttribute('aria-current') === 'step');
    expect(marked).toHaveLength(1);
  });
});
