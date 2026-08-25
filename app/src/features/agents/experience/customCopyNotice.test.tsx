import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CustomCopyNotice } from './CustomCopyNotice';
import { MessagesSection } from './MessagesSection';
import { type ExperienceDraft } from './types';

/**
 * H2: customer-authored copy overrides the translated defaults and is shown
 * unchanged in every language. That precedence is correct and is not being
 * changed here; the gap was that nothing told the customer.
 *
 * These tests pin the two halves of the fix: the notice says the right thing,
 * and it appears only where and when it is true.
 */

const NOTICE = /custom text is shown unchanged in all languages/i;

describe('CustomCopyNotice', () => {
  it('states the consequence plainly when multilingual is on', () => {
    render(<CustomCopyNotice multilingual />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
    // The actionable half: an empty field keeps the translated wording.
    expect(screen.getByText(/leave a field empty to keep the translated default/i)).toBeTruthy();
  });

  it('renders nothing on a single-language bot', () => {
    // On a bot that speaks one language there is nothing to mistranslate, so
    // the notice would be noise on every copy field.
    const { container } = render(<CustomCopyNotice multilingual={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('is a note, not an error or a warning', () => {
    // Writing custom copy is a legitimate thing to do. Styling this as a
    // warning would read as "you did something wrong".
    render(<CustomCopyNotice multilingual />);
    expect(screen.getByRole('note')).toBeTruthy();
  });
});

const draft = (): ExperienceDraft =>
  ({
    displayName: 'Acme',
    launcherName: 'Have questions?',
    welcomeTitle: 'Hi there',
    welcomeSubtitle: 'How can we help?',
    quickActions: ['Pricing'],
    suggestionsLayout: 'stack',
    inputPlaceholder: 'Write a message...',
  }) as unknown as ExperienceDraft;

describe('MessagesSection', () => {
  it('shows the notice when the bot is multilingual', () => {
    render(<MessagesSection draft={draft()} onChange={vi.fn()} multilingual />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it('does not show it otherwise', () => {
    render(<MessagesSection draft={draft()} onChange={vi.fn()} multilingual={false} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('defaults to hidden when the flag is not supplied', () => {
    // A caller that has not resolved the bot's language config yet must not
    // flash a notice that may turn out to be wrong.
    render(<MessagesSection draft={draft()} onChange={vi.fn()} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('still renders the copy fields it sits above', () => {
    render(<MessagesSection draft={draft()} onChange={vi.fn()} multilingual />);
    expect(screen.getByLabelText(/display name/i)).toBeTruthy();
    expect(screen.getByLabelText(/launcher text/i)).toBeTruthy();
  });
});
