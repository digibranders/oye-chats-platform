import { describe, expect, it, vi } from 'vitest';
import {
  __clearDictionariesForTests,
  __resetI18nForTests,
  getLocale,
  preloadDictionary,
  setLocale,
  subscribeLocale,
  t,
} from './i18n';

/**
 * A RESTORED preference has to re-render the tree when its dictionary lands.
 *
 * This is the defect that made the whole dashboard look unlocalized. On a cold
 * load the dictionary is not in memory, so the first paint is English by
 * design; `I18nProvider` then calls `preloadDictionary` to fetch it. That call
 * loaded the chunk and told nobody. `useTranslation` subscribes to the store's
 * token, the token never moved, so React never re-rendered and every string
 * stayed on the English it had already painted.
 *
 * `setLocale` always notified after its own fetch, which is exactly why the
 * language picker appeared to work and a reload appeared not to — the bug was
 * invisible to anyone testing the switch itself.
 */
describe('a locale restored from storage', () => {
  it('notifies subscribers once its dictionary arrives', async () => {
    // `setLocale` establishes the locale the way a restored preference does.
    // Its OWN async load has to be allowed to settle first, or its notify is
    // what the listener sees and this test passes against the bug — which is
    // exactly what happened on the first attempt.
    __resetI18nForTests();
    setLocale('hi-IN');
    await preloadDictionary('hi-IN');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Now the cold-load state: locale known, dictionary absent.
    __clearDictionariesForTests();

    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);

    // The first paint renders in this state: Hindi selected, nothing resolving.
    expect(getLocale()).toBe('hi-IN');
    expect(t('auth.signIn')).toBeNull();

    await preloadDictionary('hi-IN');

    expect(listener).toHaveBeenCalled();
    expect(t('auth.signIn')).toBe('साइन इन');
    unsubscribe();
    __resetI18nForTests();
  });

  it('does not notify when the dictionary was already in memory', async () => {
    __resetI18nForTests();
    setLocale('hi-IN');
    await preloadDictionary('hi-IN');

    // A second preload is a no-op; re-rendering the tree for it would be noise.
    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);
    await preloadDictionary('hi-IN');
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    __resetI18nForTests();
  });

  it('still switches in-session, which always worked', async () => {
    __resetI18nForTests();
    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);
    setLocale('hi-IN');
    await preloadDictionary('hi-IN');
    expect(listener).toHaveBeenCalled();
    expect(t('auth.signIn')).toBe('साइन इन');
    unsubscribe();
    __resetI18nForTests();
  });
});
