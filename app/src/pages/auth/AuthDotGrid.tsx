/**
 * Decorative dot-grid texture for the lower area of the auth panel: a faint dot
 * grid, masked to a soft center-weighted fade, drifting slowly and continuously.
 * Purely decorative (`aria-hidden`) and non-interactive.
 */

const DOTS = 'radial-gradient(circle at center, rgba(255,255,255,0.18) 1px, transparent 1.6px)';
const FADE = 'radial-gradient(58% 95% at 50% 58%, #000 0%, rgba(0,0,0,0.45) 48%, transparent 78%)';
const DRIFT = 'oye-dot-drift 22s linear infinite';
const KEYFRAMES = '@keyframes oye-dot-drift { from { background-position: 0 0; } to { background-position: 22px 22px; } }';

export function AuthDotGrid() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[46%]">
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: DOTS,
          backgroundSize: '22px 22px',
          maskImage: FADE,
          WebkitMaskImage: FADE,
          opacity: 0.6,
          animation: DRIFT,
        }}
      />
    </div>
  );
}
