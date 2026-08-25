import { type ReactElement, useId, useMemo } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { SectionHeader, Select } from '../../../design-system';
import { useLocaleCatalog } from '../../../hooks/useLocaleCatalog';
import { type LanguageConfig, type SliceStatus, normalizeLanguageConfig } from './botConfig';
import { Card, SaveFooter, ToggleRow } from './configCards';
import { CustomCopyNotice } from './CustomCopyNotice';

/**
 * LanguageCard - what languages the chatbot speaks to VISITORS.
 *
 * This is the control that makes the whole multilingual programme reachable:
 * until it shipped, `Bot.language_config` could only be set with direct
 * database access, so the widget selector, the AI's answer language and
 * operator translation were all unreachable for every customer.
 *
 * It is not the operator's own translation preference. An operator chooses
 * what language THEY read live chat in from Support -> Live chat, and that
 * choice is theirs to make; this card decides whether that translation runs at
 * all, and which languages visitors may write in.
 *
 * Every rule the server enforces is enforced here first, so a customer meets a
 * disabled control with a reason rather than a 422 after they hit save.
 */
export function LanguageCard({
  value,
  baseline,
  onChange,
  dirty,
  status,
  onSave,
}: {
  value: LanguageConfig;
  /** The last saved configuration, used to warn about turning multilingual off. */
  baseline: LanguageConfig;
  onChange: (updater: (prev: LanguageConfig) => LanguageConfig) => void;
  dirty: boolean;
  status: SliceStatus;
  onSave: () => void;
}): ReactElement {
  const addId = useId();
  const defaultId = useId();
  const { locales, localeNameFor, uiTranslatedFor } = useLocaleCatalog();

  const off = !value.enabled;
  const singleLocale = value.supportedLocales.length < 2;
  const lastLocale = value.supportedLocales.length <= 1;
  // Turning multilingual off changes visitor-facing behaviour on a live
  // widget, so it gets an explicit second step rather than a silent save.
  const turningOff = baseline.enabled && !value.enabled;

  /**
   * Only languages the WIDGET is translated into can be added.
   *
   * The catalogue is wider than the widget's dictionaries: the AI converses in
   * every locale it lists, but the widget's own buttons, forms and error
   * messages exist in a smaller set. Offering the difference produced a visitor
   * experience nobody would choose on purpose - answers in Spanish, interface
   * in English - and on Arabic or Urdu the layout mirrored while the chrome
   * stayed English. Two live bots were configured that way before this filter
   * existed.
   */
  const addable = useMemo(
    () =>
      locales
        .filter((entry) => entry.uiTranslated && !value.supportedLocales.includes(entry.locale))
        .map((entry) => ({ value: entry.locale, label: entry.name, search: `${entry.name} ${entry.nativeName}` })),
    [locales, value.supportedLocales],
  );

  /**
   * Locales already saved that the widget has no dictionary for.
   *
   * Filtering the picker does not clean up what is already stored, and hiding
   * these would leave a customer with a configuration they can see the effects
   * of but not the cause of. They stay listed, marked, and removable.
   */
  const untranslated = useMemo(
    () => value.supportedLocales.filter((locale) => !uiTranslatedFor(locale)),
    [value.supportedLocales, uiTranslatedFor],
  );

  const defaultOptions = useMemo(
    () =>
      value.supportedLocales.map((locale) => ({
        value: locale,
        label: localeNameFor(locale) ?? locale,
      })),
    [value.supportedLocales, localeNameFor],
  );

  const addLocale = (locale: string): void => {
    if (!locale) return;
    onChange((prev) =>
      prev.supportedLocales.includes(locale)
        ? prev
        : { ...prev, supportedLocales: [...prev.supportedLocales, locale] },
    );
  };

  /**
   * Removing the current default promotes the next remaining locale rather
   * than leaving the bot pointing at a language it no longer speaks. The last
   * locale cannot be removed at all: a bot with no language is not a state the
   * server can store or the widget can render.
   */
  const removeLocale = (locale: string): void => {
    onChange((prev) => {
      if (prev.supportedLocales.length <= 1) return prev;
      const supportedLocales = prev.supportedLocales.filter((item) => item !== locale);
      return normalizeLanguageConfig({ ...prev, supportedLocales });
    });
  };

  const setEnabled = (enabled: boolean): void => {
    // Operator translation depends on multilingual and is cleared with it, so
    // the patch can never carry the pair the server rejects.
    onChange((prev) => ({ ...prev, enabled, operatorTranslation: enabled && prev.operatorTranslation }));
  };

  return (
    <section className="space-y-5">
      <SectionHeader
        title="Language"
        description="Choose the languages your chatbot speaks to visitors, and how it picks one."
      />
      <Card>
        <ToggleRow
          title="Multilingual"
          description="Let visitors chat in their own language."
          checked={value.enabled}
          onChange={setEnabled}
        />

        {/* Disabled rather than hidden: a customer has to be able to see what
            turning multilingual on would give them before they turn it on. */}
        <div className={off ? 'pointer-events-none space-y-5 opacity-60' : 'space-y-5'} aria-disabled={off}>
          <div className="space-y-2">
            <p className="text-[13px] font-medium text-[var(--ds-text)]">Supported languages</p>
            <ul className="flex flex-wrap gap-2">
              {value.supportedLocales.map((locale) => (
                <li
                  key={locale}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] py-1 pl-3 pr-1.5 text-[12px] text-[var(--ds-text)]"
                >
                  {!uiTranslatedFor(locale) && (
                    <AlertTriangle
                      size={11}
                      aria-hidden="true"
                      className="text-[var(--ds-warning,var(--ds-text-muted))]"
                    />
                  )}
                  {localeNameFor(locale) ?? locale}
                  {locale === value.defaultLocale && (
                    <span className="text-[11px] text-[var(--ds-text-subtle)]">default</span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeLocale(locale)}
                    disabled={off || lastLocale}
                    aria-label={`Remove ${localeNameFor(locale) ?? locale}`}
                    title={lastLocale ? 'A chatbot needs at least one language.' : undefined}
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--ds-text-subtle)] hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="max-w-xs pt-1">
              <label htmlFor={addId} className="sr-only">
                Add a language
              </label>
              <Select
                id={addId}
                value=""
                onChange={addLocale}
                options={addable}
                placeholder={addable.length === 0 ? 'All languages added' : 'Add a language…'}
                searchable
                disabled={off || addable.length === 0}
                aria-label="Add a language"
              />
            </div>
            {lastLocale && (
              <p className="text-[11px] text-[var(--ds-text-subtle)]">
                A chatbot needs at least one language, so the last one can’t be removed.
              </p>
            )}
            <p className="text-[11px] text-[var(--ds-text-subtle)]">
              Only languages the chat widget itself is translated into can be added, so visitors
              never meet an English interface around a translated conversation.
            </p>
            {untranslated.length > 0 && (
              <div
                role="status"
                // Named so it is distinguishable from the turning-off warning
                // below, which is also a status region.
                aria-label="Languages without a translated widget"
                className="flex gap-2.5 rounded-[var(--ds-radius-lg)] border border-[var(--ds-warning-border,var(--ds-border))] bg-[var(--ds-bg-sunken)] p-3"
              >
                <AlertTriangle
                  size={14}
                  className="mt-0.5 shrink-0 text-[var(--ds-warning,var(--ds-text-muted))]"
                  aria-hidden="true"
                />
                <div className="space-y-1 text-[12px] text-[var(--ds-text-muted)]">
                  <p className="font-medium text-[var(--ds-text)]">
                    {untranslated.length === 1
                      ? `The widget is not translated into ${localeNameFor(untranslated[0]) ?? untranslated[0]}.`
                      : 'The widget is not translated into some of these languages.'}
                  </p>
                  <p>
                    Your chatbot answers in{' '}
                    {untranslated.map((locale) => localeNameFor(locale) ?? locale).join(', ')}, but
                    its buttons and forms stay in English. Remove{' '}
                    {untranslated.length === 1 ? 'it' : 'them'} unless you want that.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="max-w-xs space-y-1.5">
            <label htmlFor={defaultId} className="block text-[13px] font-medium text-[var(--ds-text)]">
              Default language
            </label>
            <Select
              id={defaultId}
              value={value.defaultLocale}
              onChange={(defaultLocale) => onChange((prev) => ({ ...prev, defaultLocale }))}
              options={defaultOptions}
              disabled={off}
              aria-label="Default language"
            />
            <p className="text-[11px] text-[var(--ds-text-subtle)]">
              Used when a visitor’s language can’t be determined. Only supported languages can be
              the default.
            </p>
          </div>

          <ToggleRow
            title="Detect the visitor’s language automatically"
            description="Uses the visitor’s browser, your page, and their first message."
            checked={value.autoDetect}
            onChange={(autoDetect) => onChange((prev) => ({ ...prev, autoDetect }))}
            disabled={off}
          />

          <ToggleRow
            title="Let visitors switch language in the widget"
            description="Shows a language selector visitors can change at any time."
            checked={value.allowVisitorSwitch}
            onChange={(allowVisitorSwitch) => onChange((prev) => ({ ...prev, allowVisitorSwitch }))}
            disabled={off || singleLocale}
            disabledReason={
              !off && singleLocale ? 'Add a second language to give visitors something to switch to.' : undefined
            }
          />

          {/* Stated here as well as on the copy tabs, so a customer learns it at
              the moment they turn multilingual on rather than discovering it
              later from a visitor. */}
          <CustomCopyNotice multilingual={value.enabled} />

          <ToggleRow
            title="Translate live chat for operators"
            description="Visitor messages are shown to your team in their own working language, and replies are translated back."
            checked={value.operatorTranslation}
            onChange={(operatorTranslation) => onChange((prev) => ({ ...prev, operatorTranslation }))}
            disabled={off}
            disabledReason={off ? 'Turn multilingual on first.' : undefined}
          />
        </div>

        {turningOff && (
          <div
            role="status"
            className="flex gap-2.5 rounded-[var(--ds-radius-lg)] border border-[var(--ds-warning-border,var(--ds-border))] bg-[var(--ds-bg-sunken)] p-4"
          >
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--ds-warning,var(--ds-text-muted))]" aria-hidden="true" />
            <div className="space-y-1 text-[12px] text-[var(--ds-text-muted)]">
              <p className="font-medium text-[var(--ds-text)]">Saving will turn multilingual off.</p>
              <p>
                The widget’s language selector disappears, your chatbot answers everyone in its
                default language, and live chat is no longer translated for your team.
              </p>
              <p>
                Past conversations keep the language they were held in, so turning this back on
                restores them.
              </p>
            </div>
          </div>
        )}

        <SaveFooter
          dirty={dirty}
          status={status}
          onSave={onSave}
          label={turningOff ? 'Turn off multilingual' : 'Save language'}
        />
      </Card>
    </section>
  );
}
