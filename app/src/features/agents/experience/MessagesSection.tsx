import { type ReactElement, useCallback, useRef, useState } from 'react';
import { t as translateNow } from '../../../i18n/i18n';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  SegmentedControl,
  Switch,
  Textarea,
  Tooltip,
  Well,
  buttonClass,
} from '../../../ui';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { CustomCopyNotice } from './CustomCopyNotice';
import { errorMessage, fetchSuggestedQuestions } from './experience-api';
import {
  LIMITS,
  PLACEHOLDERS,
  type DraftErrors,
  type ExperienceDraft,
  type SuggestionsLayout,
} from './experience-model';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * Everything the widget says, before the chatbot has said anything.
 *
 * The starter questions are the part with real history. The chatbot generates a
 * set of questions it can demonstrably answer, the server caches them on the
 * record the first time they are computed, and `POST
 * /bots/{id}/seed-questions` returns that same cached list for the life of the
 * chatbot unless `force` is passed — which no client ever did. So a customer
 * whose questions were generated on day one, from a half-crawled site, was
 * stuck with them. They are proposals here: generate a fresh set, take the ones
 * that fit, then edit and order them like any other line of copy.
 */

// Labels resolved per render; `value` is the stored key.
const LAYOUTS: readonly { value: SuggestionsLayout; labelKey: string; label: string }[] = [
  { value: 'horizontal', labelKey: 'agents.layoutSideBySide', label: 'Side by side' },
  { value: 'vertical', labelKey: 'agents.layoutStacked', label: 'Stacked' },
];

/**
 * "Leave it empty for the default" was said nine times on this tab, and it had
 * to be: every one of these fields shows a placeholder that *is* the shipped
 * default, and `Input` paints a placeholder in `--color-text-disabled`. Nine
 * fields, no way to tell which you had customised without clicking into each.
 *
 * The rule is stated once on the card now, and the state is marked beside the
 * field's label, in `Field`'s trailing slot.
 *
 * It used to live in `Input`'s, which is *inside* the field — and a conditional
 * affix there changes the input's element tree, so React remounted the element
 * on the first keystroke and took the caret with it. The workaround was to
 * render the badge always and set `invisible` on it, which reserved a hole for
 * something that is usually not there. `Field trailing` is outside the control,
 * so the badge can simply not be rendered when it does not apply.
 *
 * Every field on this tab is the card's own width, and none of them carries a
 * width class. Five of the nine used to be `max-w-sm` with no rule behind which
 * — one right edge at 384 and another at 638, alternating down a single column.
 */
function defaultMark(value: string) {
  if (value.trim().length > 0) return undefined;
  return (
    <Badge tone="neutral" size="sm">
      {translateNow('agents.default') || 'Default'}
    </Badge>
  );
}

export interface MessagesSectionProps {
  draft: ExperienceDraft;
  errors: DraftErrors;
  agentId: number | null;
  readOnly: boolean;
  onChange: (patch: Partial<ExperienceDraft>) => void;
}

