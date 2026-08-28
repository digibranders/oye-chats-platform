import { useEffect, useRef, type CSSProperties } from 'react';
import orbRenderer, { type Orb } from '../../../services/orbRenderer';

export interface PremiumOrbProps {
    /** Orb colour as a hex string (e.g. `#2B66BC`); an invalid value falls back to the default. */
    color?: string;
    /** Rendered diameter in CSS pixels. */
    size?: number;
    className?: string;
    style?: CSSProperties;
}

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const hexToRgbNorm = (hex: string | undefined): Float32Array => {
    const safe = typeof hex === 'string' && HEX_RE.test(hex) ? hex : '#2B66BC';
    const raw = safe.replace('#', '');
    const full = raw.length === 3
        ? raw.split('').map((c) => c + c).join('')
        : raw.slice(0, 6).padEnd(6, '0');
    const n = parseInt(full, 16);
    return new Float32Array([
        ((n >> 16) & 255) / 255,
        ((n >> 8) & 255) / 255,
        (n & 255) / 255,
    ]);
};

const currentDpr = (): number => {
    if (typeof window === 'undefined') return 1;
    return Math.min(window.devicePixelRatio || 1, 2);
};

const PremiumOrb = ({ color, size = 48, className = '', style = {} }: PremiumOrbProps) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const orbRef = useRef<Orb | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !orbRenderer.available) return undefined;

        const dpr = currentDpr();
        const pxSize = Math.max(1, Math.round(size * dpr));
        canvas.width = pxSize;
        canvas.height = pxSize;

        const orb: Orb = {
            destCanvas: canvas,
            destCtx: canvas.getContext('2d'),
            color: hexToRgbNorm(color),
            pxSize,
            visible: true,
        };
        orbRef.current = orb;
        orbRenderer.register(orb);

        let io: IntersectionObserver | undefined;
        if (typeof IntersectionObserver !== 'undefined') {
            io = new IntersectionObserver(([entry]) => {
                orb.visible = entry.isIntersecting;
            }, { threshold: 0.01 });
            io.observe(canvas);
        }

        return () => {
            orbRenderer.unregister(orb);
            io?.disconnect();
            orbRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const orb = orbRef.current;
        if (!orb) return;
        orb.color = hexToRgbNorm(color);
        const dpr = currentDpr();
        const pxSize = Math.max(1, Math.round(size * dpr));
        if (orb.pxSize !== pxSize) {
            orb.pxSize = pxSize;
            orb.destCanvas.width = pxSize;
            orb.destCanvas.height = pxSize;
        }
        orbRenderer.poke(orb);
    }, [color, size]);

    if (!orbRenderer.available) {
        const safe = typeof color === 'string' && HEX_RE.test(color) ? color : '#2B66BC';
        return (
            <div
                className={`oyechats-premium-orb ${className}`.trim()}
                style={{
                    width: size,
                    height: size,
                    display: 'inline-block',
                    flexShrink: 0,
                    borderRadius: '50%',
                    // Flat, not a radial gradient. DESIGN.md §6.5 bans gradient
                    // chrome, and a second visual identity that appears only
                    // when the GPU path fails is one nobody has reviewed. The
                    // hex-with-alpha arithmetic went with it.
                    background: safe,
                    opacity: 0.9,
                    ...style,
                }}
                aria-hidden="true"
            />
        );
    }

    return (
        <canvas
            ref={canvasRef}
            className={`oyechats-premium-orb ${className}`.trim()}
            style={{
                width: size,
                height: size,
                display: 'inline-block',
                flexShrink: 0,
                borderRadius: '50%',
                ...style,
            }}
            aria-hidden="true"
        />
    );
};

export default PremiumOrb;
