import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBreadcrumbs } from './useBreadcrumbs';
import { __resetI18nForTests, preloadDictionary, setLocale } from '../i18n/i18n';

/**
 * The breadcrumb, across a language switch and back.
 *
 * `useBreadcrumbs` subscribes to the locale, so a switch re-renders its
 * consumers. That is necessary and it is not sufficient: the trail is built
 * inside a `useMemo`, and neither `pathname` nor `bots` changes when only the
 * language does. With the locale missing from the dependency array React
 * handed back the array it had memoised in the PREVIOUS language, so the bar
 * kept the old word until you navigated somewhere else.
 *
 * That is what shipped, and it is what a user sees: switch to Hindi, switch
 * back to English, and the top-left of Settings still reads "खाता".
 *
 * Asserting on the hook's OUTPUT rather than on the dictionary. The Hindi and
 * English strings were both present and correct the whole time; what was wrong
 * was which one the memo was willing to recompute.
 */

// A STABLE context value, deliberately. The real BotContext memoises what it
// provides, so `bots` keeps its identity across a re-render that only changed
// the language - which is the precondition for the stale-memo bug. A mock that
// returns a fresh `[]` each call silently invalidates the memo on every render
// and makes this whole file pass against the unfixed hook.
const BOT_CONTEXT = { bots: [] as unknown[], selectedBot: null, loading: false };
vi.mock('../context/BotContext', () => ({
  useBotContext: () => BOT_CONTEXT,
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/settings']}>{children}</MemoryRouter>
);

afterEach(() => {
  __resetI18nForTests();
});

describe('breadcrumbs follow the UI language', () => {
  it('re-resolves the trail on a switch, and again on the switch back', async () => {
    await preloadDictionary('hi-IN');

    const { result } = renderHook(() => useBreadcrumbs(), { wrapper });

    const english = result.current.at(-1)?.label;
    expect(english).toBeTruthy();

    act(() => setLocale('hi-IN'));
    const hindi = result.current.at(-1)?.label;
    expect(hindi).toBeTruthy();
    expect(hindi).not.toBe(english);

    // The half the memo bug broke. Going TO Hindi looked fine on a fresh mount,
    // because the first render populated the memo. Coming BACK is where the
    // stale entry showed, and it is the exact path the bug was reported on.
    act(() => setLocale('en-IN'));
    expect(result.current.at(-1)?.label).toBe(english);
  });

  it('keeps following the language after the path has changed once', async () => {
    // Navigation is the one thing that DID invalidate the old memo, so a test
    // that only ever switches on a fresh mount would pass against the bug.
    await preloadDictionary('hi-IN');

    const { result, rerender } = renderHook(() => useBreadcrumbs(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/settings']}>{children}</MemoryRouter>
      ),
    });

    act(() => setLocale('hi-IN'));
    const hindi = result.current.at(-1)?.label;

    rerender();
    expect(result.current.at(-1)?.label).toBe(hindi);

    act(() => setLocale('en-IN'));
    expect(result.current.at(-1)?.label).not.toBe(hindi);
  });
});
