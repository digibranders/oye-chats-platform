import {
  AngularLogo,
  AstroLogo,
  BubbleLogo,
  FramerLogo,
  GtmLogo,
  HtmlLogo,
  NextjsLogo,
  ReactLogo,
  ShopifyLogo,
  SquarespaceLogo,
  SvelteLogo,
  VueLogo,
  WebflowLogo,
  WixLogo,
  WordPressLogo,
  type PlatformGlyph,
} from './platforms';

/**
 * Platform id (from `data/platformIntegrations`) → brand logo component. Kept in
 * its own module (not `platforms.tsx`) so that file only exports components,
 * satisfying the react-refresh/only-export-components lint rule.
 */
export const platformLogos: Record<string, PlatformGlyph> = {
  html: HtmlLogo,
  nextjs: NextjsLogo,
  react: ReactLogo,
  vue: VueLogo,
  angular: AngularLogo,
  svelte: SvelteLogo,
  astro: AstroLogo,
  wordpress: WordPressLogo,
  shopify: ShopifyLogo,
  squarespace: SquarespaceLogo,
  webflow: WebflowLogo,
  wix: WixLogo,
  framer: FramerLogo,
  bubble: BubbleLogo,
  gtm: GtmLogo,
};
