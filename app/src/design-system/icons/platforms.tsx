import { type ReactElement } from 'react';

/**
 * Platform logos - faithful brand marks for the Website install picker
 * (Next.js, React, Vue, WordPress, Shopify, ...). Each is a self-colored SVG in
 * a 24-box so a consumer can scale it freely. These reproduce each platform's
 * real logo so an entry reads as *itself* at a glance.
 *
 * Consumers key `platformLogos` by the platform id from
 * `data/platformIntegrations` and render the component at a fixed size.
 */
export interface PlatformGlyphProps {
  size?: number | string;
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

export type PlatformGlyph = (props: PlatformGlyphProps) => ReactElement;

export function HtmlLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <path d="M4.2 2.6l1.5 16.9L12 21.4l6.3-1.9 1.5-16.9z" fill="#E34F26" />
      <path d="M12 4.1v15.6l5.1-1.5 1.28-14.1z" fill="#F16529" />
      <text
        x="12"
        y="16.2"
        fontFamily="Arial, sans-serif"
        fontSize="10.5"
        fontWeight="700"
        fill="#fff"
        textAnchor="middle"
      >
        5
      </text>
    </svg>
  );
}

export function NextjsLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <circle cx="12" cy="12" r="10" fill="#000" />
      <path d="M8.8 7.4v9.2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8.9 7.7l7.1 9.2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M15.2 7.4v5.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ReactLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <circle cx="12" cy="12" r="1.7" fill="#61DAFB" />
      <ellipse cx="12" cy="12" rx="10" ry="3.8" stroke="#61DAFB" strokeWidth="1" fill="none" />
      <ellipse cx="12" cy="12" rx="10" ry="3.8" stroke="#61DAFB" strokeWidth="1" fill="none" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="3.8" stroke="#61DAFB" strokeWidth="1" fill="none" transform="rotate(120 12 12)" />
    </svg>
  );
}

export function VueLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <path d="M2.5 3.5h4L12 12.9l5.5-9.4h4L12 20.5z" fill="#41B883" />
      <path d="M6.5 3.5h3.2L12 7.4l2.3-3.9h3.2L12 12.9z" fill="#35495E" />
    </svg>
  );
}

export function AngularLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <path d="M12 2.2 2.8 5.4 4.3 18.1 12 22l7.7-3.9 1.5-12.7z" fill="#E23237" />
      <path d="M12 2.2V22l7.7-3.9 1.5-12.7z" fill="#B52E31" />
      <path d="M12 5.3 6.9 16.7h1.9l1-2.6h4.3l1 2.6h1.9zm1.5 6.7h-3L12 8.4z" fill="#fff" />
    </svg>
  );
}

export function SvelteLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <path
        d="M19.6 4.9C17.6 1.9 13.6 1 10.6 2.9L5.9 5.9C4.5 6.8 3.5 8.2 3.2 9.9c-.2 1.4 0 2.9.7 4.1-.5.7-.8 1.6-.9 2.5-.2 1.7.2 3.4 1.2 4.8 2 3 6 3.9 9 2l4.7-3c1.4-.9 2.4-2.3 2.7-4 .2-1.4 0-2.9-.7-4.1.5-.7.8-1.6.9-2.5.2-1.7-.2-3.4-1.2-4.8z"
        fill="#FF3E00"
      />
      <path
        d="M10.4 19.3c-1.7.4-3.5-.3-4.5-1.7-.6-.8-.8-1.9-.7-2.9.1-.2.1-.3.2-.5l.1-.3.3.2c.7.5 1.4.9 2.3 1.1l.2.1v.2c0 .3.1.6.3.8.3.4.8.6 1.3.5.1 0 .2-.1.3-.1l4.7-3c.3-.2.5-.5.5-.8.1-.4 0-.7-.2-1-.3-.4-.8-.6-1.3-.5-.1 0-.2.1-.3.1l-1.8 1.1c-.4.2-.8.4-1.3.5-1.7.4-3.5-.3-4.5-1.7-.6-.8-.8-1.9-.7-2.9.2-1 .8-1.9 1.6-2.4l4.7-3c.4-.2.8-.4 1.3-.5 1.7-.4 3.5.3 4.5 1.7.6.8.8 1.9.7 2.9-.1.2-.1.3-.2.5l-.1.3-.3-.2c-.7-.5-1.4-.9-2.3-1.1l-.2-.1v-.2c0-.3-.1-.6-.3-.8-.3-.4-.8-.6-1.3-.5-.1 0-.2.1-.3.1l-4.7 3c-.3.2-.5.5-.5.8-.1.4 0 .7.2 1 .3.4.8.6 1.3.5.1 0 .2-.1.3-.1l1.8-1.1c.4-.2.8-.4 1.3-.5 1.7-.4 3.5.3 4.5 1.7.6.8.8 1.9.7 2.9-.2 1-.8 1.9-1.6 2.4l-4.7 3c-.4.2-.8.4-1.4.5z"
        fill="#fff"
      />
    </svg>
  );
}

