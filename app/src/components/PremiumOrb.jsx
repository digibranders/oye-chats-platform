import React, { useEffect, useRef } from 'react';
import orbRenderer from '../services/orbRenderer';

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const hexToRgbNorm = (hex) => {
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

const currentDpr = () => {
    if (typeof window === 'undefined') return 1;
    return Math.min(window.devicePixelRatio || 1, 2);
};

const PremiumOrb = ({ color, size = 48, className = '', style = {} }) => {
    const canvasRef = useRef(null);
    const orbRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !orbRenderer.available) return undefined;

        const dpr = currentDpr();
        const pxSize = Math.max(1, Math.round(size * dpr));
        canvas.width = pxSize;
        canvas.height = pxSize;

        const orb = {
            destCanvas: canvas,
            destCtx: canvas.getContext('2d'),
            color: hexToRgbNorm(color),
            pxSize,
            visible: true,
        };
        orbRef.current = orb;
        orbRenderer.register(orb);

        let io;
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
                    background: `radial-gradient(circle at 40% 40%, ${safe}, ${safe}22 70%, transparent 100%)`,
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
