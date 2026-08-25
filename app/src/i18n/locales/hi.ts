/**
 * Hindi dictionary for the dashboard UI.
 *
 * Lazily imported by `i18n.ts` the first time Hindi is selected, so an English
 * user never downloads it. Key parity with `en.ts` is enforced by
 * `src/i18n/dictionary-parity.test.ts`.
 */

const hi = {
  common: {
    save: 'सहेजें',
    cancel: 'रद्द करें',
    close: 'बंद करें',
    retry: 'पुनः प्रयास करें',
    loading: 'लोड हो रहा है…',
    search: 'खोजें',
  },
} as const;

export default hi;