export function AstroLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <rect width="24" height="24" rx="5" fill="#17191E" />
      <g transform="translate(4.2 4.2) scale(0.65)">
        {/* orange sweep at the base, Astro's signature accent */}
        <path
          d="M8.358 20.162c-1.186-1.07-1.532-3.316-1.038-4.944.856 1.026 2.043 1.352 3.272 1.535 1.897.283 3.76.177 5.522-.678.202-.098.388-.229.608-.36.166.473.209.95.151 1.437-.14 1.185-.738 2.1-1.688 2.794-.38.277-.782.525-1.175.787-1.205.804-1.531 1.747-1.078 3.119l.044.148a3.158 3.158 0 0 1-1.407-1.188 3.31 3.31 0 0 1-.544-1.815c-.004-.32-.004-.642-.048-.958-.106-.769-.472-1.113-1.161-1.133-.707-.02-1.267.411-1.415 1.09-.012.053-.028.104-.045.165h.002z"
          fill="#FF5D01"
        />
        {/* white "A" spire */}
        <path
          d="M2.397 15.717s3.24-1.575 6.49-1.575l2.451-7.565c.092-.366.36-.614.662-.614.302 0 .57.248.662.614l2.45 7.565c3.85 0 6.491 1.575 6.491 1.575L16.088.727C15.93.285 15.663 0 15.303 0H8.697c-.36 0-.615.285-.784.727l-5.516 14.99z"
          fill="#fff"
        />
      </g>
    </svg>
  );
}

export function WordPressLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <circle cx="12" cy="12" r="9.4" fill="#21759B" />
      <path
        d="M3.4 12c0 3.4 2 6.3 4.8 7.7L4 9.1c-.4.9-.6 1.9-.6 2.9zM17.6 11.6c0-1.1-.4-1.8-.7-2.4-.5-.7-.9-1.3-.9-2 0-.8.6-1.5 1.4-1.5h.1A8.5 8.5 0 0 0 12 3.4c-2.9 0-5.4 1.5-6.9 3.7h.5c.9 0 2.2-.1 2.2-.1.5 0 .5.7 0 .7 0 0-.5.1-1 .1L9.9 15l1.9-5.6-1.3-3.6c-.5 0-.9-.1-.9-.1-.5 0-.4-.7 0-.7 0 0 1.4.1 2.2.1.9 0 2.2-.1 2.2-.1.5 0 .5.7 0 .7 0 0-.5.1-1 .1l3 9 .9-2.8c.4-1.2.5-1.9.5-2.3zM12.1 12.8 9.6 20a8.5 8.5 0 0 0 5.2-.1l-.1-.1zM19.3 8a6.5 6.5 0 0 1 .1 4.4l-2.7 7.6A8.6 8.6 0 0 0 19.3 8z"
        fill="#fff"
      />
    </svg>
  );
}

export function ShopifyLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <g transform="translate(3.3 0.6) scale(0.94)">
        {/* shopping bag body + handle */}
        <path
          d="M17.6 4.6c-.02-.11-.11-.19-.2-.19-.1 0-1.83-.13-1.83-.13s-1.21-1.2-1.36-1.34c-.14-.13-.4-.09-.5-.06l-.68.21c-.4-1.16-1.12-2.23-2.37-2.23h-.11C10.2.32 9.76.13 9.38.13 6.45.14 5.05 3.8 4.61 5.66l-2.05.63c-.63.2-.65.22-.74.82C1.75 7.56 0 21.1 0 21.1L13.63 24l3.98-.86S17.62 4.71 17.6 4.6zM12.15 3.2l-1.1.34v-.24c0-.72-.1-1.31-.26-1.77.65.08 1.08.82 1.36 1.67zM9.98 1.72c.18.45.29 1.1.29 1.97v.14l-2.27.7c.44-1.68 1.26-2.5 1.98-2.81zM9.1.9c.13 0 .26.04.38.13-.95.45-1.97 1.57-2.4 3.82l-1.8.55C5.79 3.7 6.97.9 9.1.9z"
          fill="#95BF47"
        />
        {/* darker fold on the right edge */}
        <path
          d="M17.4 4.41c-.1 0-1.83-.13-1.83-.13s-1.21-1.2-1.36-1.34a.33.33 0 0 0-.18-.09L13.64 24l3.98-.86S17.62 4.71 17.6 4.6a.23.23 0 0 0-.2-.19z"
          fill="#5E8E3E"
        />
        {/* white "S" */}
        <path
          d="M11.08 8.03l-.49 1.46s-.43-.23-.96-.23c-.78 0-.82.49-.82.61 0 .67 1.75.93 1.75 2.5 0 1.24-.78 2.03-1.84 2.03-1.27 0-1.91-.79-1.91-.79l.34-1.12s.66.57 1.22.57c.37 0 .52-.29.52-.5 0-.87-1.43-.91-1.43-2.35 0-1.21.87-2.38 2.62-2.38.68 0 1.01.19 1.01.19z"
          fill="#fff"
        />
      </g>
    </svg>
  );
}

