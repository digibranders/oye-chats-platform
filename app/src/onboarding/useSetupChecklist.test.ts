import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSetupChecklist } from './useSetupChecklist';
import type { Bot } from '../types/domain';

/**
 * The two steps that lied.
 *
 * "Make it yours" was struck through on every chatbot ever created, because it
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
    ...over,
  } as Bot);
  return renderHook(() => useSetupChecklist()).result.current;
}

const brandStep = (r: ReturnType<typeof withBot>) => r.steps.find((s) => s.id === 'brand')!;

describe('the "make it yours" step', () => {
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

  it('is done once they move the brand colour off the seeded one', () => {
    expect(brandStep(withBot({ primary_color: '#123456' })).done).toBe(true);
  });

  it('treats the seeded colour case-insensitively', () => {
    expect(brandStep(withBot({ primary_color: '#A21CAF' })).done).toBe(false);
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
});
