import { useMemo } from 'react';
import { RadioCards, SettingGroup, SettingRow } from '../../ui';
import { useLocaleCatalog } from '../../hooks/useLocaleCatalog';
import { ADMIN_UI_LANGUAGES, setLocale } from '../../i18n/i18n';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * The language the dashboard itself is read in.
 *
 * The control the whole multilingual programme was missing. Dictionaries, a
 * provider, locale-aware formatters and a translated backend catalogue all
 * shipped before there was any way for a customer to choose between them, so
 * every one of them was unreachable.
 *
 * **It is not the chatbot's language, and it is not the operator's.** A
 * chatbot's visitor-facing languages are set per chatbot under Experience, and
 * an operator's live-chat working language is set in the inbox and is metered
 * in credits. This one is a presentation preference for this browser, held in
 * `localStorage`, and it issues no write of any kind — deriving one from the
 * other is the mistake that would silently start charging someone for changing
 * their own interface language.
 */

/**
 * The one BCP-47 tag each shipped language is offered as.
 *
 * The dashboard picks a LANGUAGE, not a region: one `hi` dictionary serves
 * every Hindi region. A concrete tag is still needed because the formatters
 * take one, and `en-IN` is the platform's own default.
 */
const UI_LOCALE: Readonly<Record<string, { locale: string; endonym: string }>> = {
  // An ENDONYM — a language's name in its own language — is identical whatever
  // the interface language is: English stays "English" on a Hindi dashboard,
  // and हिन्दी stays हिन्दी on an English one. Translating one would defeat
  // the point of showing it.
  en: { locale: 'en-IN', endonym: 'English' },
  hi: { locale: 'hi-IN', endonym: 'हिन्दी' },
};

export function LanguageSection() {
  const { t, locale } = useTranslation();
  const { localeNameFor } = useLocaleCatalog();

  const options = useMemo(
    () =>
      // Only languages this build actually ships a dictionary for. Offering one
      // without would render an English console under a Hindi label.
      ADMIN_UI_LANGUAGES.flatMap((language) => {
        const entry = UI_LOCALE[language];
        return entry
          ? [
              {
                value: entry.locale,
                label: entry.endonym,
                description: localeNameFor(entry.locale) ?? entry.locale,
              },
            ]
          : [];
      }),
    [localeNameFor],
  );

  return (
    <SettingGroup title={t('settings.language.title') || 'Language'}>
      <SettingRow
        label={t('settings.language.label') || 'Dashboard language'}
        description={
          t('settings.language.description') ||
          'Applies to this browser only. Your chatbots answer visitors in the languages you set per chatbot.'
        }
        stacked
      >
        <RadioCards
          items={options}
          value={locale}
          onChange={setLocale}
          label={t('settings.language.label') || 'Dashboard language'}
          columns={2}
        />
      </SettingRow>
    </SettingGroup>
  );
}
