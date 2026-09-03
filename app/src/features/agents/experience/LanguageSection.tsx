import { type ReactElement, useMemo } from 'react';
import { X } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Combobox,
  Field,
  Select,
  SettingGroup,
  SettingRow,
  Switch,
} from '../../../ui';
import { useLocaleCatalog } from '../../../hooks/useLocaleCatalog';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { type ExperienceDraft } from './experience-model';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * What languages this chatbot speaks to VISITORS.
 *
 * Until this shipped, `Bot.language_config` could only be set with direct
 * database access — so the widget's language picker, the AI's answer language
 * and the operator translation pipeline were all built and all unreachable.
 * This is the control that makes the multilingual programme usable.
 *
 * It is not the operator's own reading language. An operator picks what they
 * read live chat in from the inbox, and that choice is theirs; this decides
 * whether that translation runs at all, and which languages a visitor may
 * write in.
 *
 * **Every rule the server enforces is enforced here first**, so a customer
 * meets a disabled control with a reason beside it rather than a 422 after
 * they press save: the default is always one of the supported languages, the
 * last language cannot be removed, and translation cannot be on while
 * multilingual is off.
 */

export interface LanguageSectionProps {
  draft: ExperienceDraft;
  /** The saved configuration, so turning multilingual off can be flagged. */
  baseline: ExperienceDraft;
  readOnly: boolean;
  onChange: (patch: Partial<ExperienceDraft>) => void;
}

