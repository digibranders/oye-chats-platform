/**
 * OyeChats premium orb. Shared WebGL renderer.
 *
 * Architecture: ONE WebGL context, ONE compiled shader program, N registered
 * orbs. Each orb owns a small visible <canvas> in the DOM. Every animation
 * frame the renderer walks the visible orb set, renders each one into a
 * viewport-sized region of the shared offscreen canvas, then copies the
 * result into that orb's destination <canvas> via `drawImage`.
 *
 * This avoids the ~16-context-per-page WebGL cap you hit if you give every
 * chat avatar its own context. The shader is compiled exactly once for the
 * whole app.
 *
 * The pipeline (fragment shader):
 *   SDF → circular mask → curl-warped fBm density → gradient-normal →
 *   subsurface lighting (wrap-diffuse + emissive) → Fresnel rim →
 *   selective bloom → color mapping (deep↔light lerp) → gamma.
 *
 * The only creative input is `color` per orb. `uTime` drives every clock:
 * core drift 12 s, energy 18 s, glow 6 s, shadow 14 s. All coprime, so
 * nothing ever visibly loops.
 */

const VERTEX_SRC = `
attribute vec2 aPos;
void main() {
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `
precision mediump float;

uniform vec3  orbColor;
uniform float uTime;
uniform vec2  uSize;

const float TAU = 6.28318530718;

// Ashima 2D simplex noise (Ian McEwan / Ashima Arts, MIT).
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                         + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x  = 2.0 * fract(p * C.www) - 1.0;
    vec3 h  = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}

// 3-octave fractal Brownian motion.
float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.55;
    float freq = 1.0;
    for (int i = 0; i < 3; i++) {
        sum += amp * snoise(p * freq);
        freq *= 2.13;
        amp  *= 0.5;
    }
    return sum;
}

// Radial gradient primitive. Smooth falloff from 1 at center to 0 at
// radius R. Returns a pure smooth function of distance; no noise inside.
float radial(vec2 p, vec2 c, float r) {
    return 1.0 - smoothstep(0.0, r, length(p - c));
}

