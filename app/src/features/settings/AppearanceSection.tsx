import { type KeyboardEvent, type ReactElement, useMemo, useRef } from 'react';
import { Check, Circle, Contrast, Languages, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import {
  Card,
  SectionHeader,
  cn,
  useTheme,
  type Contrast as ContrastLevel,
  type Theme,
} from '../../design-system';
import useLocaleCatalog from '../../hooks/useLocaleCatalog';
import { ADMIN_UI_LANGUAGES, setLocale } from '../../i18n/i18n';
import { useTranslation } from '../../i18n/useTranslation';

interface Option<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

/**
 * The one BCP-47 tag each shipped UI language is offered as.
 *
 * The dashboard picks a language, not a region: shipping `en` and `hi`
 * dictionaries means every English region reads the same strings. A concrete
 * tag is still needed because the formatters take one, and `en-IN` matches the
 * platform's default in `KNOWN_LOCALES`.
 *
 * Names come from the catalogue (`GET /locales`) so `KNOWN_LOCALES` stays the
 * only registry; the endonyms below are the pre-catalogue fallback, and a
 * language's own name is the one string that must never be translated.
 */
// @i18n-exempt: an ENDONYM is a language's name in its own language, so it is
// identical whatever the interface language is - English stays "English" on a
// Hindi dashboard, and हिन्दी stays हिन्दी on an English one. Translating one
// would defeat the purpose of showing it.
const UI_LOCALE_FOR_LANGUAGE: Readonly<Record<string, { locale: string; endonym: string }>> = {
  en: { locale: 'en-IN', endonym: 'English' },
  hi: { locale: 'hi-IN', endonym: 'हिन्दी' },
};

/**
 * A single labelled radiogroup, one row per option. Arrow keys rove focus AND
 * select (native `<input type="radio">` behaviour), Home / End jump to the
 * first / last option, and only the checked option is in the tab order so Tab
 * steps past the group in one stop. Generic over the option id so the Theme
 * and Contrast axes share one accessible implementation.
 */
function OptionGroup<T extends string>({
  legend,
  legendId,
  options,
  value,
  onSelect,
}: {
  legend: string;
  legendId: string;
  options: readonly Option<T>[];
  value: T;
  onSelect: (id: T, event?: React.MouseEvent) => void;
}): ReactElement {
  const optionRefs = useRef<Partial<Record<T, HTMLButtonElement>>>({});

  const selectAndFocus = (id: T): void => {
    onSelect(id);
    optionRefs.current[id]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % options.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + options.length) % options.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = options[nextIndex];
    if (next) selectAndFocus(next.id);
  };

  return (
    <div className="space-y-2">
      <p id={legendId} className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
        {legend}
      </p>
      <div role="radiogroup" aria-labelledby={legendId} className="grid gap-2">
        {options.map((option, index) => {
          const Icon = option.icon;
          const active = value === option.id;
          return (
            <button
              key={option.id}
              ref={(node) => {
                if (node) optionRefs.current[option.id] = node;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={(e) => onSelect(option.id, e)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                'group relative flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                active
                  ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                  : 'border-[var(--ds-border)] hover:border-[var(--ds-border-strong)] hover:bg-[var(--ds-bg-sunken)]',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                  active
                    ? 'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]'
                    : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]',
                )}
              >
                <Icon size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-[var(--ds-text)]">{option.label}</p>
                <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">{option.description}</p>
              </div>
              {active && (
                <span
                  aria-hidden="true"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]"
                >
                  <Check size={11} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * AppearanceSection - the Settings > Appearance surface. Two independent axes,
 * GitHub-style: Theme (light / dark / system) on the left, Contrast (default /
 * high) on the right. Pure client state via the design-system `useTheme` hook
 * (`ThemeProvider` persists both choices and applies them before first paint) -
 * no network calls.
 */
export function AppearanceSection(): ReactElement {
  const { theme, resolvedTheme, setTheme, contrast, setContrast } = useTheme();
  const { t, locale } = useTranslation();
  const { localeNameFor } = useLocaleCatalog();

  // Rebuilt whenever the language changes. As module constants these froze
  // their English at import, so switching language left the option labels in
  // the previous language while the rest of the screen updated.
  const themeOptions = useMemo<readonly Option<Theme>[]>(
    () => [
      {
        id: 'light',
        label: t('settings.appearance.theme.light') || 'Light',
        description: t('settings.appearance.theme.lightDesc') || 'Bright, paper-white surfaces.',
        icon: Sun,
      },
      {
        id: 'dark',
        label: t('settings.appearance.theme.dark') || 'Dark',
        description: t('settings.appearance.theme.darkDesc') || 'Dimmed surfaces for low-light work.',
        icon: Moon,
      },
      {
        id: 'system',
        label: t('settings.appearance.theme.system') || 'System',
        description: t('settings.appearance.theme.systemDesc') || 'Match your device appearance.',
        icon: Monitor,
      },
    ],
    [t],
  );

  const contrastOptions = useMemo<readonly Option<ContrastLevel>[]>(
    () => [
      {
        id: 'default',
        label: t('settings.appearance.contrast.default') || 'Default',
        description: t('settings.appearance.contrast.defaultDesc') || 'Standard color and depth.',
        icon: Circle,
      },
      {
        id: 'high',
        label: t('settings.appearance.contrast.high') || 'High contrast',
        description:
          t('settings.appearance.contrast.highDesc') || 'Stronger text and borders (WCAG AAA).',
        icon: Contrast,
      },
    ],
    [t],
  );

  // Only languages this build actually ships a dictionary for. Offering one
  // without a dictionary would render an English console under a Hindi label.
  const languageOptions = useMemo<readonly Option<string>[]>(
    () =>
      ADMIN_UI_LANGUAGES.flatMap((language) => {
        const entry = UI_LOCALE_FOR_LANGUAGE[language];
        if (!entry) return [];
        return [
          {
            id: entry.locale,
            // A language's own name stays in that language, always.
            label: entry.endonym,
            description: localeNameFor(entry.locale) ?? entry.locale,
            icon: Languages,
          },
        ];
      }),
    [localeNameFor],
  );

  return (
    <section aria-labelledby="appearance-heading" className="space-y-4">
      <SectionHeader
        title={<span id="appearance-heading">{t('settings.appearance.title') || 'Appearance'}</span>}
        description={
          theme === 'system'
            ? t('settings.appearance.descriptionSystem', { theme: resolvedTheme }) ||
              `Match your device appearance - currently ${resolvedTheme}.`
            : t('settings.appearance.description') || 'Choose how OyeChats looks on this device.'
        }
      />
      <Card className="p-4">
        <div className="grid gap-5 lg:grid-cols-2">
          <OptionGroup<Theme>
            legend={t('settings.appearance.theme.legend') || 'Theme'}
            legendId="appearance-theme-label"
            options={themeOptions}
            value={theme}
            onSelect={(id, event) => setTheme(id, event)}
          />
          <OptionGroup<ContrastLevel>
            legend={t('settings.appearance.contrast.legend') || 'Contrast'}
            legendId="appearance-contrast-label"
            options={contrastOptions}
            value={contrast}
            onSelect={(id) => setContrast(id)}
          />
          {languageOptions.length > 1 && (
            <OptionGroup<string>
              legend={t('settings.appearance.language.legend') || 'Language'}
              legendId="appearance-language-label"
              options={languageOptions}
              value={locale}
              // Dashboard chrome only. Deliberately does NOT touch
              // Operator.preferred_locale: that is the language an operator
              // reads LIVE CHAT in, it is metered, and it is set in the Inbox.
              onSelect={(id) => setLocale(id)}
            />
          )}
        </div>
      </Card>
    </section>
  );
}