export function LanguageSection({
  draft,
  baseline,
  readOnly,
  onChange,
}: LanguageSectionProps): ReactElement {
  const { t } = useTranslation();
  const { locales, ready, labelFor, localeNameFor, uiTranslatedFor } = useLocaleCatalog();
  const { hasFeature } = useEntitlements();

  const off = !draft.multilingualEnabled;
  const disabled = readOnly || off;
  // Live-chat translation only means anything with live chat, which Free does
  // not have — shown off and locked there rather than as an inert switch.
  const translationLocked = !hasFeature('live_chat');

  /**
   * Only languages the WIDGET is translated into can be added.
   *
   * The catalogue is wider than the widget's dictionaries: the AI converses in
   * every locale it lists, but the widget's own buttons, forms and errors
   * exist in a smaller set. Offering the difference produces an experience
   * nobody would choose on purpose — answers in Spanish, interface in English.
   */
  const addable = useMemo(
    () =>
      locales
        .filter(
          (locale) =>
            uiTranslatedFor(locale.code) && !draft.supportedLocales.includes(locale.locale),
        )
        // `locale.locale`, NOT `locale.code`. `supported_locales` is a list of
        // BCP-47 tags and the backend validates every entry against its
        // catalogue, so a bare language code fails the whole save with
        // "Unsupported locale(s) ...: hi". It also made the three English rows
        // indistinguishable, because en-IN, en-US and en-GB all carry
        // `code: 'en'` and so all carried the same option value.
        .map((locale) => ({
          value: locale.locale,
          label: locale.name,
          keywords: `${locale.locale} ${locale.code} ${locale.nativeName}`,
        })),
    [locales, uiTranslatedFor, draft.supportedLocales],
  );

  const name = (code: string) => localeNameFor(code) ?? code.toUpperCase();
  const lastRemaining = draft.supportedLocales.length <= 1;
  const turningOff = baseline.multilingualEnabled && !draft.multilingualEnabled;

  /**
   * Languages already saved that the widget cannot render.
   *
   * Filtering them out of the picker does not clean up stored config, and two
   * live chatbots were in exactly this state: answering in Urdu inside an
   * English interface, right-to-left, with English chrome. A customer who
   * cannot see the offending language cannot fix it, so it stays listed,
   * removable, and named.
   */
  const untranslated = ready
    ? draft.supportedLocales.filter((code) => !uiTranslatedFor(code))
    : [];

  return (
    <Card>
      <CardHeader
        title={t('agents.language') || 'Language'}
        titleAs="h2"
        description={t('agents.theLanguagesThisChatbotAnswers') || 'The languages this chatbot answers in, and how it decides which to use.'}
        actions={
          <>
            {off ? <Badge tone="neutral">{t('agents.multilingualOff') || 'Multilingual off'}</Badge> : null}
            <Switch
              checked={draft.multilingualEnabled}
              disabled={readOnly}
              onCheckedChange={(next) =>
                onChange({
                  multilingualEnabled: next,
                  // Translation is meaningless without the master switch, and
                  // leaving it set would silently re-enable it later.
                  operatorTranslation: next ? draft.operatorTranslation : false,
                })
              }
              label={t('agents.answerVisitorsInMoreThan') || 'Answer visitors in more than one language'}
            />
          </>
        }
      />
      <CardBody className="space-y-4">
        {turningOff ? (
          <Alert tone="warning" title={t('agents.thisChangesALiveWidget') || 'This changes a live widget'}>
            {t('agents.visitorsAlreadyTalkingWillBeAnsweredIn', {
              language: name(draft.defaultLocale),
            }) ||
              `Visitors already talking to this chatbot in another language will be answered in ${name(draft.defaultLocale)} from the next message.`}
          </Alert>
        ) : null}

        {/* `live`, which is what gives it `role="status"`: it appears in
            response to the language the customer just added, and a
            screen-reader user has no other way to learn the widget cannot
            render it. */}
        {untranslated.length > 0 ? (
          <Alert live tone="warning" title={t('agents.aLanguageWithoutATranslated') || 'A language without a translated widget'}>
            {t('agents.answersTranslatedWidgetNot', {
              answers: untranslated.map(name).join(', '),
              widget: untranslated.map((code) => labelFor(code) ?? name(code)).join(', '),
              fallback: name(draft.defaultLocale),
            }) ||
              `Visitors get answers in ${untranslated.map(name).join(', ')}, but the widget's own buttons and forms are not translated into ${untranslated
                .map((code) => labelFor(code) ?? name(code))
                .join(', ')}. They stay in ${name(draft.defaultLocale)}. Remove it below, or leave it and accept the mix.`}
          </Alert>
        ) : null}

        <Field
          label={t('agents.supportedLanguages') || 'Supported languages'}
          disabled={disabled}
          hint={t('agents.onlyLanguagesTheChatWidget') || 'Only languages the chat widget itself is translated into can be added: the interface and the answers have to match.'}
        >
          <ul className="flex flex-wrap gap-2">
            {draft.supportedLocales.map((code) => (
              <li key={code}>
                <span className="inline-flex items-center gap-1 rounded-md border border-border py-0.5 pl-2 pr-0.5 text-sm text-text-primary">
                  {name(code)}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${name(code)}`}
                    // The last language is what everything falls back to.
                    // Removing it leaves the chatbot with nothing to answer in.
                    disabled={disabled || lastRemaining}
                    onClick={() =>
                      onChange({ supportedLocales: draft.supportedLocales.filter((tag) => tag !== code) })
                    }
                    iconLeft={<X aria-hidden />}
                  />
                </span>
              </li>
            ))}
          </ul>
        </Field>

        <Field
          label={t('agents.addALanguage') || 'Add a language'}
          disabled={disabled || !ready || addable.length === 0}
          hint={
            ready && addable.length === 0
              ? t('agents.everyLanguageTheWidgetIs') || 'Every language the widget is translated into is already on.'
              : undefined
          }
          className="max-w-sm"
        >
          <Combobox
            label={t('agents.addALanguage') || 'Add a language'}
            value={null}
            options={addable}
            disabled={disabled || !ready || addable.length === 0}
            placeholder={t('agents.searchLanguages') || 'Search languages…'}
            onValueChange={(code) => {
              if (!code) return;
              onChange({ supportedLocales: [...draft.supportedLocales, code] });
            }}
          />
        </Field>

        <Field
          label={t('agents.fallBackTo') || 'Fall back to'}
          disabled={disabled}
          hint={t('agents.usedWhenAVisitorsLanguage') || 'Used when a visitor\'s language cannot be worked out.'}
          className="max-w-sm"
        >
          <Select
            label={t('agents.fallBackTo') || 'Fall back to'}
            value={draft.defaultLocale}
            disabled={disabled}
            options={draft.supportedLocales.map((code) => ({ value: code, label: name(code) }))}
            onValueChange={(defaultLocale) => onChange({ defaultLocale })}
          />
        </Field>

        <SettingGroup>
          <SettingRow
            label={t('agents.detectTheVisitorsLanguage') || 'Detect the visitor\'s language'}
            description={t('agents.fromTheirBrowserThePage') || 'From their browser, the page they are on, and their first message.'}
          >
            <Switch
              checked={draft.autoDetectLanguage}
              disabled={disabled}
              onCheckedChange={(autoDetectLanguage) => onChange({ autoDetectLanguage })}
              label={t('agents.detectTheVisitorsLanguage') || 'Detect the visitor\'s language'}
            />
          </SettingRow>
          <SettingRow
            label={t('agents.letVisitorsSwitchLanguage') || 'Let visitors switch language'}
            // Below two languages there is nothing to switch between, so the
            // picker would be a control with one option.
            description={
              draft.supportedLocales.length < 2
                ? t('agents.addASecondLanguageTo') || 'Add a second language to offer the picker.'
                : t('agents.showsTheLanguagePickerIn') || 'Shows the language picker in the widget.'
            }
          >
            <Switch
              checked={draft.allowVisitorLanguageSwitch}
              disabled={disabled || draft.supportedLocales.length < 2}
              onCheckedChange={(allowVisitorLanguageSwitch) => onChange({ allowVisitorLanguageSwitch })}
              label={t('agents.letVisitorsSwitchLanguage') || 'Let visitors switch language'}
            />
          </SettingRow>
          <SettingRow
            label={t('agents.translateLiveChat') || 'Translate live chat'}
            badge={translationLocked ? <Badge tone="plan">{t('agents.starterAndAbove') || 'Starter and above'}</Badge> : undefined}
            description={t('agents.visitorMessagesReachYourOperators') || 'Visitor messages reach your operators in their own language, and replies go back translated. Translation is metered in credits.'}
          >
            <Switch
              checked={translationLocked ? false : draft.operatorTranslation}
              disabled={disabled || translationLocked}
              onCheckedChange={(operatorTranslation) => onChange({ operatorTranslation })}
              label={t('agents.translateLiveChat') || 'Translate live chat'}
            />
          </SettingRow>
        </SettingGroup>
      </CardBody>
    </Card>
  );
}
