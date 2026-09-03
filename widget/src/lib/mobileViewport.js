/**
 * Geometry for the full-screen phone layout of the chat panel.
 *
 * On a phone the panel is sized to the browser's *visual* viewport (the part
 * of the page the visitor can actually see) rather than to the layout
 * viewport, because the on-screen keyboard shrinks only the former: iOS
 * Safari and Chrome on Android both leave `100dvh` and
 * `position: fixed; inset: 0` spanning the area under the keyboard. Placing
 * the panel at the visual viewport's offset and size keeps the composer above
 * the keyboard.
 *
 * Two details this must get right, both seen in production on real phones:
 *
 * - `left` follows `offsetLeft`, never a constant 0. When the page is zoomed
 *   (a pinch, or Safari's automatic zoom into a focused control with text
 *   smaller than 16px) the visual viewport is narrower than the layout
 *   viewport and can be panned sideways. A panel pinned at `left: 0` with
 *   `width: vv.width` then hangs off one edge and leaves a strip of host page
 *   down the other.
 * - The geometry is re-read after the keyboard animation has finished, not
 *   only when the first resize event arrives. Android keyboards animate for
 *   roughly 300ms and Chrome can report an intermediate height before then.
 */

/** Below this width the panel is full-screen and JS owns its geometry. */
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * Delays (ms) after the last viewport resize event at which the geometry is
 * re-read. Both keyboard animations (iOS about 250ms, Android about 300ms)
 * finish before the last of these.
 */
export const VIEWPORT_SETTLE_DELAYS_MS = Object.freeze([150, 450]);

/** Inline style properties `panelStyleForViewport` writes. */
export const PANEL_STYLE_KEYS = Object.freeze(['height', 'width', 'top', 'left', 'bottom']);

/**
 * Inline style that makes the panel cover exactly the visible viewport.
 *
 * @param {{ height: number, width: number, offsetTop: number, offsetLeft: number }} vv
 *   The browser's `window.visualViewport` (or anything with its shape).
 * @returns {{ height: string, width: string, top: string, left: string, bottom: string }}
 */
export const panelStyleForViewport = (vv) => ({
    height: `${vv.height}px`,
    width: `${vv.width}px`,
    top: `${vv.offsetTop}px`,
    left: `${vv.offsetLeft}px`,
    bottom: 'auto',
});

/**
 * Whether the layout is the full-screen phone layout for a given window width.
 * @param {number} innerWidth
 * @returns {boolean}
 */
export const isPhoneLayout = (innerWidth) => innerWidth < MOBILE_BREAKPOINT_PX;
