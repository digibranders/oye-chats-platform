import type { ComponentType, CSSProperties } from 'react';

/**
 * Type shim for the reused `PremiumOrb.jsx` - the shared WebGL orb
 * renderer (the same one the embeddable widget uses), with a CSS-gradient
 * fallback when WebGL is unavailable. The `.jsx` stays the runtime source; this
 * only declares its props for TypeScript consumers.
 */
export interface PremiumOrbProps {
  /** Orb colour as a hex string (e.g. `#2B66BC`); an invalid value falls back to the default. */
  color?: string;
  /** Rendered diameter in CSS pixels. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

declare const PremiumOrb: ComponentType<PremiumOrbProps>;
export default PremiumOrb;