export function MessagesSection({
  draft,
  errors,
  agentId,
  readOnly,
  onChange,
}: MessagesSectionProps): ReactElement {
  const { t } = useTranslation();
  const { hasFeature, isFree } = useEntitlements();
  const liveChatIncluded = hasFeature('live_chat');

  // Launcher text is on/off with no separate stored flag: an empty
  // `launcherName` IS "off", and the widget hides the tooltip on an explicit
  // empty string (see `widget/src/components/Launcher.jsx`). The ref remembers
  // the last real text so toggling off and back on restores it instead of
  // making the customer retype it.
  //
  // The switch is NOT simply "is the text non-empty". It was, and selecting the
  // text to replace it flipped the switch off, disabled the input under the
  // cursor and swapped in a "Hidden" placeholder before the replacement was
  // typed. An empty field the customer is still editing stays on; only the
  // switch turns the text off. What is saved does not change: empty is hidden,
  // and the hint says so while the field is empty.
  const [clearedByTyping, setClearedByTyping] = useState(false);
  const launcherTextOn = draft.launcherName.trim() !== '' || clearedByTyping;
  // @i18n-exempt: the WIDGET's launcher text, not dashboard chrome. This value
  // is written into the draft and read by a visitor, whose own language the
  // widget resolves. Translating it would save Hindi into the customer's record.
  const launcherTextStash = useRef(draft.launcherName.trim() || 'Have Questions?');
  const setLauncherName = useCallback(
    (value: string) => {
      if (value.trim()) launcherTextStash.current = value;
      setClearedByTyping(value.trim() === '');
      onChange({ launcherName: value });
    },
    [onChange],
  );
  const toggleLauncherText = useCallback(
    (on: boolean) => {
      setClearedByTyping(false);
      // @i18n-exempt: same widget value as the stash above, not dashboard chrome.
      onChange({ launcherName: on ? launcherTextStash.current || 'Have Questions?' : '' });
    },
    [onChange],
  );
  const launcherTextEmpty = launcherTextOn && draft.launcherName.trim() === '';

  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const rowRefs = useRef<(HTMLInputElement | null)[]>([]);

  const { quickActions } = draft;

  const setActions = useCallback(
    (next: string[], focusIndex?: number): void => {
      onChange({ quickActions: next });
      if (focusIndex !== undefined) {
        // Rows are keyed by position, so a move swaps the values under two
        // stable inputs rather than moving the DOM. Focus has to follow the
        // value, or the row the user just moved is no longer the one they are
        // on — which makes a second press move a different question.
        window.requestAnimationFrame(() => rowRefs.current[focusIndex]?.focus());
      }
    },
    [onChange],
  );

  const move = useCallback(
    (from: number, to: number): void => {
      if (to < 0 || to >= quickActions.length) return;
      const next = quickActions.slice();
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      setActions(next, to);
    },
    [quickActions, setActions],
  );

  const suggest = useCallback(async (): Promise<void> => {
    if (agentId === null || suggesting) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      // The first press takes whatever the chatbot already has; pressing again
      // is an explicit ask for a new set, which is the only thing that gets past
      // the server's cache.
      const regenerate = suggestions !== null;
      setSuggestions(await fetchSuggestedQuestions(agentId, regenerate));
    } catch (cause) {
      setSuggestError(
        errorMessage(cause, t('agents.weCouldNotComeUp') || 'We could not come up with questions just now. Please try again.'),
      );
    } finally {
      setSuggesting(false);
    }
  }, [agentId, suggesting, suggestions, t]);

  const unusedSuggestions = (suggestions ?? []).filter(
    (question) => !quickActions.some((action) => action.trim() === question.trim()),
  );
  const atLimit = quickActions.length >= LIMITS.quickActions;

  return (
    <div className="flex flex-col gap-6">
      {/* Above the fields, not under them: it changes what the customer is
          about to write, so it has to be read before they write it. */}
      <CustomCopyNotice multilingual={draft.multilingualEnabled} />

      <Card>
        <CardHeader
          eyebrow="Identity"
          titleAs="h2"
          title={t('agents.whatYourChatbotIsCalled') || 'What your chatbot is called'}
        />
        <CardBody className="flex flex-col gap-5">
          <Field label={t('agents.displayName') || 'Display name'} error={errors.displayName ?? null} required>
            <Input
              value={draft.displayName}
              maxLength={LIMITS.displayName}
              disabled={readOnly}
              placeholder={t('agents.acmeAssistant') || 'Acme Assistant'}
              onChange={(event) => onChange({ displayName: event.target.value })}
            />
          </Field>
          <Field
            label={t('agents.launcherText') || 'Launcher text'}
            trailingAlign="edge"
            hint={
              launcherTextEmpty
                ? t('agents.launcherTextEmpty') ||
                  'Type the text visitors see beside the launcher, or turn this off.'
                : launcherTextOn
                  ? t('agents.besideTheClosedLauncher') || 'Beside the closed launcher.'
                  : t('agents.theLauncherShowsJustThe') || 'The launcher shows just the icon, with no text beside it.'
            }
            trailing={
              <Switch
                checked={launcherTextOn}
                disabled={readOnly}
                onCheckedChange={toggleLauncherText}
                label={t('agents.showLauncherText') || 'Show launcher text'}
                hideLabel
              />
            }
          >
            <Input
              value={draft.launcherName}
              maxLength={LIMITS.launcherName}
              disabled={readOnly || !launcherTextOn}
              placeholder={
                launcherTextOn
                  ? PLACEHOLDERS.launcherName
                  : t('agents.launcherTextHidden') || 'Hidden'
              }
              onChange={(event) => setLauncherName(event.target.value)}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Welcome"
          titleAs="h2"
          title={t('agents.theFirstThingAVisitor') || 'The first thing a visitor reads'}
        />
        <CardBody className="flex flex-col gap-5">
          <Field label={t('agents.greeting') || 'Greeting'} trailing={defaultMark(draft.welcomeGreeting)}>
            <Input
              value={draft.welcomeGreeting}
              maxLength={LIMITS.welcomeGreeting}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.welcomeGreeting}
              onChange={(event) => onChange({ welcomeGreeting: event.target.value })}
            />
          </Field>
          <Field label={t('agents.subtitle') || 'Subtitle'} trailing={defaultMark(draft.welcomeSubtitle)}>
            <Input
              value={draft.welcomeSubtitle}
              maxLength={LIMITS.welcomeSubtitle}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.welcomeSubtitle}
              onChange={(event) => onChange({ welcomeSubtitle: event.target.value })}
            />
          </Field>
          <Field label={t('agents.messageBoxPlaceholder') || 'Message box placeholder'} trailing={defaultMark(draft.inputPlaceholder)}>
            <Input
              value={draft.inputPlaceholder}
              maxLength={LIMITS.inputPlaceholder}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.inputPlaceholder}
              onChange={(event) => onChange({ inputPlaceholder: event.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Starter questions"
          titleAs="h2"
          title={t('agents.questionsAVisitorCanTap') || 'Questions a visitor can tap'}
          description={t('agents.shownUnderTheGreeting') || 'Shown under the greeting.'}
          actions={
            <SegmentedControl
              items={LAYOUTS.map((o) => ({ ...o, label: t(o.labelKey) || o.label }))}
              value={draft.suggestionsLayout}
              onChange={(suggestionsLayout) => onChange({ suggestionsLayout })}
              label={t('agents.starterQuestionLayout') || 'Starter question layout'}
              size="sm"
            />
          }
        />
        <CardBody className="flex flex-col gap-4">
          {quickActions.length === 0 ? (
            <EmptyState
              size="inline"
              flush
              title={t('agents.noStarterQuestionsYet') || 'No starter questions yet'}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {quickActions.map((action, index) => (
                // Positional keys are correct here: reordering swaps the values
                // under stable rows, and focus is moved to match (see `move`).
                <li key={index} className="flex items-center gap-2">
                  <Input
                    ref={(node) => {
                      rowRefs.current[index] = node;
                    }}
                    value={action}
                    maxLength={LIMITS.quickAction}
                    disabled={readOnly}
                    aria-label={t('agents.starterQuestionN', { n: index + 1 }) || `Starter question ${index + 1}`}
                    placeholder={t('agents.eGHowMuchDoes') || 'e.g. How much does it cost?'}
                    onChange={(event) =>
                      setActions(
                        quickActions.map((row, i) => (i === index ? event.target.value : row)),
                      )
                    }
                  />
                  <Tooltip content="Move up">
                    <Button
                      variant="ghost"
                      size="icon-md"
                      disabled={readOnly || index === 0}
                      aria-label={t('agents.moveStarterQuestionUp', { n: index + 1 }) || `Move starter question ${index + 1} up`}
                      onClick={() => move(index, index - 1)}
                    >
                      <ChevronUp aria-hidden />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Move down">
                    <Button
                      variant="ghost"
                      size="icon-md"
                      disabled={readOnly || index === quickActions.length - 1}
                      aria-label={t('agents.moveStarterQuestionDown', { n: index + 1 }) || `Move starter question ${index + 1} down`}
                      onClick={() => move(index, index + 1)}
                    >
                      <ChevronDown aria-hidden />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Remove">
                    <Button
                      variant="ghost"
                      size="icon-md"
                      disabled={readOnly}
                      aria-label={t('agents.removeStarterQuestion', { n: index + 1 }) || `Remove starter question ${index + 1}`}
                      onClick={() =>
                        setActions(quickActions.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={readOnly || atLimit}
              onClick={() => setActions([...quickActions, ''], quickActions.length)}
            >
              <Plus aria-hidden />
              {t('agents.addAQuestion') || 'Add a question'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={suggesting}
              disabled={readOnly || agentId === null}
              iconLeft={<Sparkles aria-hidden />}
              onClick={() => void suggest()}
            >
              {suggestions === null ? t('agents.suggestQuestions') || 'Suggest questions' : t('agents.suggestDifferentQuestions') || 'Suggest different questions'}
            </Button>
            {atLimit ? (
              <span className="text-xs text-text-secondary">
                {t('agents.isAsManyAsTheWindowFits', { count: LIMITS.quickActions }) ||
                  `${LIMITS.quickActions} is as many as the window fits.`}
              </span>
            ) : null}
          </div>

          {suggestError ? (
            <Alert tone="danger" title={t('agents.noSuggestionsThisTime') || 'No suggestions this time'} live>
              {suggestError}
            </Alert>
          ) : null}

          {suggestions !== null && !suggesting ? (
            unusedSuggestions.length > 0 ? (
              <Well className="flex flex-col gap-2">
                <p className="text-xs text-text-secondary">
                  {t('agents.questionsYourChatbotCanAlreadyAnswer') ||
                    'Questions your chatbot can already answer from what it has read. Add the ones that fit, and you can reword them afterwards.'}
                </p>
                <ul className="flex flex-wrap gap-2">
                  {unusedSuggestions.map((question) => (
                    <li key={question}>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={readOnly || atLimit}
                        onClick={() => setActions([...quickActions, question])}
                      >
                        <Plus aria-hidden />
                        {question}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Well>
            ) : (
              <p className="text-xs text-text-secondary" role="status">
                {suggestions.length === 0
                  ? t('agents.theChatbotCouldNotFind') || 'The chatbot could not find a question it was confident answering. Add more to its knowledge and try again.'
                  : t('agents.everySuggestionIsAlreadyIn') || 'Every suggestion is already in your list.'}
              </p>
            )
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Other wording"
          titleAs="h2"
          title={t('agents.theRestOfTheWidgets') || 'The rest of the widget\'s copy'}
          description={t('agents.leaveAFieldEmptyFor') || 'Leave a field empty for our wording.'}
        />
        <CardBody className="flex flex-col gap-5">
          {isFree ? (
            <Well className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-prose text-text-secondary">
                {t('agents.widgetCopyLocked') || 'Customise the widget’s wording on a paid plan.'}
              </p>
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                {t('agents.comparePlans') || 'Compare plans'}
              </Link>
            </Well>
          ) : (
          <>
          <Field label={t('agents.greetingBubble') || 'Greeting bubble'} trailing={defaultMark(draft.greetingMessage)}>
            <Input
              value={draft.greetingMessage}
              maxLength={LIMITS.greetingMessage}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.greetingMessage}
              onChange={(event) => onChange({ greetingMessage: event.target.value })}
            />
          </Field>

          <Field label={t('agents.offlineBanner') || 'Offline banner'} hint={t('agents.whenNobodyIsAvailable2') || 'When nobody is available.'}>
            <Textarea
              rows={2}
              value={draft.offlineBanner}
              maxLength={LIMITS.offlineBanner}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.offlineBanner}
              onChange={(event) => onChange({ offlineBanner: event.target.value })}
            />
          </Field>

          {liveChatIncluded ? (
            <>
              <Field label={t('agents.liveChatButton') || 'Live chat button'} trailing={defaultMark(draft.liveChatLabel)}>
                <Input
                  value={draft.liveChatLabel}
                  maxLength={LIMITS.liveChatLabel}
                  disabled={readOnly}
                  placeholder={PLACEHOLDERS.liveChatLabel}
                  onChange={(event) => onChange({ liveChatLabel: event.target.value })}
                />
              </Field>
              <Field
                label={t('agents.ratingPrompt') || 'Rating prompt'}
                hint={t('agents.askedOnceALiveConversation') || 'Asked once a live conversation ends.'}
                trailing={defaultMark(draft.ratingPrompt)}
              >
                <Input
                  value={draft.ratingPrompt}
                  maxLength={LIMITS.ratingPrompt}
                  disabled={readOnly}
                  placeholder={PLACEHOLDERS.ratingPrompt}
                  onChange={(event) => onChange({ ratingPrompt: event.target.value })}
                />
              </Field>
              <Field
                label={t('agents.endChatButton') || 'End-chat button'}
                hint={t('agents.handsTheConversationBackTo') || 'Hands the conversation back to the chatbot.'}
                trailing={defaultMark(draft.endChatLabel)}
              >
                <Input
                  value={draft.endChatLabel}
                  maxLength={LIMITS.endChatLabel}
                  disabled={readOnly}
                  placeholder={PLACEHOLDERS.endChatLabel}
                  onChange={(event) => onChange({ endChatLabel: event.target.value })}
                />
              </Field>
            </>
          ) : (
            <Well className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-prose text-text-secondary">
                {t('agents.threeMoreLinesAppearWith') || 'Three more lines appear with live chat.'}
              </p>
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                {t('agents.comparePlans') || 'Compare plans'}
              </Link>
            </Well>
          )}
          </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
