// MIXED REALISTIC LOAD — every surface at once, which is the only shape that
// resembles a real production minute.
//
// Every other scenario here isolates ONE surface, which is right for finding a
// single ceiling but wrong for capacity planning: in production the expensive
// RAG path, the bcrypt-bound auth path, the analytics fan-out, and held
// WebSockets all compete for the same 2 vCPUs, the same event loop, and the same
// DB pool — while the ARQ worker runs crons every 30 seconds beside them. This
// scenario runs them concurrently as independent k6 scenarios in ONE process so
// each surface's latency is attributed separately and we can see WHICH one
// degrades first.
//
// TRAFFIC MODEL (each knob independently scalable; defaults derived from this
// repo's own audit — a growing SaaS at hundreds of bots, low steady traffic):
//   VISITORS       widget visitors with think time; 10% of them are mid-chat
//                  (the AI share was raised from the 5% in active-users.js on
//                  request — 10% is the pessimistic-but-plausible figure)
//   ADMINS         signed-in dashboard tabs polling every ~15s
//   ANALYTICS_TABS heavier analytics readers (leads + subscription + crawl)
//   LOGIN_RPS      steady login arrivals (bcrypt cost 12 — CPU, not I/O)
//   REGISTER_RPM   registrations per minute (rare, also bcrypt)
//   WS_CONNS       escalated live-chat sockets held open for the whole run
//
// Scale the whole mix with SCALE (multiplies every knob), or set knobs directly.
//
//   SCALE=1 HOLD=60s k6 run load-tests/scenarios/mixed-realistic.js
//   VISITORS=2000 ADMINS=40 WS_CONNS=500 LOGIN_RPS=3 k6 run ...
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { env } from '../config/environments.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, adminHeaders, url } from '../helpers/http.js';
import { chatTTFB, chatTotal } from '../helpers/metrics.js';
import { pickQuestion } from '../helpers/data.js';

const SCALE = parseFloat(__ENV.SCALE || '1');
const n = (name, dflt) => Math.max(0, Math.round(parseFloat(__ENV[name] || String(dflt)) * SCALE));

const VISITORS = n('VISITORS', 500);
const ADMINS = n('ADMINS', 20);
const ANALYTICS_TABS = n('ANALYTICS_TABS', 5);
const WS_CONNS = n('WS_CONNS', 100);
const LOGIN_RPS = n('LOGIN_RPS', 2);
const REGISTER_RPM = n('REGISTER_RPM', 2);

const HOLD = __ENV.HOLD || '60s';
const HOLD_S = parseInt(HOLD.replace('s', ''), 10);
const WARM = parseInt(__ENV.WARM || '500', 10);
const PCT_AI = parseInt(__ENV.PCT_AI || '10', 10); // share of VISITORS that chat

const EMAIL = __ENV.CLIENT_EMAIL || 'loadtest@example.invalid';
const PASSWORD = __ENV.CLIENT_PASSWORD || 'LoadTest!Deterministic1';
const RUN_TAG = __ENV.RUN_TAG || `${Date.now()}`;

// Per-surface metrics so we can see which surface breaks first.
const adminMs = new Trend('mix_admin_ms', true);
const analyticsMs = new Trend('mix_analytics_ms', true);
const loginMs = new Trend('mix_login_ms', true);
const registerMs = new Trend('mix_register_ms', true);
const widgetMs = new Trend('mix_widget_cfg_ms', true);
const wsRtt = new Trend('mix_ws_rtt_ms', true);
const wsUp = new Rate('mix_ws_connect_success');
const rateLimited = new Counter('mix_rate_limited_429');
const surfaceErrors = new Counter('mix_surface_errors');

function xff(offset) {
  // Unique-ish client IP per VU per surface so per-IP limiters model distinct
  // users instead of throttling the whole run.
  const v = __VU + offset;
  return `10.${Math.floor(v / 254) % 254}.${v % 254}.${(v % 250) + 1}`;
}

export const options = {
  scenarios: {
    // ── Widget visitors: mostly idle, PCT_AI% mid-chat ──────────────────────
    visitors: {
      executor: 'ramping-vus',
      startVUs: Math.min(50, VISITORS),
      stages: [
        { duration: '20s', target: VISITORS },
        { duration: HOLD, target: VISITORS },
        { duration: '10s', target: 0 },
      ],
      exec: 'visitor',
      gracefulStop: '20s',
    },
    // ── Signed-in admin dashboard tabs ──────────────────────────────────────
    admins: {
      executor: 'constant-vus',
      vus: Math.max(1, ADMINS),
      duration: `${HOLD_S + 20}s`,
      exec: 'admin',
      gracefulStop: '15s',
    },
    // ── Heavier analytics readers ───────────────────────────────────────────
    analytics: {
      executor: 'constant-vus',
      vus: Math.max(1, ANALYTICS_TABS),
      duration: `${HOLD_S + 20}s`,
      exec: 'analytics',
      gracefulStop: '15s',
    },
    // ── Login arrivals (bcrypt-bound, so this is CPU pressure) ──────────────
    logins: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, LOGIN_RPS),
      timeUnit: '1s',
      duration: `${HOLD_S + 20}s`,
      preAllocatedVUs: Math.max(2, LOGIN_RPS * 3),
      maxVUs: Math.max(10, LOGIN_RPS * 10),
      exec: 'login',
    },
    // ── Registrations (rarer, also bcrypt) ──────────────────────────────────
    registrations: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, REGISTER_RPM),
      timeUnit: '1m',
      duration: `${HOLD_S + 20}s`,
      preAllocatedVUs: 2,
      maxVUs: 10,
      exec: 'register',
    },
    // ── Escalated live-chat WebSockets, held for the whole run ──────────────
    livechat: {
      executor: 'per-vu-iterations',
      vus: Math.max(1, WS_CONNS),
      iterations: 1,
      maxDuration: `${HOLD_S + 60}s`,
      exec: 'livechatSocket',
    },
  },
  // Intentionally no hard thresholds: this scenario is meant to be pushed until
  // something breaks, and the per-surface trends above are the output. Set
  // thresholds in the runner if you want a pass/fail gate for a specific mix.
};

