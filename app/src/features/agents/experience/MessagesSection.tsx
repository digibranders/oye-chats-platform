import { type ReactElement, useCallback, useRef, useState } from 'react';
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
  Textarea,
  Tooltip,
  buttonClass,
} from '../../../ui';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { errorMessage, fetchSuggestedQuestions } from './experience-api';
import {
  LIMITS,
  PLACEHOLDERS,
  type DraftErrors,
  type ExperienceDraft,
  type SuggestionsLayout,
} from './experience-model';

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

const LAYOUTS: readonly { value: SuggestionsLayout; label: string }[] = [
  { value: 'horizontal', label: 'Side by side' },
  { value: 'vertical', label: 'Stacked' },
];

/**
 * "Leave it empty for the default" was said nine times on this tab, and it had
 * to be: every one of these fields shows a placeholder that *is* the shipped
 * default, and `Input` paints a placeholder in `--color-text-disabled`. Nine
 * fields, no way to tell which you had customised without clicking into each.
 *
 * The rule is stated once on the card now, and the state is marked on the
 * control. It sits in `Input`'s trailing slot because `Field` has no slot beside
 * its label — reported as a `src/ui` gap.
 */
function defaultMark(value: string) {
  // Always rendered, hidden rather than removed: `Input` returns a bare
  // `<input>` when it has no affix and a wrapped one when it does, so a
  // conditional slot remounts the element on the first keystroke and takes the
  // caret with it.
  return (
    <Badge tone="neutral" size="sm" className={value.trim().length === 0 ? undefined : 'invisible'}>
      Default
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
  const { hasFeature } = useEntitlements();
  const liveChatIncluded = hasFeature('live_chat');

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
        errorMessage(cause, 'We could not come up with questions just now. Please try again.'),
      );
    } finally {
      setSuggesting(false);
    }
  }, [agentId, suggesting, suggestions]);

  const unusedSuggestions = (suggestions ?? []).filter(
    (question) => !quickActions.some((action) => action.trim() === question.trim()),
  );
  const atLimit = quickActions.length >= LIMITS.quickActions;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          eyebrow="Identity"
          titleAs="h2"
          title="What your chatbot is called"
        />
        <CardBody className="flex flex-col gap-5">
          <Field label="Display name" error={errors.displayName ?? null} required>
            <Input
              value={draft.displayName}
              maxLength={LIMITS.displayName}
              disabled={readOnly}
              placeholder="Acme Assistant"
              onChange={(event) => onChange({ displayName: event.target.value })}
              className="max-w-sm"
            />
          </Field>
          <Field label="Launcher text" hint="Beside the closed launcher.">
            <Input
              value={draft.launcherName}
              maxLength={LIMITS.launcherName}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.launcherName}
              trailing={defaultMark(draft.launcherName)}
              onChange={(event) => onChange({ launcherName: event.target.value })}
              className="max-w-sm"
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Welcome"
          titleAs="h2"
          title="The first thing a visitor reads"
        />
        <CardBody className="flex flex-col gap-5">
          <Field label="Greeting">
            <Input
              value={draft.welcomeGreeting}
              maxLength={LIMITS.welcomeGreeting}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.welcomeGreeting}
              trailing={defaultMark(draft.welcomeGreeting)}
              onChange={(event) => onChange({ welcomeGreeting: event.target.value })}
            />
          </Field>
          <Field label="Subtitle">
            <Input
              value={draft.welcomeSubtitle}
              maxLength={LIMITS.welcomeSubtitle}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.welcomeSubtitle}
              trailing={defaultMark(draft.welcomeSubtitle)}
              onChange={(event) => onChange({ welcomeSubtitle: event.target.value })}
            />
          </Field>
          <Field label="Message box placeholder">
            <Input
              value={draft.inputPlaceholder}
              maxLength={LIMITS.inputPlaceholder}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.inputPlaceholder}
              trailing={defaultMark(draft.inputPlaceholder)}
              onChange={(event) => onChange({ inputPlaceholder: event.target.value })}
              className="max-w-sm"
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Starter questions"
          titleAs="h2"
          title="Questions a visitor can tap"
          description="Shown under the greeting."
          actions={
            <SegmentedControl
              items={LAYOUTS}
              value={draft.suggestionsLayout}
              onChange={(suggestionsLayout) => onChange({ suggestionsLayout })}
              label="Starter question layout"
              size="sm"
            />
          }
        />
        <CardBody className="flex flex-col gap-4">
          {quickActions.length === 0 ? (
            <EmptyState size="inline" title="No starter questions yet" />
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
                    aria-label={`Starter question ${index + 1}`}
                    placeholder="e.g. How much does it cost?"
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
                      aria-label={`Move starter question ${index + 1} up`}
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
                      aria-label={`Move starter question ${index + 1} down`}
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
                      aria-label={`Remove starter question ${index + 1}`}
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
              Add a question
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={suggesting}
              disabled={readOnly || agentId === null}
              iconLeft={<Sparkles aria-hidden />}
              onClick={() => void suggest()}
            >
              {suggestions === null ? 'Suggest questions' : 'Suggest different questions'}
            </Button>
            {atLimit ? (
              <span className="text-xs text-text-secondary">
                {LIMITS.quickActions} is as many as the window fits.
              </span>
            ) : null}
          </div>

          {suggestError ? (
            <Alert tone="danger" title="No suggestions this time" live>
              {suggestError}
            </Alert>
          ) : null}

          {suggestions !== null && !suggesting ? (
            unusedSuggestions.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-md bg-surface-sunken px-3 py-3">
                <p className="text-xs text-text-secondary">
                  Questions your chatbot can already answer from what it has read. Add the ones that
                  fit — you can reword them afterwards.
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
              </div>
            ) : (
              <p className="text-xs text-text-secondary" role="status">
                {suggestions.length === 0
                  ? 'The chatbot could not find a question it was confident answering. Add more to its knowledge and try again.'
                  : 'Every suggestion is already in your list.'}
              </p>
            )
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Other wording"
          titleAs="h2"
          title="The rest of the widget's copy"
          description="Leave a field empty for our wording."
        />
        <CardBody className="flex flex-col gap-5">
          <Field label="Greeting bubble">
            <Input
              value={draft.greetingMessage}
              maxLength={LIMITS.greetingMessage}
              disabled={readOnly}
              placeholder={PLACEHOLDERS.greetingMessage}
              trailing={defaultMark(draft.greetingMessage)}
              onChange={(event) => onChange({ greetingMessage: event.target.value })}
            />
          </Field>

          <Field label="Offline banner" hint="When nobody is available.">
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
              <Field label="Live chat button">
                <Input
                  value={draft.liveChatLabel}
                  maxLength={LIMITS.liveChatLabel}
                  disabled={readOnly}
                  placeholder={PLACEHOLDERS.liveChatLabel}
                  trailing={defaultMark(draft.liveChatLabel)}
                  onChange={(event) => onChange({ liveChatLabel: event.target.value })}
                  className="max-w-sm"
                />
              </Field>
              <Field label="Rating prompt" hint="Asked once a live conversation ends.">
                <Input
                  value={draft.ratingPrompt}
                  maxLength={LIMITS.ratingPrompt}
                  disabled={readOnly}
                  placeholder={PLACEHOLDERS.ratingPrompt}
                  trailing={defaultMark(draft.ratingPrompt)}
                  onChange={(event) => onChange({ ratingPrompt: event.target.value })}
                />
              </Field>
              <Field label="End-chat button" hint="Hands the conversation back to the chatbot.">
                <Input
                  value={draft.endChatLabel}
                  maxLength={LIMITS.endChatLabel}
                  disabled={readOnly}
                  placeholder={PLACEHOLDERS.endChatLabel}
                  trailing={defaultMark(draft.endChatLabel)}
                  onChange={(event) => onChange({ endChatLabel: event.target.value })}
                  className="max-w-sm"
                />
              </Field>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2.5">
              <p className="min-w-0 text-prose text-text-secondary">
                Three more lines appear with live chat.
              </p>
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                Compare plans
              </Link>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
