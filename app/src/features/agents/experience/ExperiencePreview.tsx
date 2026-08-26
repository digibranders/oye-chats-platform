import { type ReactElement, useState, useCallback, useRef } from 'react';
import WidgetChatPreview, { type WidgetPreviewSettings, type WidgetPreviewMessage } from '../../../components/WidgetChatPreview';
import { cn } from '../../../design-system';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { useBotContext } from '../../../context/BotContext';
import { previewChatStream } from '../../../services/api';
import { type ExperienceDraft } from './types';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';

export interface ExperiencePreviewProps {
  draft: ExperienceDraft;
  /** The agent's display name, shown as the widget's bot name. */
  agentName: string;
}

/** The visitor-facing states the mock can render, mapped to WidgetChatPreview. */
type PreviewState = 'chat' | 'waiting' | 'unavailable';

// @i18n-exempt: resolved at the render site from the state key
// (`agents.previewState.<key>`); the English here is that lookup's fallback.
const STATE_TABS: { key: PreviewState; label: string }[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'unavailable', label: 'Offline' },
];

/**
 * ExperiencePreview - the live, pixel-faithful widget mock that mirrors the
 * current draft. It reuses the same legacy `WidgetChatPreview` the production
 * widget is pinned to, so every colour, avatar, greeting and quick action the
 * user edits shows up here exactly as a visitor will see it.
 *
 * A small state switch lets the user preview the three visitor-facing surfaces
 * - the default chat welcome, the "connecting to support" waiting view, and the
 * offline/unavailable view - not just the chat state.
 */
export function ExperiencePreview({ draft, agentName }: ExperiencePreviewProps): ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<PreviewState>('chat');
  const [messages, setMessages] = useState<WidgetPreviewMessage[]>([]);
  const [pending, setPending] = useState(false);
  const sessionRef = useRef<string | null>(null);
  const { selectedBot } = useBotContext();
  const { hasFeature } = useEntitlements();

  // Mirror the backend's widget /settings gate (bot_routes.py): the headphones
  // icon is plan-gated. On Free `hasFeature('live_chat')` is false so it
  // hides; on Starter+ it renders - exactly what visitors will see.
  const planIncludesLiveChat = hasFeature('live_chat');
  const suggestions = draft.quickActions.map((s) => s.trim()).filter((s) => s.length > 0);

  const ask = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q || !selectedBot) return;

      if (!sessionRef.current) {
        sessionRef.current = `preview-${Math.random().toString(36).slice(2)}`;
      }

      setMessages((prev) => [...prev, { role: 'user', text: q }]);
      setPending(true);

      void previewChatStream(selectedBot.id, q, sessionRef.current, {
        onChunk: (text) =>
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === 'bot') {
              next[next.length - 1] = { ...last, text: last.text + text };
            } else {
              next.push({ role: 'bot', text });
            }
            return next;
          }),
        onFinal: () => setPending(false),
        onError: () =>
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'bot' && last.text) {
              setPending(false);
              return prev;
            }
            setPending(false);
            return [...prev, { role: 'bot', text: translateNow('agents.sorryICouldntAnswerThat') || 'Sorry, I couldn’t answer that just now.' }];
          }),
      });
    },
    [selectedBot],
  );

  const settings: WidgetPreviewSettings = {
    bot_name: agentName,
    bot_logo: draft.botLogo,
    avatar_type: draft.avatarType,
    orb_color: draft.orbColor,
    primary_color: draft.primaryColor,
    user_message_color: draft.userBubbleColor,
    user_bubble_color: draft.userBubbleColor,
    welcome_title: draft.welcomeGreeting,
    welcome_subtitle: draft.welcomeSubtitle,
    welcome_suggestions: suggestions,
    widget_messages: {
      welcome_suggestions: suggestions,
      welcome_suggestions_layout: draft.suggestionsLayout,
      input_placeholder: draft.inputPlaceholder,
    },
    feature_flags: { show_branding: draft.showBranding },
    live_chat_enabled: planIncludesLiveChat,
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        role="group"
        aria-label={t('agents.previewStateLabel') || 'Preview state'}
        className="flex w-full max-w-[380px] gap-1 rounded-lg bg-[var(--ds-bg-surface)] p-1"
      >
        {STATE_TABS.map(({ key, label: fallbackLabel }) => {
          const label = t(`agents.previewState.${key}`) || fallbackLabel;
          const active = state === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => setState(key)}
              className={cn(
                'flex-1 rounded-md py-1.5 text-[11px] font-semibold transition-colors',
                active
                  ? 'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]'
                  : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <WidgetChatPreview
        settings={settings}
        state={state}
        messages={messages}
        pending={pending}
        onSend={selectedBot ? ask : undefined}
      />
      <p className="text-[11px] text-[var(--ds-text-subtle)]">
        {t('agents.livePreviewTestYourBot') || 'Live preview - test your bot & watch edits update in real time'}
      </p>
    </div>
  );
}
