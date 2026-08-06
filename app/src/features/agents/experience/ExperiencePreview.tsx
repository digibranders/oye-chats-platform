import { type ReactElement, useState } from 'react';
import WidgetChatPreview, { type WidgetPreviewSettings } from '../../../components/WidgetChatPreview';
import { cn } from '../../../design-system';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { type ExperienceDraft } from './types';

export interface ExperiencePreviewProps {
  draft: ExperienceDraft;
  /** The agent's display name, shown as the widget's bot name. */
  agentName: string;
}

/** The visitor-facing states the mock can render, mapped to WidgetChatPreview. */
type PreviewState = 'chat' | 'waiting' | 'unavailable';

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
  const [state, setState] = useState<PreviewState>('chat');
  const { hasFeature } = useEntitlements();
  // Mirror the backend's widget /settings gate (bot_routes.py): the headphones
  // icon is plan-gated. On Free `hasFeature('live_chat')` is false so it
  // hides; on Starter+ it renders - exactly what visitors will see.
  const planIncludesLiveChat = hasFeature('live_chat');
  const suggestions = draft.quickActions.map((s) => s.trim()).filter((s) => s.length > 0);

  const settings: WidgetPreviewSettings = {
    bot_name: agentName,
    bot_logo: draft.botLogo,
    avatar_type: draft.avatarType,
    orb_color: draft.orbColor,
    primary_color: draft.primaryColor,
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
        aria-label="Preview state"
        className="flex w-full max-w-[380px] gap-1 rounded-lg bg-[var(--ds-bg-surface)] p-1"
      >
        {STATE_TABS.map(({ key, label }) => {
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
      <WidgetChatPreview settings={settings} state={state} />
      <p className="text-[11px] text-[var(--ds-text-subtle)]">Live preview - updates as you edit</p>
    </div>
  );
}
