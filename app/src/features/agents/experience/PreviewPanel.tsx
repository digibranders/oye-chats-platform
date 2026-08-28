import { type ReactElement, useCallback, useRef, useState } from 'react';
import { Globe, RotateCcw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  SegmentedControl,
  Tooltip,
} from '../../../ui';
import { previewChatStream } from '../../../services/api';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { useDebouncedValue } from './useDebouncedValue';
import { WidgetMock, type PreviewMessage, type PreviewState } from './WidgetMock';
import { WebsitePreviewDialog } from './WebsitePreviewDialog';
import type { ExperienceDraft } from './experience-model';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * The preview column.
 *
 * Two rules hold this panel together, and both are answers to how the previous
 * one lied.
 *
 * **It previews the chatbot in the URL.** The stream used to be started against
 * `useBotContext().selectedBot` — the shell's workspace-scope switcher — so a
 * user editing chatbot #4 while the switcher held #1 typed a question into #4's
 * widget and read #1's answer, with nothing on screen naming either. The
 * chatbot id arrives as a prop from `useExperience`, which reads the route and
 * nothing else.
 *
 * **It never claims to be live when it is not.** Three separate things can make
 * it stale and each is stated: the debounce has not caught up, the draft
 * differs from what is saved, or — the one that actually catches people out —
 * the *reply* is generated from the saved record, so a rewritten system prompt
 * changes nothing here until it is saved. "Live preview" over an answer written
 * by superseded instructions is the page misrepresenting the one thing it
 * exists to show.
 */

const STATES: readonly { value: PreviewState; label: string }[] = [
  { value: 'welcome', label: 'Chat' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'offline', label: 'Offline' },
];

export interface PreviewPanelProps {
  draft: ExperienceDraft;
  agentName: string;
  /** The chatbot in the URL. Null only while it cannot be resolved. */
  agentId: number | null;
  dirty: boolean;
  answerStale: boolean;
  botKey: string | null;
  website: string | null;
  /** The credit line's wording, as it will read. */
  brandingText: string;
  /** Jump to the tab that owns a message this preview state renders. */
  onEditState?: (tab: 'messages' | 'handoff') => void;
}

export function PreviewPanel({
  draft,
  agentName,
  agentId,
  dirty,
  answerStale,
  botKey,
  website,
  brandingText,
  onEditState,
}: PreviewPanelProps): ReactElement {
  const { t } = useTranslation();
  const { hasFeature } = useEntitlements();
  const [state, setState] = useState<PreviewState>('welcome');
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [websiteOpen, setWebsiteOpen] = useState(false);
  const sessionRef = useRef<string | null>(null);

  const { value: shown, settled } = useDebouncedValue(draft, 200);

  const ask = useCallback(
    (question: string): void => {
      const text = question.trim();
      if (!text || agentId === null) return;
      if (!sessionRef.current) {
        sessionRef.current = `preview-${Math.random().toString(36).slice(2)}`;
      }
      setStreamError(null);
      setMessages((prev) => [...prev, { role: 'visitor', text }]);
      setPending(true);

      void previewChatStream(agentId, text, sessionRef.current, {
        onChunk: (chunk) =>
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === 'bot') {
              next[next.length - 1] = { ...last, text: last.text + chunk };
            } else {
              next.push({ role: 'bot', text: chunk });
            }
            return next;
          }),
        onFinal: () => setPending(false),
        onError: (cause: unknown) => {
          setPending(false);
          setStreamError(
            cause instanceof Error && cause.message
              ? cause.message
              : t('agents.theChatbotCouldNotAnswer') || 'The chatbot could not answer that just now.',
          );
        },
      });
    },
    [agentId, t],
  );

  const reset = useCallback((): void => {
    sessionRef.current = null;
    setMessages([]);
    setPending(false);
    setStreamError(null);
  }, []);

  // Two of the three preview states render a message edited on another tab, and
  // there was no way from the preview to the field that controls it.
  const editTab: 'messages' | 'handoff' | null =
    state === 'waiting' ? 'handoff' : state === 'offline' ? 'messages' : null;

  return (
    // A `Card`, like the panels it sits beside. Its chrome used to sit raw on
    // the canvas next to a column of white cards, so the two panes did not read
    // as peers.
    <Card>
      <CardHeader
        size="sm"
        titleAs="h2"
        title={t('agents.preview') || 'Preview'}
        actions={
          <>
            {!settled ? (
              <Badge tone="neutral">{t('agents.updating') || 'Updating'}</Badge>
            ) : dirty ? (
              <Badge tone="warning" dot>
                {t('agents.unsaved') || 'Unsaved'}
              </Badge>
            ) : (
              <Badge tone="success" dot>
                {t('agents.live') || 'Live'}
              </Badge>
            )}
            {messages.length > 0 ? (
              <Tooltip content="Start the preview conversation again">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={reset}
                  aria-label={t('agents.resetPreviewConversation') || 'Reset preview conversation'}
                >
                  <RotateCcw aria-hidden />
                </Button>
              </Tooltip>
            ) : null}
            {botKey ? (
              <Tooltip content="Load the saved widget over your own site">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setWebsiteOpen(true)}
                  aria-label={t('agents.previewOnMyWebsite') || 'Preview on my website'}
                >
                  <Globe aria-hidden />
                </Button>
              </Tooltip>
            ) : null}
          </>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <SegmentedControl
          items={STATES}
          value={state}
          onChange={setState}
          label={t('agents.previewStateLabel') || 'Preview state'}
          size="sm"
          fill
        />

        {editTab && onEditState ? (
          <Button
            variant="link"
            size="sm"
            className="self-start"
            onClick={() => onEditState(editTab)}
          >
            {t('agents.editThisMessage') || 'Edit this message'}
          </Button>
        ) : null}

        <WidgetMock
          draft={shown}
          agentName={agentName}
          state={state}
          messages={messages}
          pending={pending}
          // Mirrors the widget config endpoint's own gate: the handoff control is
          // hidden on a plan without live chat, so previewing it there would show
          // visitors an option they will never be offered.
          liveChatVisible={draft.liveChatEnabled && hasFeature('live_chat')}
          brandingText={brandingText}
          onSend={agentId === null || state !== 'welcome' ? undefined : ask}
        />

        {streamError ? (
          <Alert tone="danger" title={t('agents.thePreviewCouldNotAnswer') || 'The preview could not answer'} live>
            {streamError}
          </Alert>
        ) : null}

        {answerStale ? (
          <Alert tone="warning" title={t('agents.repliesStillUseYourSaved') || 'Replies still use your saved settings'}>
            Colours and wording above update as you type, but an answer is generated by the chatbot
            as it is saved.
          </Alert>
        ) : null}
      </CardBody>

      <WebsitePreviewDialog
        open={websiteOpen}
        onClose={() => setWebsiteOpen(false)}
        botKey={botKey}
        website={website}
      />
    </Card>
  );
}
