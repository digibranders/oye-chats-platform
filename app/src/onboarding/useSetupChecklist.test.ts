import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSetupChecklist } from './useSetupChecklist';
import type { Bot } from '../types/domain';

/**
 * The two steps that lied.
 *
 * The branding step was struck through on every chatbot ever created, because it
 * asked `Boolean(bot_logo || avatar_type)` and `avatar_type` is a style selector
 * seeded to `'upload'` — true from the moment the row exists. A customer looking
 * at their default colour and empty avatar slot was told they had already done
 * it.
 *
 * "Ask it a question" pointed at Overview, which has no way to ask anything.
 */
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
}));

const bots: Bot[] = [];
vi.mock('../context/BotContext', () => ({
  useBotContext: () => ({ bots, loading: false }),
}));

function withBot(over: Partial<Bot> = {}) {
  bots.length = 0;
  bots.push({
    id: 7,
    name: 'Support',
    // Exactly what a freshly created chatbot carries.
    primary_color: '#a21caf',
    avatar_type: 'upload',
    bot_logo: null,
    bot_logo_source: null,
    manual_field_overrides: [],
    ...over,
  } as Bot);
  return renderHook(() => useSetupChecklist()).result.current;
}

const brandStep = (r: ReturnType<typeof withBot>) => r.steps.find((s) => s.id === 'brand')!;

describe('the branding step', () => {
  it('is not done on a chatbot nobody has touched', () => {
    expect(brandStep(withBot()).done).toBe(false);
  });

  it('is done once the customer sets an avatar', () => {
    expect(brandStep(withBot({ bot_logo: 'k', bot_logo_source: 'manual' })).done).toBe(true);
  });

  it('is done once the customer removes one, which is also a choice', () => {
    // Removal stamps `manual` with no logo left behind. Asking "is there a
    // logo" would read that deliberate act as untouched.
    expect(brandStep(withBot({ bot_logo: null, bot_logo_source: 'manual' })).done).toBe(true);
  });

  it('is NOT done when the crawl derived a favicon', () => {
    // The product did that, not the customer. A picture appearing on its own
    // must not tick a step that says "make it yours".
    expect(brandStep(withBot({ bot_logo: 'fav', bot_logo_source: 'derived' })).done).toBe(false);
  });

  it('is done once they pick a different avatar style', () => {
    expect(brandStep(withBot({ avatar_type: 'orb' })).done).toBe(true);
  });

  it('is done once they SAVE a colour', () => {
    // The signal is provenance, not the value. Saving records the field in
    // `manual_field_overrides`, which is the same list the crawler consults
    // before overwriting anything.
    expect(brandStep(withBot({ manual_field_overrides: ['primary_color'] })).done).toBe(true);
  });

  it('is NOT done when the CRAWL picked the colour', () => {
    // The bug this replaces. Training a chatbot on its own website extracts a
    // brand palette and writes `primary_color`, so `primary_color !== default`
    // was true before anyone had opened Experience — and the checklist struck
    // the step through on work the customer had not done. Same shape as the
    // derived-favicon case below: the product did it, not them.
    expect(brandStep(withBot({ primary_color: '#0c1e2e' })).done).toBe(false);
  });

  it('is done even when the saved colour happens to be the seeded one', () => {
    // Someone who opened the palette and decided the default was right has
    // chosen. Comparing values could never see that; the override record can.
    expect(
      brandStep(withBot({ primary_color: '#a21caf', manual_field_overrides: ['primary_color'] })).done,
    ).toBe(true);
  });

  it('ignores an override for some other field', () => {
    expect(brandStep(withBot({ manual_field_overrides: ['company_name'] })).done).toBe(false);
  });
});

describe('the steps themselves', () => {
  it('does not ask the customer to chat with their own chatbot', () => {
    // "Ask it a question" was removed. Its destination was wrong twice — first
    // Overview, where the instruction cannot be followed, then a standalone
    // screen that hand-rolled a chat UI and so showed a mock-up of the widget
    // rather than the widget. It was never really a setup task either: someone
    // who has trained a chatbot tries it without being told to.
    const ids = withBot().steps.map((s) => s.id);
    expect(ids).not.toContain('test');
    expect(ids).toEqual(['create', 'train', 'brand', 'install', 'lead']);
  });

  it('names each step by what it does, because the strip shows nothing else', () => {
    // `SetupJourney` renders `label` alone and never `description`, so every
    // label has to identify its step unaided. The branding one used to read
    // "Make it yours", which says nothing about which of five steps it is --
    // its meaning lived entirely in a clause the strip does not draw.
    expect(withBot().steps.map((s) => s.label)).toEqual([
      'Create your chatbot',
      'Give it something to know',
      'Customise your chatbot',
      'Put it on your website',
      'Capture your first lead',
    ]);
  });
});