void main() {
    // uv in [0, 1], y flipped for Canvas2D compositing
    vec2 uv = gl_FragCoord.xy / uSize;
    uv.y = 1.0 - uv.y;
    vec2 p = uv * 2.0 - 1.0;

    // Two masks: a hard-ish sphere edge and a soft halo that lets bloom
    // bleed beyond the silhouette without smearing the base color.
    float d = length(p);
    float hardCore = 1.0 - smoothstep(0.985, 1.005, d);
    float softHalo = 1.0 - smoothstep(1.0, 1.15, d);
    if (softHalo < 0.001) discard;

    // Core drift, the two bright centers slowly orbit ~2px each,
    // 12s period. Nothing else in the shader moves in position.
    float driftPx = 2.0 / uSize.x;
    vec2 drift = vec2(sin(uTime * TAU / 12.0), cos(uTime * TAU / 12.0)) * driftPx;

    // UV domain warp. TWO independent low-frequency fBm samples give a
    // 2D displacement. Amplitude ~0.03. Small enough that gradients
    // still look like gradients, large enough that they slowly flow.
    // The noise itself never contributes to color: it only moves p.
    float warpBreath = 0.85 + 0.15 * sin(uTime * TAU / 18.0);
    vec2 warp = vec2(
        fbm(p * 1.6 + vec2(uTime * 0.05, 0.0)),
        fbm(p * 1.6 + vec2(0.0, uTime * 0.05) + vec2(5.2, 1.3))
    );
    vec2 pw = p + warp * 0.03 * warpBreath;

    // Fixed gradient centers. Deliberate yin-yang composition.
    // c1 upper-left, c2 lower-right form the S; c3 is a wide atmospheric
    // fill that ties them together and softens the void between.
    vec2 c1 = vec2(-0.35, -0.30) + drift;
    vec2 c2 = vec2( 0.35,  0.30) - drift;
    vec2 c3 = vec2( 0.00,  0.00);

    // Three soft radials at WARPED coordinates. Each is a pure smooth
    // function, no noise texture ever visible.
    float g1 = radial(pw, c1, 1.05);
    float g2 = radial(pw, c2, 1.05);
    float g3 = radial(pw, c3, 1.30);

    // Shadow breathing (~14s) modulates the atmospheric fill so the
    // darker regions gently pulse without ever becoming black.
    float shadowBreath = 0.85 + 0.15 * sin(uTime * TAU / 14.0);

    // Additive blend
    float density = g1 * 0.58 + g2 * 0.58 + g3 * 0.22 * shadowBreath;
    density = clamp(density, 0.0, 1.0);

    // Radial falloff. Keeps the light away from the rim, which is
    // what produces the dark ring the reference has just inside the
    // silhouette.
    float radialFalloff = 1.0 - smoothstep(0.55, 1.0, d);
    density *= radialFalloff;

    // Glow breathing (~6s)
    density *= 0.92 + 0.08 * sin(uTime * TAU / 6.0);

    // Color mapping, one hue lerped from deep to light by density.
    vec3 deep  = mix(orbColor, vec3(0.0), 0.86);
    vec3 light = mix(orbColor, vec3(1.0), 0.40);
    vec3 base  = mix(deep, light, clamp(density, 0.0, 1.0));

    // Fresnel rim - ~10% intensity, gently responds to interior light.
    float fres = pow(smoothstep(0.72, 1.0, d), 2.8);
    vec3 rim = vec3(fres * 0.10 * (0.6 + 0.4 * density));

    // Selective bloom. Only the brightest ~15% contributes, bleeds
    // outside the shell via softHalo so the outer glow tracks the
    // internal energy instead of being a symmetric circle.
    float bloomMask = pow(smoothstep(0.55, 0.95, density), 2.2);
    vec3 bloom = bloomMask * orbColor * 0.35 * softHalo;

    // Compose. Base + rim bounded to the sphere; bloom extends into halo.
    vec3 color = base * hardCore + rim * hardCore + bloom;

    // Alpha: sphere itself + bloom-carried halo beyond the rim.
    float alpha = max(hardCore, bloomMask * softHalo * 0.55);

    // Premultiplied for compositing into the destination canvas.
    gl_FragColor = vec4(color * alpha, alpha);
}
`;

const MAX_SIZE = 512;

class OrbRenderer {
    constructor() {
        this.available = false;
        this.orbs = new Set();
        this.raf = 0;
        this.reduced = false;

        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        this.canvas = document.createElement('canvas');
        this.canvas.width = MAX_SIZE;
        this.canvas.height = MAX_SIZE;

        const gl = this.canvas.getContext('webgl', {
            premultipliedAlpha: true,
            antialias: false,
            preserveDrawingBuffer: false,
        });
        if (!gl) return;
        this.gl = gl;

        try {
            this._compile();
            this.available = true;
        } catch {
            // Shader compile / link failure. Leave `available` false; the
            // React component will fall back to a static CSS gradient.
            return;
        }

        this.startTime = performance.now();

        // Respect prefers-reduced-motion. Render exactly one frame per
        // property change instead of animating.
        if (typeof matchMedia !== 'undefined') {
            const mq = matchMedia('(prefers-reduced-motion: reduce)');
            this.reduced = !!mq.matches;
            const onChange = (e) => {
                this.reduced = !!e.matches;
                if (!this.reduced) this._ensureLoop();
                else this._renderOnce();
            };
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        }

        // Handle context loss (browser reclaims GPU under pressure).
        this.canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            this.available = false;
        }, false);
        this.canvas.addEventListener('webglcontextrestored', () => {
            try {
                this._compile();
                this.available = true;
                this._ensureLoop();
            } catch { /* keep unavailable */ }
        }, false);
    }

    _compile() {
        const gl = this.gl;
        const mk = (src, type) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(s);
                gl.deleteShader(s);
                throw new Error('shader: ' + log);
            }
            return s;
        };
        const v = mk(VERTEX_SRC, gl.VERTEX_SHADER);
        const f = mk(FRAGMENT_SRC, gl.FRAGMENT_SHADER);
        const p = gl.createProgram();
        gl.attachShader(p, v);
        gl.attachShader(p, f);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(p);
            gl.deleteProgram(p);
            throw new Error('program: ' + log);
        }
        this.program = p;
        this.locs = {
            orbColor: gl.getUniformLocation(p, 'orbColor'),
            uTime:    gl.getUniformLocation(p, 'uTime'),
            uSize:    gl.getUniformLocation(p, 'uSize'),
            aPos:     gl.getAttribLocation(p, 'aPos'),
        };
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
            gl.STATIC_DRAW,
        );
        gl.useProgram(p);
        gl.enableVertexAttribArray(this.locs.aPos);
        gl.vertexAttribPointer(this.locs.aPos, 2, gl.FLOAT, false, 0, 0);
        // Straight alpha out; we premultiply manually in the shader.
        gl.disable(gl.BLEND);
    }

    register(orb) {
        if (!this.available) return false;
        this.orbs.add(orb);
        if (this.reduced) this._renderOne(orb, 0);
        else this._ensureLoop();
        return true;
    }

    unregister(orb) {
        this.orbs.delete(orb);
        if (!this.orbs.size && this.raf) {
            cancelAnimationFrame(this.raf);
            this.raf = 0;
        }
    }

    /** Force a single re-render (e.g. after color/size change while paused). */
    poke(orb) {
        if (this.reduced) this._renderOne(orb, 0);
    }

    _renderOnce() {
        const t = (performance.now() - this.startTime) / 1000;
        for (const orb of this.orbs) this._renderOne(orb, t);
    }

    _renderOne(orb, t) {
        if (!orb.visible || !orb.destCtx || orb.pxSize <= 0) return;
        const gl = this.gl;
        gl.viewport(0, 0, orb.pxSize, orb.pxSize);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform3fv(this.locs.orbColor, orb.color);
        gl.uniform1f(this.locs.uTime, t);
        gl.uniform2f(this.locs.uSize, orb.pxSize, orb.pxSize);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // WebGL rendered into region [0..pxSize, 0..pxSize] with origin
        // at bottom-left. Canvas 2D origin is top-left, so we source from
        // (0, MAX_SIZE - pxSize).
        const dest = orb.destCanvas;
        orb.destCtx.clearRect(0, 0, dest.width, dest.height);
        orb.destCtx.drawImage(
            this.canvas,
            0, MAX_SIZE - orb.pxSize, orb.pxSize, orb.pxSize,
            0, 0, dest.width, dest.height,
        );
    }

    _ensureLoop() {
        if (this.raf || !this.orbs.size || this.reduced) return;
        const tick = () => {
            const t = (performance.now() - this.startTime) / 1000;
            for (const orb of this.orbs) this._renderOne(orb, t);
            this.raf = this.orbs.size ? requestAnimationFrame(tick) : 0;
        };
        this.raf = requestAnimationFrame(tick);
    }
}

const orbRenderer = new OrbRenderer();
export default orbRenderer;
