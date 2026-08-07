import WidgetChatPreview, { type WidgetPreviewSettings } from '../../../components/WidgetChatPreview';
import { useBotContext } from '../../../context/BotContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { usePreview } from './preview-context';

/**
 * WidgetPreview - the Launch Studio right-pane preview. Renders the REAL widget
 * mock (legacy WidgetChatPreview, pixel-faithful to the production widget) driven
 * by the shared preview config, so customization shows up here exactly as
 * visitors will see it. Empty `messages` → the widget's welcome screen; the Test
 * step pushes a live conversation.
 */
export function WidgetPreview() {
  const { preview, ask } = usePreview();
  const { selectedBot } = useBotContext();
  const { hasFeature } = useEntitlements();

  const settings: WidgetPreviewSettings = {
    bot_name: selectedBot?.name || 'Your agent',
    bot_logo: preview.botLogo,
    avatar_type: preview.avatarType,
    orb_color: preview.orbColor,
    primary_color: preview.primaryColor,
    user_message_color: preview.userBubbleColor,
    user_bubble_color: preview.userBubbleColor,
    feature_flags: { show_branding: true },
    // Plan-gated in the real widget (backend bot_routes.py); mirror it here
    // so onboarding shows visitors' actual experience per plan.
    live_chat_enabled: hasFeature('live_chat'),
  };

  return (
    <div className="flex h-full items-center justify-center">
      <WidgetChatPreview
        settings={settings}
        messages={preview.messages}
        pending={preview.pending}
        onSend={selectedBot ? ask : undefined}
      />
    </div>
  );
}
