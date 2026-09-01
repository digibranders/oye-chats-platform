import { describe, expect, it } from 'vitest';
import { resolveScopedBotId } from './botScope';
import type { Bot } from '../types/domain';

/**
 * Some surfaces cannot aggregate, and were left with nothing to show.
 *
 * Analytics and Journey gate every query on `enabled: botId != null`, and their
 * endpoints REQUIRE `bot_id` (`/analytics/journey/summary` 422s without it —
 * there is no all-chatbots journey to fetch). They read the shell scope, which
 * is written only by `selectBot` — and the redesign dropped the switcher that
 * called it, leaving ZERO callers in the app. So `selectedBot` could only ever
 * be null, every query stayed disabled, and both pages rendered permanently
 * empty for every account.
 *
 * The fix is not "default to the first chatbot", which would be a lie whenever
 * there are several. It is: when the account HAS only one chatbot, there is
 * nothing to disambiguate, so use it. Every plan below Enterprise caps at one,
 * so this is the state almost every account is in.
 *
 * With two or more and none chosen, it stays null — and the page says to pick
 * one, rather than silently showing a chatbot the reader did not select.
 */
const bot = (id: number) => ({ id, name: `Bot ${id}` }) as Bot;

describe('resolveScopedBotId', () => {
  it('uses the sole chatbot when the account has exactly one', () => {
    // The common case, and the one that was broken for everybody.
    expect(resolveScopedBotId(null, [bot(7)])).toBe(7);
  });

  it('uses an explicit choice over the fallback', () => {
    expect(resolveScopedBotId(bot(8), [bot(7), bot(8)])).toBe(8);
  });

  it('is null when several exist and none is chosen', () => {
    // Not "the first one". Showing one chatbot's numbers under a control that
    // says "All chatbots" would be worse than showing none.
    expect(resolveScopedBotId(null, [bot(7), bot(8)])).toBeNull();
  });

  it('is null when the account has no chatbots', () => {
    expect(resolveScopedBotId(null, [])).toBeNull();
  });

  it('is null while the list is still empty mid-load, even with a stale selection', () => {
    // A selection restored from storage whose chatbot is not in the fetched
    // list is not a chatbot this account can read.
    expect(resolveScopedBotId(bot(99), [])).toBeNull();
  });

  it('ignores a selection that is not in the list', () => {
    // Deleted, or another workspace's. Falling back to the sole remaining
    // chatbot is right; honouring the stale id would 403.
    expect(resolveScopedBotId(bot(99), [bot(7)])).toBe(7);
  });
});
