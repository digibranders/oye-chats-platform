import { describe, expect, it, vi } from 'vitest';

/**
 * `settingLabel`/`settingHint` build a key from the label and ask `t()` for
 * it — the same contract `navLabel`/`navHint` already have. Mocking `t`
 * proves the KEY SHAPE is right (`app.setting.<crumbKey>` /
 * `setting.hint.<crumbKey>`) without needing any dictionary populated: none
 * is, by design — see the spec's "Translation, following the existing rule
 * exactly" section.
 */
vi.mock('../i18n/i18n', () => ({
  t: (key: string) => {
    if (key === 'app.setting.businessHours') return 'व्यापार के घंटे';
    if (key === 'setting.hint.businessHours') return 'जब आपकी टीम उपलब्ध हो';
    return null;
  },
}));

import { settingHint, settingLabel } from './navCopy';

describe('settingLabel', () => {
  it('resolves the key built from the label, in its own namespace', () => {
    expect(settingLabel('Business Hours')).toBe('व्यापार के घंटे');
  });

  it('falls back to the English label when nothing is translated yet', () => {
    expect(settingLabel('Something Nobody Translated')).toBe('Something Nobody Translated');
  });
});

describe('settingHint', () => {
  it('resolves the key built from the label, in its own namespace', () => {
    expect(settingHint('Business Hours', "When the chatbot's people are around")).toBe(
      'जब आपकी टीम उपलब्ध हो',
    );
  });

  it('falls back to the English hint when nothing is translated yet', () => {
    expect(settingHint('Something Nobody Translated', 'Fallback hint')).toBe('Fallback hint');
  });
});
