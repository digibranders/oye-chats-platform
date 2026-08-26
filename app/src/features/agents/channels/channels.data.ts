import { Code2 } from 'lucide-react';
import { MessengerGlyph, WhatsAppGlyph, type TileIcon } from '../../../design-system';

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
  /** Leading glyph - a Lucide icon or a self-colored brand glyph. */
  icon: TileIcon;
  /** True when `icon` is a self-colored brand mark (so the tile tone won't recolor it). */
  brand?: boolean;
}

/**
 * Channels on the roadmap. Kept as data so the Channels page stays a thin,
 * declarative list - add a channel here when it ships and promote it to a live
 * `<ChannelCard>` in `ChannelsPage`.
 */
// i18n-exempt: this table is built at import, before a locale exists, and it
// holds no `t()` of its own by design - the resolution happens where it is
// RENDERED, in `features/workspace/IntegrationsPage`, keyed on the channel id
// (`agents.channel.${id}`). The English here is that lookup's fallback. The
// product `name`s are trademarks and are never translated at all.
export const COMING_SOON_CHANNELS: readonly ComingSoonChannel[] = [
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Answer customers on WhatsApp with the same trained chatbot.',
    icon: WhatsAppGlyph,
    brand: true,
  },
  {
    id: 'messenger',
    name: 'Messenger',
    description: 'Connect your Facebook Page inbox to your chatbot.',
    icon: MessengerGlyph,
    brand: true,
  },
  {
    id: 'api',
    name: 'Conversation API',
    description: 'Send messages to your chatbot from your own app or backend.',
    icon: Code2,
  },
];
