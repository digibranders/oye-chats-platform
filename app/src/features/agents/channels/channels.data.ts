import { Code2, MessageCircle, MessagesSquare, type LucideIcon } from 'lucide-react';

/**
 * A connection surface that is planned but not yet live. Rendered as a quiet,
 * non-interactive card so users can see what's coming without being misled into
 * thinking it works today.
 */
export interface ComingSoonChannel {
  /** Stable key for the list. */
  id: string;
  /** Channel name shown on the card. */
  name: string;
  /** One line on what it will do. */
  description: string;
  /** Leading glyph. */
  icon: LucideIcon;
}

/**
 * Channels on the roadmap. Kept as data so the Channels page stays a thin,
 * declarative list - add a channel here when it ships and promote it to a live
 * `<ChannelCard>` in `ChannelsPage`.
 */
export const COMING_SOON_CHANNELS: readonly ComingSoonChannel[] = [
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Answer customers on WhatsApp with the same trained agent.',
    icon: MessageCircle,
  },
  {
    id: 'messenger',
    name: 'Messenger',
    description: 'Connect your Facebook Page inbox to your agent.',
    icon: MessagesSquare,
  },
  {
    id: 'api',
    name: 'Conversation API',
    description: 'Send messages to your agent from your own app or backend.',
    icon: Code2,
  },
];
