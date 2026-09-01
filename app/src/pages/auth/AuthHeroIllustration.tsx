/**
 * Decorative hero illustration for the auth left panel: two frosted glass
 * document cards viewed at a three-quarter angle, a transparent-lens glass
 * magnifier, and three floating glass chips (chat / file / sparkle) with soft
 * orbital dot trails, over a very light floor glow.
 *
 * It is a self-contained, purely decorative asset (`aria-hidden`): the CSS 3D
 * panels and the SVG overlay are authored as static markup and scoped under
 * `.oye-hero`, then scaled to fit. Nothing here is interactive or data-driven.
 */

const STYLES = `
.oye-hero { position: relative; width: 541px; height: 377px; max-width: 100%; }
.oye-hero__stage { position: absolute; top: 0; left: 0; width: 660px; height: 460px; transform: scale(0.82); transform-origin: top left; }
.oye-hero .scene { position: absolute; inset: 0; perspective: 900px; perspective-origin: 50% 50%; }
.oye-hero .group { position: absolute; left: 130px; top: 70px; width: 400px; height: 320px; transform-style: preserve-3d; transform: rotateY(30deg) rotateX(4deg); }
.oye-hero .panel { position: absolute; width: 224px; height: 196px; border-radius: 22px; background: linear-gradient(150deg, rgba(245,248,252,0.13) 0%, rgba(224,230,240,0.06) 50%, rgba(210,218,232,0.025) 100%); border: 1px solid rgba(255,255,255,0.26); box-shadow: inset 0 1.5px 0 rgba(255,255,255,0.34), inset 1.5px 0 0 rgba(255,255,255,0.12), 0 40px 60px -22px rgba(0,0,0,0.7); transform-style: preserve-3d; }
.oye-hero .panel::before { content: ""; position: absolute; inset: 0; border-radius: 22px; background: linear-gradient(150deg, rgba(220,228,240,0.10), rgba(175,186,204,0.04)); transform: translateZ(-16px); box-shadow: 0 0 0 1px rgba(255,255,255,0.05); }
.oye-hero .front { left: 158px; top: 110px; background: linear-gradient(150deg, rgba(58,61,68,0.55) 0%, rgba(36,38,44,0.66) 52%, rgba(28,30,36,0.72) 100%), #0c0d0f; }
.oye-hero .front::after { content: ""; position: absolute; inset: 0; border-radius: 22px; pointer-events: none; background: radial-gradient(140px 110px at 10% 6%, rgba(255,255,255,0.26), rgba(255,255,255,0) 62%), linear-gradient(135deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 12%); }
.oye-hero .bar { position: absolute; height: 13px; border-radius: 7px; background: linear-gradient(90deg, rgba(255,255,255,0.5), rgba(255,255,255,0.24)); }
.oye-hero .b1 { left: 44px; top: 74px; width: 128px; }
.oye-hero .b2 { left: 44px; top: 100px; width: 148px; }
.oye-hero .b3 { left: 44px; top: 126px; width: 106px; }
`;