export function setup() {
  env.assertSafe({ llm: true }); // the visitor share drives real RAG traffic
  return {
    visitors: VISITORS, admins: ADMINS, analytics: ANALYTICS_TABS,
    ws: WS_CONNS, loginRps: LOGIN_RPS, registerRpm: REGISTER_RPM,
  };
}

// ── Widget visitor: PCT_AI% send a chat message, the rest just browse ────────
export function visitor() {
  const isChatter = (__VU % 100) < PCT_AI;
  const bh = botHeaders({ tags: { kind: 'api', surface: 'widget' } });
  bh.headers['X-Forwarded-For'] = xff(0);

  if (isChatter) {
    group('ai-chat', () => {
      const sid = `session_warm_${__VU % WARM}`;
      const p = botHeaders({ tags: { kind: 'chat', surface: 'chat' }, timeout: '120s' });
      p.headers['X-Forwarded-For'] = xff(0);
      const res = http.post(url('/chat/stream'), JSON.stringify({ question: pickQuestion(), session_id: sid }), p);
      ok(res, 'chat/stream');
      if (res.status !== 200) surfaceErrors.add(1);
      chatTTFB.add(res.timings.waiting);
      chatTotal.add(res.timings.duration);
    });
    sleep(Math.random() * 15 + 10); // read the answer before asking again
  } else {
    const res = http.get(url('/bots/settings/public'), bh);
    ok(res, 'widget-config');
    widgetMs.add(res.timings.duration);
    if (res.status !== 200) surfaceErrors.add(1);
    sleep(Math.random() * 25 + 15); // browsing
  }
}

// ── Signed-in admin: the light polling an open dashboard tab does ────────────
export function admin() {
  const ah = adminHeaders({ tags: { kind: 'api', surface: 'admin' } });
  ah.headers['X-Forwarded-For'] = xff(1000);
  const res = http.get(url('/subscriptions/current'), ah);
  ok(res, 'subscriptions/current');
  adminMs.add(res.timings.duration);
  if (res.status !== 200) surfaceErrors.add(1);
  const res2 = http.get(url('/crawl/progress'), ah);
  ok(res2, 'crawl/progress');
  adminMs.add(res2.timings.duration);
  sleep(15); // dashboard poll cadence
}

// ── Heavier analytics reader ─────────────────────────────────────────────────
export function analytics() {
  const ah = adminHeaders({ tags: { kind: 'analytics', surface: 'analytics' } });
  ah.headers['X-Forwarded-For'] = xff(2000);
  const res = http.get(url('/leads?limit=200'), ah);
  ok(res, 'leads');
  analyticsMs.add(res.timings.duration);
  if (res.status !== 200) surfaceErrors.add(1);
  sleep(15);
}

// ── Login arrivals ──────────────────────────────────────────────────────────
export function login() {
  const params = {
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff(3000) },
    tags: { kind: 'api', surface: 'login' },
  };
  const res = http.post(url('/auth/login'), JSON.stringify({ email: EMAIL, password: PASSWORD }), params);
  loginMs.add(res.timings.duration);
  if (res.status === 429) { rateLimited.add(1); return; }
  if (!check(res, { 'login 200': (r) => r.status === 200 })) surfaceErrors.add(1);
}

// ── Registrations ───────────────────────────────────────────────────────────
export function register() {
  const params = {
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff(4000) },
    tags: { kind: 'api', surface: 'register' },
  };
  const body = JSON.stringify({
    name: 'Mixed Signup',
    email: `ltmix-${RUN_TAG}-${__VU}-${__ITER}@example.invalid`,
    password: PASSWORD,
    company_name: 'LoadTest Co',
    billing_country: 'IN',
  });
  const res = http.post(url('/auth/register'), body, params);
  registerMs.add(res.timings.duration);
  if (res.status === 429) { rateLimited.add(1); return; }
  if (!check(res, { 'register 2xx': (r) => r.status === 200 || r.status === 201 })) surfaceErrors.add(1);
}

// ── Held live-chat WebSocket ─────────────────────────────────────────────────
export function livechatSocket() {
  const sid = `session_warm_${(__VU - 1) % WARM}`;
  const base = env.BASE_URL.replace(/^http/, 'ws');
  const params = {
    headers: {
      'X-Bot-Key': env.BOT_KEY,
      'X-Forwarded-For': xff(5000),
      // Required: the WS handler runs the same origin whitelist as HTTP and
      // rejects a missing hostname (see livechat-ws.js for the full note).
      Origin: __ENV.WS_ORIGIN || 'http://localhost',
    },
  };
  const res = ws.connect(`${base}/ws/chat/${sid}`, params, (socket) => {
    let pending = 0;
    socket.on('open', () => {
      wsUp.add(true);
      socket.setInterval(() => {
        pending = Date.now();
        try { socket.send(JSON.stringify({ type: 'ping' })); } catch (e) { surfaceErrors.add(1); }
      }, 10000);
      socket.setTimeout(() => socket.close(), HOLD_S * 1000);
    });
    socket.on('message', () => {
      if (pending) { wsRtt.add(Date.now() - pending); pending = 0; }
    });
  });
  if (!res || res.status !== 101) { wsUp.add(false); surfaceErrors.add(1); }
}
