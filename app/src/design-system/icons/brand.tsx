import { type ReactElement } from 'react';

/**
 * Brand glyphs - faithful, self-colored SVG *app icons* for third-party
 * channels: the full square mark (gradient background + white glyph) exactly as
 * it appears on a phone home screen, so an integration reads as *itself* at a
 * glance (the Slack / Notion integrations-list pattern) instead of a generic
 * tinted Lucide bubble.
 *
 * Each glyph fills its box edge-to-edge (a `<rect>` background, no corner
 * rounding of its own) and the consumer clips it to a rounded tile with
 * `overflow-hidden rounded-[…]` (see `ChannelCard`). Colors are hard-coded, so
 * these are rendered OUTSIDE `IconTile` - they are the tile. `strokeWidth` is
 * accepted and ignored (these are filled marks) so a glyph stays a drop-in
 * `TileIcon`.
 */
interface BrandGlyphProps {
  size?: number | string;
  className?: string;
  strokeWidth?: number;
  'aria-hidden'?: boolean | 'true' | 'false';
}

/** WhatsApp app icon - green gradient square, white speech bubble, green phone. */
export function WhatsAppGlyph({
  size = 40,
  className,
  'aria-hidden': ariaHidden = true,
}: BrandGlyphProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden={ariaHidden}
    >
      <defs>
        <linearGradient id="oyechats-wa-grad" x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#57D163" />
          <stop offset="1" stopColor="#23B33A" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" fill="url(#oyechats-wa-grad)" />
      <g transform="translate(2.4 2.4) scale(0.8)">
        <path
          fill="#FFF"
          d="M12.05 2.008c-5.446 0-9.88 4.434-9.883 9.884a9.86 9.86 0 001.51 5.26l.235.373-.999 3.648 3.742-.981.36.214a9.86 9.86 0 005.02 1.376h.005c5.442 0 9.876-4.434 9.879-9.884a9.816 9.816 0 00-2.892-6.99 9.826 9.826 0 00-6.987-2.9z"
        />
        <path
          fill="#25D366"
          d="M9.32 7.03c-.222-.494-.455-.504-.667-.512l-.568-.007a1.09 1.09 0 00-.79.371c-.272.297-1.039 1.016-1.039 2.479 0 1.462 1.064 2.875 1.213 3.074.148.198 2.096 3.358 5.176 4.585 2.56 1.02 3.081.817 3.637.767.556-.05 1.793-.733 2.046-1.44.253-.708.253-1.315.177-1.442-.076-.126-.273-.202-.57-.35-.297-.15-1.758-.868-2.031-.967-.272-.099-.47-.148-.669.149-.198.297-.767.966-.941 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.019-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.297-.497.099-.198.05-.372-.025-.52-.074-.15-.653-1.62-.92-2.226z"
        />
      </g>
    </svg>
  );
}

/** Messenger app icon - blue gradient square, white bubble, blue lightning. */
export function MessengerGlyph({
  size = 40,
  className,
  'aria-hidden': ariaHidden = true,
}: BrandGlyphProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden={ariaHidden}
    >
      <defs>
        <linearGradient id="oyechats-msgr-grad" x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00B2FF" />
          <stop offset="1" stopColor="#006AFF" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" fill="url(#oyechats-msgr-grad)" />
      <g transform="translate(2.4 2.4) scale(0.8)">
        <path
          fill="#FFF"
          d="M12 0C5.24 0 0 4.955 0 11.64c0 3.499 1.435 6.522 3.771 8.61.196.176.315.421.323.685l.065 2.138a.96.96 0 001.347.847l2.385-1.053a.96.96 0 01.641-.046A13.06 13.06 0 0012 23.28c6.76 0 12-4.954 12-11.64C24 4.955 18.76 0 12 0z"
        />
        <path
          fill="#0A87FF"
          d="M4.795 15.043l3.526-5.596a1.8 1.8 0 012.6-.48l2.806 2.102a.72.72 0 00.868-.003l3.79-2.876c.505-.384 1.165.22.827.759l-3.525 5.595a1.8 1.8 0 01-2.601.48l-2.805-2.102a.72.72 0 00-.868.003l-3.79 2.877c-.506.384-1.166-.22-.828-.759z"
        />
      </g>
    </svg>
  );
}
