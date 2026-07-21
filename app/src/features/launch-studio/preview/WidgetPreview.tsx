import WidgetChatPreview, { type WidgetPreviewSettings } from '../../../components/WidgetChatPreview';
import { useBotContext } from '../../../context/BotContext';
import { usePreview } from './preview-context';

/**
 * WidgetPreview — the Launch Studio right-pane preview. Renders the REAL widget
 * mock (legacy WidgetChatPreview, pixel-faithful to the production widget) driven
 * by the shared preview config, so customization shows up here exactly as
 * visitors will see it. Empty `messages` → the widget's welcome screen; the Test
 * step pushes a live conversation.
 */
export function WidgetPreview() {
  const { preview } = usePreview();
  const { selectedBot } = useBotContext();

  const settings: WidgetPreviewSettings = {
    bot_name: selectedBot?.name || 'Your agent',
    bot_logo: preview.botLogo,
    avatar_type: preview.avatarType,
    orb_color: preview.orbColor,
    primary_color: preview.primaryColor,
    feature_flags: { show_branding: true },
  };

  return (
    <div className="flex h-full items-center justify-center">
      <WidgetChatPreview settings={settings} messages={preview.messages} pending={preview.pending} />
    </div>
  );
}