export function SquarespaceLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <rect width="24" height="24" rx="5" fill="#121212" />
      <g transform="translate(3.6 3.6) scale(0.7)">
        <path
          d="M22.655 8.719c-1.802-1.801-4.726-1.801-6.564 0l-7.351 7.35c-.45.45-.45 1.2 0 1.65.45.449 1.2.449 1.65 0l7.351-7.351c.899-.899 2.362-.899 3.264 0 .9.9.9 2.364 0 3.264l-7.239 7.239c.9.899 2.362.899 3.263 0l5.589-5.589c1.836-1.838 1.836-4.763.037-6.563zm-2.475 2.437c-.451-.45-1.201-.45-1.65 0l-7.354 7.389c-.9.899-2.361.899-3.262 0-.45-.45-1.2-.45-1.65 0s-.45 1.2 0 1.649c1.801 1.801 4.726 1.801 6.564 0l7.351-7.35c.449-.487.449-1.239.001-1.688zm-2.439-7.35c-1.801-1.801-4.726-1.801-6.564 0l-7.351 7.351c-.45.449-.45 1.199 0 1.649s1.2.45 1.65 0l7.395-7.351c.9-.899 2.371-.899 3.27 0 .451.45 1.201.45 1.65 0 .421-.487.421-1.199-.029-1.649h-.021zm-2.475 2.437c-.45-.45-1.2-.45-1.65 0l-7.351 7.389c-.899.9-2.363.9-3.265 0-.9-.899-.9-2.363 0-3.264l7.239-7.239c-.9-.9-2.362-.9-3.263 0L1.35 8.719c-1.8 1.8-1.8 4.725 0 6.563 1.801 1.801 4.725 1.801 6.564 0l7.35-7.351c.451-.488.451-1.238 0-1.688h.002z"
          fill="#fff"
        />
      </g>
    </svg>
  );
}

export function WebflowLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <rect width="24" height="24" rx="5" fill="#4353FF" />
      <g transform="translate(4.55 4.56) scale(0.62)">
        <path
          d="m24 4.515-7.658 14.97H9.149l3.205-6.204h-.144C9.566 16.713 5.621 18.973 0 19.485v-6.118s3.596-.213 5.71-2.435H0V4.515h6.417v5.278l.144-.001 2.622-5.277h4.854v5.244h.144l2.72-5.244H24Z"
          fill="#fff"
        />
      </g>
    </svg>
  );
}

export function WixLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  // The Wix brand mark is a wordmark, wider than tall - keep its aspect ratio by
  // deriving width from the requested height. `currentColor` lets it read on both
  // light and dark surfaces.
  const width = typeof size === 'number' ? Math.round((size * 46) / 24) : size;
  return (
    <svg width={width} height={size} viewBox="0 0 46 24" fill="none" className={className} aria-hidden={a}>
      <text
        x="0"
        y="18"
        fontFamily="Arial, sans-serif"
        fontSize="18"
        fontWeight="800"
        fill="currentColor"
        letterSpacing="-0.5"
      >
        Wix
      </text>
    </svg>
  );
}

export function FramerLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <path d="M6 3h12v6h-6zM6 9h6l6 6h-6v6l-6-6z" fill="#0055FF" />
    </svg>
  );
}

export function BubbleLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      <rect x="2" y="2" width="20" height="20" rx="6" fill="#0D0D14" />
      {/* lowercase "b" */}
      <path
        d="M8.6 5.4v4.7a3.1 3.1 0 0 1 2.4-1.1c1.9 0 3.3 1.5 3.3 3.6s-1.4 3.6-3.3 3.6c-1.1 0-2-.5-2.5-1.3l-.2 1.1H6.8V5.4zm2.1 9.4c1.1 0 1.9-.9 1.9-2.1s-.8-2.1-1.9-2.1-1.9.9-1.9 2.1.8 2.1 1.9 2.1z"
        fill="#fff"
      />
      {/* signature period dot */}
      <circle cx="16" cy="15.4" r="1.7" fill="#3C6DF5" />
    </svg>
  );
}

export function GtmLogo({ size = 24, className, 'aria-hidden': a = true }: PlatformGlyphProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden={a}>
      {/* Hollow rounded-diamond ring, split two-tone: medium-blue lower-left,
          light-blue upper-right. Built from two thick round strokes so the centre
          stays a clean diamond negative-space. */}
      <path
        d="M12 5.15 5.15 12 12 18.85"
        stroke="#4285F4"
        strokeWidth="5.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 5.15 18.85 12 12 18.85"
        stroke="#8AB4F8"
        strokeWidth="5.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* dot at the bottom vertex */}
      <circle cx="11" cy="19.3" r="2.9" fill="#3B6FE0" />
    </svg>
  );
}