const STAGE = `
<div class="scene">
  <div class="group">
    <div class="panel front">
      <span class="bar b1"></span>
      <span class="bar b2"></span>
      <span class="bar b3"></span>
    </div>
  </div>
</div>
<svg class="overlay" width="660" height="460" viewBox="0 0 660 460" style="position:absolute;inset:0" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="hgMetal" x1="0.3" y1="0" x2="0.62" y2="1">
      <stop offset="0" stop-color="#f2f3fa"/><stop offset="0.38" stop-color="#c6cadd"/><stop offset="0.68" stop-color="#a0a5c1"/><stop offset="1" stop-color="#767b99"/>
    </linearGradient>
    <linearGradient id="hgHandle" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#7c8199"/><stop offset="0.42" stop-color="#edeef6"/><stop offset="0.66" stop-color="#c9cdde"/><stop offset="1" stop-color="#696e8b"/>
    </linearGradient>
    <radialGradient id="hgLens" cx="0.42" cy="0.32" r="0.92">
      <stop offset="0" stop-color="#343b56"/><stop offset="0.5" stop-color="#171b2c"/><stop offset="1" stop-color="#05060c"/>
    </radialGradient>
    <linearGradient id="hgNeck" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8489a1"/><stop offset="0.5" stop-color="#e4e6f1"/><stop offset="1" stop-color="#707596"/>
    </linearGradient>
    <linearGradient id="hgChip" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#232327"/><stop offset="1" stop-color="#0e0e10"/>
    </linearGradient>
    <linearGradient id="hgSpark" x1="0.15" y1="1" x2="0.85" y2="0">
      <stop offset="0" stop-color="#e2894c"/><stop offset="0.45" stop-color="#f3c398"/><stop offset="1" stop-color="#fdf4ea"/>
    </linearGradient>
    <linearGradient id="hgIcon" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#cadbec"/><stop offset="0.5" stop-color="#f2ece2"/><stop offset="1" stop-color="#e88c49"/>
    </linearGradient>
    <linearGradient id="hgConn" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d3d7e0" stop-opacity="0.5"/><stop offset="1" stop-color="#d3d7e0" stop-opacity="0.06"/>
    </linearGradient>
    <radialGradient id="hgFloor" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.07"/><stop offset="0.6" stop-color="#ffffff" stop-opacity="0.025"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="hgChipGlow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="hgSparkGlow" x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="3.5"/></filter>
  </defs>

  <ellipse cx="452" cy="392" rx="178" ry="52" fill="url(#hgFloor)"/>

  <g transform="translate(482 312) scale(0.68)">
    <g transform="rotate(-45)">
      <rect x="-8" y="48" width="16" height="34" rx="5" fill="url(#hgNeck)"/>
      <rect x="-13" y="64" width="26" height="74" rx="13" fill="url(#hgHandle)" stroke="#5b607e" stroke-opacity="0.5" stroke-width="1"/>
      <rect x="-7" y="70" width="5" height="58" rx="2.5" fill="#ffffff" fill-opacity="0.6"/>
    </g>
    <circle r="52" fill="none" stroke="url(#hgMetal)" stroke-width="14"/>
    <circle r="59" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.3"/>
    <circle r="59" fill="none" stroke="#565b78" stroke-opacity="0.5" stroke-width="1.3" stroke-dasharray="95 190" stroke-dashoffset="120"/>
    <circle r="45" fill="none" stroke="#4a4f6c" stroke-opacity="0.5" stroke-width="1.1"/>
    <path d="M -44 -32 A 54 54 0 0 1 26 -49" fill="none" stroke="#ffffff" stroke-opacity="0.9" stroke-width="3.5" stroke-linecap="round"/>
    <circle r="44.5" fill="#dfe6f2" fill-opacity="0.05"/>
    <circle r="44.5" fill="none" stroke="#9aa2be" stroke-opacity="0.45" stroke-width="1.4"/>
    <path d="M -37 -24 C -24 -40, 6 -42, 26 -30 C 8 -23, -17 -18, -37 -24 Z" fill="#ffffff" fill-opacity="0.16"/>
    <ellipse cx="-18" cy="-19" rx="13" ry="6.5" fill="#ffffff" fill-opacity="0.28" transform="rotate(-28 -18 -19)"/>
    <path d="M 30 24 A 44 44 0 0 1 4 40" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2" stroke-linecap="round"/>
  </g>

  <path d="M 302 100 C 282 106, 268 124, 272 148" fill="none" stroke="url(#hgConn)" stroke-width="1.5" stroke-dasharray="0.5 9" stroke-linecap="round"/>
  <path d="M 182 196 C 204 210, 204 242, 178 254" fill="none" stroke="url(#hgConn)" stroke-width="1.5" stroke-dasharray="0.5 9" stroke-linecap="round"/>
  <path d="M 570 234 C 548 249, 548 281, 574 295" fill="none" stroke="url(#hgConn)" stroke-width="1.5" stroke-dasharray="0.5 9" stroke-linecap="round"/>

  <g transform="translate(323 69) scale(0.8) translate(-29 -29)">
    <rect x="-4" y="-4" width="66" height="66" rx="21" fill="#e2894c" fill-opacity="0.06" filter="url(#hgChipGlow)"/>
    <rect width="58" height="58" rx="18" fill="url(#hgChip)" stroke="#ffffff" stroke-opacity="0.14"/>
    <path d="M 15 1.5 H 43" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1" stroke-linecap="round"/>
    <g filter="url(#hgSparkGlow)" opacity="0.55">
      <path d="M 23 14 h 12 a6 6 0 0 1 6 6 v 12 a6 6 0 0 1 -6 6 h -8 l -6 6 v -6 a6 6 0 0 1 -6 -6 v -12 a6 6 0 0 1 6 -6 z" fill="none" stroke="url(#hgIcon)" stroke-width="2.6"/>
    </g>
    <path d="M 23 14 h 12 a6 6 0 0 1 6 6 v 12 a6 6 0 0 1 -6 6 h -8 l -6 6 v -6 a6 6 0 0 1 -6 -6 v -12 a6 6 0 0 1 6 -6 z" fill="none" stroke="url(#hgIcon)" stroke-width="1.9"/>
    <circle cx="22" cy="26" r="1.9" fill="#f4ede4"/><circle cx="28" cy="26" r="1.9" fill="#f4ede4"/><circle cx="34" cy="26" r="1.9" fill="#f4ede4"/>
  </g>
  <g transform="translate(151 207) scale(0.8) translate(-29 -29)">
    <rect x="-4" y="-4" width="66" height="66" rx="21" fill="#e2894c" fill-opacity="0.06" filter="url(#hgChipGlow)"/>
    <rect width="58" height="58" rx="18" fill="url(#hgChip)" stroke="#ffffff" stroke-opacity="0.14"/>
    <path d="M 15 1.5 H 43" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1" stroke-linecap="round"/>
    <g filter="url(#hgSparkGlow)" opacity="0.55">
      <path d="M 21 16 h 11 l 8 8 v 17 a2 2 0 0 1 -2 2 h -17 a2 2 0 0 1 -2 -2 v -23 a2 2 0 0 1 2 -2 z" fill="none" stroke="url(#hgIcon)" stroke-width="2.6"/>
      <path d="M 24 33 h 11 M 24 38 h 11" stroke="url(#hgIcon)" stroke-width="2.4" stroke-linecap="round"/>
    </g>
    <path d="M 21 16 h 11 l 8 8 v 17 a2 2 0 0 1 -2 2 h -17 a2 2 0 0 1 -2 -2 v -23 a2 2 0 0 1 2 -2 z" fill="none" stroke="url(#hgIcon)" stroke-width="1.9"/>
    <path d="M 32 16 v 8 h 8" fill="none" stroke="url(#hgIcon)" stroke-width="1.9"/>
    <path d="M 24 33 h 11 M 24 38 h 11" stroke="url(#hgIcon)" stroke-width="1.6" stroke-linecap="round"/>
  </g>
  <g transform="translate(597 245) scale(0.8) translate(-29 -29)">
    <rect x="-4" y="-4" width="66" height="66" rx="21" fill="#e2894c" fill-opacity="0.06" filter="url(#hgChipGlow)"/>
    <rect width="58" height="58" rx="18" fill="url(#hgChip)" stroke="#ffffff" stroke-opacity="0.14"/>
    <path d="M 15 1.5 H 43" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1" stroke-linecap="round"/>
    <g transform="translate(29 29) scale(0.72) translate(-29 -29)">
      <path d="M 29 13 C 30 24.5, 34 28, 45 29 C 34 30, 30 33.5, 29 45 C 28 33.5, 24 30, 13 29 C 24 28, 28 24.5, 29 13 Z" fill="#e78e4f" fill-opacity="0.55" filter="url(#hgSparkGlow)"/>
      <path d="M 29 13 C 30 24.5, 34 28, 45 29 C 34 30, 30 33.5, 29 45 C 28 33.5, 24 30, 13 29 C 24 28, 28 24.5, 29 13 Z" fill="url(#hgSpark)"/>
    </g>
  </g>
</svg>
`;

export function AuthHeroIllustration({ className }: { className?: string }) {
  return (
    <div className={className} data-testid="auth-hero-illustration">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="oye-hero" aria-hidden>
        <div className="oye-hero__stage" dangerouslySetInnerHTML={{ __html: STAGE }} />
      </div>
    </div>
  );
}
