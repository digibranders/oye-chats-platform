/**
 * OyeChats premium orb - shared WebGL renderer (admin app mirror).
 * See platform/widget/src/services/orbRenderer.js for full architecture notes.
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

float radial(vec2 p, vec2 c, float r) {
    return 1.0 - smoothstep(0.0, r, length(p - c));
}

void main() {
    vec2 uv = gl_FragCoord.xy / uSize;
    uv.y = 1.0 - uv.y;
    vec2 p = uv * 2.0 - 1.0;

    float d = length(p);
    float hardCore = 1.0 - smoothstep(0.985, 1.005, d);
    float softHalo = 1.0 - smoothstep(1.0, 1.15, d);
    if (softHalo < 0.001) discard;

    float driftPx = 2.0 / uSize.x;
    vec2 drift = vec2(sin(uTime * TAU / 12.0), cos(uTime * TAU / 12.0)) * driftPx;

    float warpBreath = 0.85 + 0.15 * sin(uTime * TAU / 18.0);
    vec2 warp = vec2(
        fbm(p * 1.6 + vec2(uTime * 0.05, 0.0)),
        fbm(p * 1.6 + vec2(0.0, uTime * 0.05) + vec2(5.2, 1.3))
    );
    vec2 pw = p + warp * 0.03 * warpBreath;

    vec2 c1 = vec2(-0.35, -0.30) + drift;
    vec2 c2 = vec2( 0.35,  0.30) - drift;
    vec2 c3 = vec2( 0.00,  0.00);

    float g1 = radial(pw, c1, 1.05);
    float g2 = radial(pw, c2, 1.05);
    float g3 = radial(pw, c3, 1.30);

    float shadowBreath = 0.85 + 0.15 * sin(uTime * TAU / 14.0);

    float density = g1 * 0.58 + g2 * 0.58 + g3 * 0.22 * shadowBreath;
    density = clamp(density, 0.0, 1.0);

    float radialFalloff = 1.0 - smoothstep(0.55, 1.0, d);
    density *= radialFalloff;

    density *= 0.92 + 0.08 * sin(uTime * TAU / 6.0);

    vec3 deep  = mix(orbColor, vec3(0.0), 0.86);
    vec3 light = mix(orbColor, vec3(1.0), 0.40);
    vec3 base  = mix(deep, light, clamp(density, 0.0, 1.0));

    float fres = pow(smoothstep(0.72, 1.0, d), 2.8);
    vec3 rim = vec3(fres * 0.10 * (0.6 + 0.4 * density));

    float bloomMask = pow(smoothstep(0.55, 0.95, density), 2.2);
    vec3 bloom = bloomMask * orbColor * 0.35 * softHalo;

    vec3 color = base * hardCore + rim * hardCore + bloom;
    float alpha = max(hardCore, bloomMask * softHalo * 0.55);

    gl_FragColor = vec4(color * alpha, alpha);
}
`;

const MAX_SIZE = 512;

/**
 * One registered orb instance: a destination canvas the shared WebGL surface
 * is blitted into, plus the state the render loop reads each frame.
 *
 * `destCtx` is nullable because `getContext('2d')` can return null (a browser
 * refusing the surface under memory pressure); `_renderOne` skips those.
 */
export interface Orb {
    destCanvas: HTMLCanvasElement;
    destCtx: CanvasRenderingContext2D | null;
    /** Normalised RGB, three floats in 0..1. */
    color: Float32Array;
    /** Device-pixel edge length; also the WebGL viewport size. */
    pxSize: number;
    visible: boolean;
}

interface ProgramLocations {
    orbColor: WebGLUniformLocation | null;
    uTime: WebGLUniformLocation | null;
    uSize: WebGLUniformLocation | null;
    aPos: GLint;
}

class OrbRenderer {
    /** False when WebGL is unavailable or the context was lost. Consumers
     *  branch on this to render a CSS fallback instead. */
    available = false;

    private orbs = new Set<Orb>();
    private raf = 0;
    private reduced = false;
    private startTime = 0;

    // Left optional rather than definitely-assigned: the constructor returns
    // early on a server render or a refused context, and every consumer of
    // these already gates on `available`.
    private canvas?: HTMLCanvasElement;
    private gl?: WebGLRenderingContext;
    private locs?: ProgramLocations;

    constructor() {
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
            return;
        }

        this.startTime = performance.now();

        if (typeof matchMedia !== 'undefined') {
            const mq = matchMedia('(prefers-reduced-motion: reduce)');
            this.reduced = !!mq.matches;
            const onChange = (e: MediaQueryListEvent) => {
                this.reduced = !!e.matches;
                if (!this.reduced) this._ensureLoop();
                else this._renderOnce();
            };
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        }

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

    private _compile(): void {
        const gl = this.gl;
        // Only reachable once the constructor has a context, and on
        // contextrestored where it still holds one. Throwing rather than
        // returning keeps the caller's try/catch as the single failure path,
        // which leaves `available` false exactly as before.
        if (!gl) throw new Error('orbRenderer: no WebGL context');

        const mk = (src: string, type: GLenum): WebGLShader => {
            const s = gl.createShader(type);
            if (!s) throw new Error('shader: allocation failed');
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
        if (!p) throw new Error('program: allocation failed');
        gl.attachShader(p, v);
        gl.attachShader(p, f);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(p);
            gl.deleteProgram(p);
            throw new Error('program: ' + log);
        }
        // The linked program is bound immediately below via useProgram and
        // never referenced again, so it is not retained as state.
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
        gl.disable(gl.BLEND);
    }

    register(orb: Orb): boolean {
        if (!this.available) return false;
        this.orbs.add(orb);
        if (this.reduced) this._renderOne(orb, 0);
        else this._ensureLoop();
        return true;
    }

    unregister(orb: Orb): void {
        this.orbs.delete(orb);
        if (!this.orbs.size && this.raf) {
            cancelAnimationFrame(this.raf);
            this.raf = 0;
        }
    }

    poke(orb: Orb): void {
        if (this.reduced) this._renderOne(orb, 0);
    }

    private _renderOnce(): void {
        const t = (performance.now() - this.startTime) / 1000;
        for (const orb of this.orbs) this._renderOne(orb, t);
    }

    private _renderOne(orb: Orb, t: number): void {
        if (!orb.visible || !orb.destCtx || orb.pxSize <= 0) return;
        const gl = this.gl;
        // Same shape as the guard above: a renderer without a live context or
        // a linked program has nothing to draw, and every caller already
        // tolerates a skipped frame.
        if (!gl || !this.locs || !this.canvas) return;
        gl.viewport(0, 0, orb.pxSize, orb.pxSize);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform3fv(this.locs.orbColor, orb.color);
        gl.uniform1f(this.locs.uTime, t);
        gl.uniform2f(this.locs.uSize, orb.pxSize, orb.pxSize);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        const dest = orb.destCanvas;
        orb.destCtx.clearRect(0, 0, dest.width, dest.height);
        orb.destCtx.drawImage(
            this.canvas,
            0, MAX_SIZE - orb.pxSize, orb.pxSize, orb.pxSize,
            0, 0, dest.width, dest.height,
        );
    }

    private _ensureLoop(): void {
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
