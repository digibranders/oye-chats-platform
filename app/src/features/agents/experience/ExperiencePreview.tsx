import { type ReactElement } from 'react';
import WidgetChatPreview, { type WidgetPreviewSettings } from '../../../components/WidgetChatPreview';
import { type ExperienceDraft } from './types';

export interface ExperiencePreviewProps {
  draft: ExperienceDraft;
  /** The agent's display name, shown as the widget's bot name. */
  agentName: string;
}

/**
 * ExperiencePreview — the live, pixel-faithful widget mock that mirrors the
 * current draft. It reuses the same legacy `WidgetChatPreview` the production
 * widget is pinned to, so every colour, avatar, greeting and quick action the
 * user edits shows up here exactly as a visitor will see it. Empty `messages`
 * keeps the widget on its welcome screen — the surface most branding/message
 * edits affect.
 */
export function ExperiencePreview({ draft, agentName }: ExperiencePreviewProps): ReactElement {
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
    feature_flags: { show_branding: true },
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <WidgetChatPreview settings={settings} state="chat" />
      <p className="text-[11px] text-[var(--ds-text-subtle)]">Live preview — updates as you edit</p>
    </div>
  );
}
