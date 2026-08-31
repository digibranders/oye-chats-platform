import type { ReactNode } from 'react';
import { simpleIconNode } from '../../../lib/simpleIcon';
import {
  siAngular,
  siAstro,
  siFramer,
  siGoogletagmanager,
  siHtml5,
  siNextdotjs,
  siReact,
  siShopify,
  siSquarespace,
  siSvelte,
  siVuedotjs,
  siWebflow,
  siWix,
  siWordpress,
} from 'simple-icons';

/**
 * The real brand mark for each platform in the Deploy picker, keyed by the
 * `Platform.id` in `data/platformIntegrations`.
 *
 * Sourced from Simple Icons (single-path, 24×24), rendered inline so there is
 * no runtime fetch and the tree-shaker keeps only the marks we name. Bubble is
 * not in the set, so it falls back to a neutral lucide glyph.
 */

export const PLATFORM_ICONS: Record<string, ReactNode> = {
  html: simpleIconNode(siHtml5),
  nextjs: simpleIconNode(siNextdotjs),
  react: simpleIconNode(siReact),
  vue: simpleIconNode(siVuedotjs),
  angular: simpleIconNode(siAngular),
  svelte: simpleIconNode(siSvelte),
  astro: simpleIconNode(siAstro),
  wordpress: simpleIconNode(siWordpress),
  shopify: simpleIconNode(siShopify),
  squarespace: simpleIconNode(siSquarespace),
  webflow: simpleIconNode(siWebflow),
  wix: simpleIconNode(siWix),
  framer: simpleIconNode(siFramer),
  // Bubble is not in Simple Icons, so its mark is hand-built: a lowercase "b"
  // (stem + bowl) in the theme's ink, with Bubble's blue dot to the lower-left.
  bubble: (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden>
      <path d="M9 3.5 V18.5" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
      <circle cx="12.7" cy="14" r="4.5" fill="none" stroke="currentColor" strokeWidth="2.3" />
      <circle cx="5" cy="18.4" r="1.9" fill="#1E5BFF" />
    </svg>
  ),
  gtm: simpleIconNode(siGoogletagmanager),
};
