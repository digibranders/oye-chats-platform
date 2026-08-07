import type { ComponentType } from 'react';

/**
 * Type shim for the reused legacy `components/WidgetChatPreview.jsx` - a
 * pixel-faithful mock of the real embeddable widget. Reused as-is so the Launch
 * Studio preview matches the actual widget; the `.jsx` stays the runtime source.
 */
export interface WidgetPreviewSettings {
  bot_name?: string;
  bot_logo?: string | null;
  avatar_type?: string;
  orb_color?: string;
  primary_color?: string;
  user_message_color?: string;
  user_bubble_color?: string;
  welcome_title?: string;
  welcome_subtitle?: string;
  welcome_suggestions?: string[];
  waiting_message?: string;
  offline_message?: string;
  live_chat_enabled?: boolean;
  live_chat_allowed?: boolean;
  meeting_booking_enabled?: boolean;
  widget_messages?: {
    welcome_suggestions_layout?: string;
    welcome_suggestions?: string[];
    input_placeholder?: string;
  };
  feature_flags?: { show_branding?: boolean };
}

export interface WidgetPreviewMessage {
  role: 'user' | 'bot';
  text: string;
  sources?: string[];
}

export interface WidgetChatPreviewProps {
  settings: WidgetPreviewSettings;
  state?: 'chat' | 'waiting' | 'unavailable';
  messages?: WidgetPreviewMessage[];
  pending?: boolean;
  onSend?: (question: string) => void;
  className?: string;
}

declare const WidgetChatPreview: ComponentType<WidgetChatPreviewProps>;
export default WidgetChatPreview;
export const WIDGET_FONT_STACK: string;
