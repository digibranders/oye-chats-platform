import React, { useMemo } from 'react';

interface AuthWaveIllustrationProps {
  className?: string;
}

interface GridPoint {
  x: number;
  y: number;
  depth: number;
  u: number;
  v: number;
}

/**
 * 3D Luminous Particle Mesh Wave Illustration.
 * High-fidelity recreation of the ethereal glowing purple/violet wave ribbon,
 * dense digital particle grid lattice, radiant neon laser crest spine,
 * and delicate sparkling star glints over an obsidian atmosphere.
 */
export const AuthWaveIllustration: React.FC<AuthWaveIllustrationProps> = ({ className = '' }) => {
  const VIEW_WIDTH = 1600;
  const VIEW_HEIGHT = 650;

  const {
    longitudinalPaths,
    transversePaths,
    crestSpinePath,
    crestApexPath,
    particleDots,
    sparkleStars,
  } = useMemo(() => {
    const numLongitudinal = 46; // very dense, fine silk contour lines
    const numSamples = 180; // ultra smooth longitudinal resolution
    const numTransverse = 135; // dense transverse cross-ribs

    // Centerline elevation curve matching the reference image perfectly
    const getWaveCenterY = (u: number): number => {
      // Harmonic wave elevation curve:
      // - Left entrance at y ~ 360
      // - Gentle left valley at u ~ 0.17 (y ~ 395)
      // - Elegant upward rise from u = 0.20 to 0.54
      // - Apex crest at u ~ 0.54 (y ~ 145)
      // - Cascading downward slope from u = 0.54 to 0.76 (y ~ 380)
      // - Gentle right valley at u ~ 0.82 (y ~ 400)
      // - Flowing upward curve toward right edge at u ~ 1.0 (y ~ 325)
      const leftValley = 28 * Math.exp(-Math.pow((u - 0.17) / 0.15, 2));
      const mainCrest = -205 * Math.exp(-Math.pow((u - 0.54) / 0.18, 2));
      const rightValley = 30 * Math.exp(-Math.pow((u - 0.82) / 0.14, 2));
      const rightRise = -35 * Math.exp(-Math.pow((u - 1.02) / 0.18, 2));
      const baseWave = 355 + Math.sin(u * Math.PI * 0.95 - 0.12) * 16;

      return baseWave + leftValley + mainCrest + rightValley + rightRise;
    };

    // Calculate 3D surface coordinates with true normal extrusion
    const evaluateSurface = (u: number, v: number): GridPoint => {
      const xCenter = -40 + u * (VIEW_WIDTH + 80);
      const yCenter = getWaveCenterY(u);

      // Tangent and normal calculation
      const delta = 0.004;
      const yPrev = getWaveCenterY(Math.max(0, u - delta));
      const yNext = getWaveCenterY(Math.min(1, u + delta));
      const xPrev = -40 + (u - delta) * (VIEW_WIDTH + 80);
      const xNext = -40 + (u + delta) * (VIEW_WIDTH + 80);

      const dx = xNext - xPrev;
      const dy = yNext - yPrev;
      const len = Math.sqrt(dx * dx + dy * dy);
      const nx = -dy / len;
      const ny = dx / len;

      // Ribbon width envelope: expands gracefully beneath the crest peak
      const ribbonWidth =
        24 +
        105 * Math.exp(-Math.pow((u - 0.535) / 0.22, 2)) +
        25 * Math.sin(u * Math.PI * 0.9 + 0.1);

      // 3D perspective projection: ribbon arches downwards and obliquely
      const nonLinearV = Math.pow(v, 1.12);
      const xOffset = (nx * 0.32 + (u - 0.5) * 0.12) * nonLinearV * ribbonWidth;
      const yOffset = (nonLinearV + ny * 0.22 * nonLinearV) * ribbonWidth;

      const x = xCenter + xOffset;
      const y = yCenter + yOffset;

      // Depth factor (1 = top luminous crest, 0 = distant edge)
      const crestDist = Math.abs(u - 0.54);
      const crestWeight = Math.exp(-Math.pow(crestDist / 0.25, 2));
      const edgeWeight = Math.pow(1 - v, 1.25);
      const depth = 0.2 + 0.8 * (crestWeight * 0.75 + edgeWeight * 0.25);

      return { x, y, depth, u, v };
    };

    // Precompute 2D grid
    const grid: GridPoint[][] = [];
    for (let j = 0; j < numLongitudinal; j++) {
      const v = j / (numLongitudinal - 1);
      const row: GridPoint[] = [];
      for (let i = 0; i <= numSamples; i++) {
        const u = i / numSamples;
        row.push(evaluateSurface(u, v));
      }
      grid.push(row);
    }

    // Helper: Turn point series into smooth SVG cubic Bézier curve
    const pointsToPath = (pts: Array<{ x: number; y: number }>): string => {
      if (pts.length === 0) return '';
      let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
      for (let k = 0; k < pts.length - 1; k++) {
        const p0 = pts[Math.max(0, k - 1)];
        const p1 = pts[k];
        const p2 = pts[k + 1];
        const p3 = pts[Math.min(pts.length - 1, k + 2)];

        const tension = 0.42;
        const cp1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2;
        const cp1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2;
        const cp2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2;
        const cp2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2;

        d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
      }
      return d;
    };

    // 1. Build longitudinal contour paths
    const longPaths: Array<{
      d: string;
      stroke: string;
      strokeWidth: number;
      opacity: number;
      dashArray?: string;
    }> = [];

    for (let j = 0; j < numLongitudinal; j++) {
      const v = j / (numLongitudinal - 1);
      const pts = grid[j];
      const d = pointsToPath(pts);

      const isTopCluster = v < 0.10;
      const isCoreMesh = v >= 0.10 && v < 0.52;

      const stroke = isTopCluster
        ? 'url(#crestSpineGrad)'
        : isCoreMesh
        ? 'url(#meshCoreGrad)'
        : 'url(#meshAmbientGrad)';

      const strokeWidth = isTopCluster ? 0.8 : isCoreMesh ? 0.55 : 0.4;
      const opacity = isTopCluster
        ? 0.95
        : isCoreMesh
        ? 0.35 + (1 - v) * 0.45
        : 0.10 + (1 - v) * 0.22;

      // Fine dotted particle texture on alternating lines
      const dashArray = j % 3 === 1 ? '1.5 3.0' : j % 3 === 2 ? '1.0 3.8' : undefined;

      longPaths.push({ d, stroke, strokeWidth, opacity, dashArray });
    }

    // 2. Build transverse cross-ribs (the wireframe particle grid)
    const transPaths: Array<{
      d: string;
      stroke: string;
      strokeWidth: number;
      opacity: number;
      dashArray: string;
    }> = [];

    for (let i = 0; i < numTransverse; i++) {
      const uIndex = Math.round((i / (numTransverse - 1)) * numSamples);
      const pts: Array<{ x: number; y: number }> = [];

      for (let j = 0; j < numLongitudinal; j++) {
        pts.push({ x: grid[j][uIndex].x, y: grid[j][uIndex].y });
      }

      const u = i / (numTransverse - 1);
      const d = pointsToPath(pts);
      const crestFactor = Math.exp(-Math.pow((u - 0.54) / 0.24, 2));

      transPaths.push({
        d,
        stroke: 'url(#transverseGrad)',
        strokeWidth: 0.5,
        opacity: 0.06 + crestFactor * 0.58,
        dashArray: '1.0 2.8', // ultra delicate dotted lattice
      });
    }

    // 3. Glowing Laser Crest Spine
    const spinePts: Array<{ x: number; y: number }> = [];
    const spineStart = Math.round(numSamples * 0.24);
    const spineEnd = Math.round(numSamples * 0.86);
    for (let i = spineStart; i <= spineEnd; i++) {
      spinePts.push({ x: grid[0][i].x, y: grid[0][i].y });
    }
    const crestSpineD = pointsToPath(spinePts);

    // Apex focal beam (pure white hot core right across the peak)
    const apexPts: Array<{ x: number; y: number }> = [];
    const apexStart = Math.round(numSamples * 0.43);
    const apexEnd = Math.round(numSamples * 0.65);
    for (let i = apexStart; i <= apexEnd; i++) {
      apexPts.push({ x: grid[0][i].x, y: grid[0][i].y });
    }
    const crestApexD = pointsToPath(apexPts);

    // 4. Subtle luminous micro-particles at grid intersections
    const dots: Array<{ x: number; y: number; r: number; opacity: number; fill: string }> = [];
    for (let j = 1; j < numLongitudinal; j += 2) {
      const v = j / (numLongitudinal - 1);
      for (let i = 0; i <= numSamples; i += 2) {
        const u = i / numSamples;
        const pt = grid[j][i];
        const crestIntensity = Math.exp(-Math.pow((u - 0.54) / 0.22, 2));
        const heightIntensity = Math.pow(1 - v, 1.2);
        const score = crestIntensity * 0.8 + heightIntensity * 0.35;

        if (score > 0.38) {
          dots.push({
            x: pt.x,
            y: pt.y,
            r: 0.5 + score * 0.6,
            opacity: Math.min(0.9, score * 0.85),
            fill: score > 0.72 ? '#f5f3ff' : '#c084fc',
          });
        }
      }
    }

    // 5. Sparkling Star Glints (positioned precisely matching the reference image)
    const stars = [
      { x: 885, y: 152, size: 15, opacity: 1.0, coreColor: '#ffffff', glowColor: '#e9d5ff' }, // Focal star right on crest top
      { x: 980, y: 182, size: 11, opacity: 0.95, coreColor: '#ffffff', glowColor: '#d8b4fe' }, // Near crest top right
      { x: 748, y: 228, size: 10, opacity: 0.85, coreColor: '#ffffff', glowColor: '#c084fc' }, // Slope left
      { x: 672, y: 295, size: 9, opacity: 0.75, coreColor: '#f5f3ff', glowColor: '#a855f7' }, // Mid rise
      { x: 475, y: 405, size: 12, opacity: 0.9, coreColor: '#ffffff', glowColor: '#c084fc' }, // Left valley bright star
      { x: 260, y: 395, size: 8, opacity: 0.6, coreColor: '#e9d5ff', glowColor: '#9333ea' }, // Far left
      { x: 830, y: 345, size: 9, opacity: 0.7, coreColor: '#ffffff', glowColor: '#a855f7' }, // Center depth
      { x: 1040, y: 275, size: 10, opacity: 0.8, coreColor: '#ffffff', glowColor: '#c084fc' }, // Right slope
      { x: 1170, y: 365, size: 9, opacity: 0.65, coreColor: '#e9d5ff', glowColor: '#9333ea' }, // Right valley
      { x: 1410, y: 325, size: 10, opacity: 0.6, coreColor: '#e9d5ff', glowColor: '#a855f7' }, // Far right
      { x: 590, y: 255, size: 8, opacity: 0.6, coreColor: '#ffffff', glowColor: '#c084fc' },
      { x: 785, y: 415, size: 7, opacity: 0.55, coreColor: '#e9d5ff', glowColor: '#a855f7' },
      { x: 948, y: 395, size: 8, opacity: 0.6, coreColor: '#e9d5ff', glowColor: '#9333ea' },
    ];

    return {
      longitudinalPaths: longPaths,
      transversePaths: transPaths,
      crestSpinePath: crestSpineD,
      crestApexPath: crestApexD,
      particleDots: dots,
      sparkleStars: stars,
    };
  }, [VIEW_WIDTH]);

  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden select-none ${className}`}
      aria-hidden="true"
    >
      {/* Background deep obsidian base with rich purple radial illumination */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 75% 55% at 55% 32%, rgba(147, 51, 234, 0.22) 0%, rgba(109, 40, 217, 0.10) 45%, transparent 80%)',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle 320px at 55% 26%, rgba(192, 132, 252, 0.16) 0%, transparent 70%)',
        }}
      />

      <svg
        className="absolute inset-0 h-full w-full object-cover"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Intense SVG glow filters for laser crest beam and stars */}
          <filter id="laserOuterGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5.0" result="blurOuter" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="blurInner" />
            <feMerge>
              <feMergeNode in="blurOuter" />
              <feMergeNode in="blurInner" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="laserApexBloom" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blurWide" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blurMid" />
            <feMerge>
              <feMergeNode in="blurWide" />
              <feMergeNode in="blurMid" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="starGlintBloom" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Color Gradients */}
          {/* 1. Ambient longitudinal contour gradient */}
          <linearGradient id="meshAmbientGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#4338ca" stopOpacity="0.10" />
            <stop offset="18%" stopColor="#6366f1" stopOpacity="0.28" />
            <stop offset="45%" stopColor="#8b5cf6" stopOpacity="0.52" />
            <stop offset="55%" stopColor="#a855f7" stopOpacity="0.72" />
            <stop offset="76%" stopColor="#7c3aed" stopOpacity="0.48" />
            <stop offset="100%" stopColor="#4338ca" stopOpacity="0.10" />
          </linearGradient>

          {/* 2. Core mesh longitudinal gradient */}
          <linearGradient id="meshCoreGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#4f46e5" stopOpacity="0.16" />
            <stop offset="20%" stopColor="#7c3aed" stopOpacity="0.52" />
            <stop offset="46%" stopColor="#a855f7" stopOpacity="0.82" />
            <stop offset="55%" stopColor="#c084fc" stopOpacity="0.95" />
            <stop offset="72%" stopColor="#9333ea" stopOpacity="0.78" />
            <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.18" />
          </linearGradient>

          {/* 3. Crest spine high-luminance gradient */}
          <linearGradient id="crestSpineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.15" />
            <stop offset="22%" stopColor="#9333ea" stopOpacity="0.7" />
            <stop offset="44%" stopColor="#d8b4fe" stopOpacity="1" />
            <stop offset="54%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="65%" stopColor="#e9d5ff" stopOpacity="1" />
            <stop offset="86%" stopColor="#a855f7" stopOpacity="0.65" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0.15" />
          </linearGradient>

          {/* 4. Transverse cross-rib gradient */}
          <linearGradient id="transverseGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#f3e8ff" stopOpacity="0.9" />
            <stop offset="30%" stopColor="#c084fc" stopOpacity="0.65" />
            <stop offset="65%" stopColor="#7c3aed" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#4338ca" stopOpacity="0.05" />
          </linearGradient>
        </defs>

        {/* Layer 1: Longitudinal contour curves */}
        {longitudinalPaths.map((p, idx) => (
          <path
            key={`long-${idx}`}
            d={p.d}
            stroke={p.stroke}
            strokeWidth={p.strokeWidth}
            strokeOpacity={p.opacity}
            strokeDasharray={p.dashArray}
            strokeLinecap="round"
            fill="none"
          />
        ))}

        {/* Layer 2: Transverse cross-rib particle lattice lines */}
        {transversePaths.map((p, idx) => (
          <path
            key={`trans-${idx}`}
            d={p.d}
            stroke={p.stroke}
            strokeWidth={p.strokeWidth}
            strokeOpacity={p.opacity}
            strokeDasharray={p.dashArray}
            strokeLinecap="round"
            fill="none"
          />
        ))}

        {/* Layer 3: Grid intersection luminous particle dots */}
        {particleDots.map((n, idx) => (
          <circle
            key={`dot-${idx}`}
            cx={n.x.toFixed(1)}
            cy={n.y.toFixed(1)}
            r={n.r}
            fill={n.fill}
            fillOpacity={n.opacity}
          />
        ))}

        {/* Layer 4: Radiant Neon Laser Crest Spine */}
        {/* Soft wide neon aura */}
        <path
          d={crestSpinePath}
          stroke="#9333ea"
          strokeWidth="11"
          strokeOpacity="0.38"
          strokeLinecap="round"
          filter="url(#laserOuterGlow)"
          fill="none"
        />
        {/* Vibrant violet halo */}
        <path
          d={crestSpinePath}
          stroke="#c084fc"
          strokeWidth="4.5"
          strokeOpacity="0.75"
          strokeLinecap="round"
          filter="url(#laserOuterGlow)"
          fill="none"
        />
        {/* Sharp radiant crest beam */}
        <path
          d={crestSpinePath}
          stroke="url(#crestSpineGrad)"
          strokeWidth="1.9"
          strokeLinecap="round"
          fill="none"
        />
        {/* Super-bright white laser core on apex */}
        <path
          d={crestApexPath}
          stroke="#ffffff"
          strokeWidth="1.6"
          strokeOpacity="0.95"
          strokeLinecap="round"
          filter="url(#laserApexBloom)"
          fill="none"
        />

        {/* Layer 5: Sparkling Star Glints */}
        {sparkleStars.map((star, idx) => (
          <g
            key={`star-${idx}`}
            transform={`translate(${star.x}, ${star.y})`}
            opacity={star.opacity}
            filter="url(#starGlintBloom)"
          >
            {/* Soft radial halo */}
            <circle cx="0" cy="0" r={star.size * 0.38} fill={star.glowColor} fillOpacity="0.35" />
            {/* 4-point Diamond Star Flare */}
            <path
              d={`M 0,-${star.size * 0.55} Q 0,0 ${star.size * 0.55},0 Q 0,0 0,${star.size * 0.55} Q 0,0 -${star.size * 0.55},0 Q 0,0 0,-${star.size * 0.55} Z`}
              fill={star.coreColor}
            />
            {/* Pinpoint spark center */}
            <circle cx="0" cy="0" r={star.size * 0.12} fill="#ffffff" />
          </g>
        ))}
      </svg>
    </div>
  );
};


