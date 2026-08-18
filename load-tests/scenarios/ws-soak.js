// WEBSOCKET SOAK — sustained socket load for the live-chat process split.
//
// soak.js covers HTTP and chat but opens no WebSocket, so it cannot see the
// failure modes this split actually introduces. Sockets are long-lived and
// their bugs are cumulative: descriptors that are never released, per-connection
// buffers that are never freed, a backplane subscriber that dies quietly after
// N hours, Redis connections that accumulate on every reconnect.
//
// Two populations, because steady state and churn fail differently:
//
//   HOLD    sockets opened once and kept for the whole run. Catches slow growth
//           in memory and descriptors under a stable connection count, and a
//           subscriber that stops delivering partway through.
//   CHURN   sockets that connect, live briefly, disconnect, repeat. Catches
//           leaks in the connect/teardown path, which is where they usually
//           are — a steady-state test holds a descriptor open and never proves
//           it can be given back.
//
// Watch RSS, open descriptors and Redis client count trend over the run rather
// than any single sample; a soak is read as a slope, not a number.
//
//   CONNS=200 CHURN_CONNS=50 DURATION=24h k6 run scenarios/ws-soak.js
import ws from 'k6/ws';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { env } from '../config/environments.js';
import { requireBotKey } from '../helpers/auth.js';

const HOLD_CONNS = parseInt(__ENV.CONNS || '200', 10);
const CHURN_CONNS = parseInt(__ENV.CHURN_CONNS || '50', 10);
const DURATION = __ENV.DURATION || '1h';
const WARM = parseInt(__ENV.WARM || '500', 10);
// How long a churn socket lives before cycling.
const CHURN_LIFETIME_S = parseInt(__ENV.CHURN_LIFETIME_S || '45', 10);
const PING_EVERY_S = parseInt(__ENV.PING_EVERY_S || '20', 10);
const ORIGIN = __ENV.WS_ORIGIN || 'http://localhost';

const rtt = new Trend('soak_ws_rtt_ms', true);
const connected = new Rate('soak_ws_connect_success');
const opened = new Counter('soak_ws_opened');
const errors = new Counter('soak_ws_errors');

export const options = {
  scenarios: {
    hold: {
      executor: 'per-vu-iterations',
      vus: HOLD_CONNS,
      iterations: 1,
      maxDuration: DURATION,
      exec: 'holdSocket',
    },
    churn: {
      executor: 'constant-vus',
      vus: CHURN_CONNS,
      duration: DURATION,
      exec: 'churnSocket',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    // A soak should stay boring. Any sustained failure to connect, or delivery
    // latency drifting into seconds, is the signal.
    soak_ws_connect_success: ['rate>0.99'],
    soak_ws_rtt_ms: ['p(95)<2000'],
  },
};

export function setup() {
  requireBotKey();
  env.assertSafe({ llm: false }); // sockets alone drive no LLM traffic
  return { hold: HOLD_CONNS, churn: CHURN_CONNS };
}

function params(vu) {
  return {
    headers: {
      'X-Bot-Key': env.BOT_KEY,
      // Distinct visitor IPs so per-IP limits model real traffic.
      'X-Forwarded-For': `10.${Math.floor(vu / 254) % 254}.${vu % 254}.31`,
      // Required: the WS handler runs the same origin whitelist as HTTP and
      // rejects a missing hostname outright.
      Origin: ORIGIN,
    },
  };
}

function runSocket(sessionId, lifetimeSeconds, vu) {
  const base = env.BASE_URL.replace(/^http/, 'ws');
  const res = ws.connect(`${base}/ws/chat/${sessionId}`, params(vu), (socket) => {
    let pending = 0;
    socket.on('open', () => {
      opened.add(1);
      connected.add(true);
      socket.setInterval(() => {
        pending = Date.now();
        try {
          socket.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {
          errors.add(1);
        }
      }, PING_EVERY_S * 1000);
      socket.setTimeout(() => socket.close(), lifetimeSeconds * 1000);
    });
    socket.on('message', () => {
      if (pending) {
        rtt.add(Date.now() - pending);
        pending = 0;
      }
    });
  });
  if (!check(res, { 'ws upgrade 101': (r) => r && r.status === 101 })) {
    connected.add(false);
    errors.add(1);
  }
}

// Held for the whole run — steady-state growth.
export function holdSocket() {
  const seconds = Math.max(60, durationSeconds(DURATION));
  runSocket(`session_warm_${(__VU - 1) % WARM}`, seconds, __VU);
}

// Connect / live / disconnect, repeatedly — teardown-path leaks.
export function churnSocket() {
  runSocket(`session_warm_${(__VU + 500) % WARM}`, CHURN_LIFETIME_S, __VU + 5000);
}

function durationSeconds(d) {
  const m = /^(\d+)([smh])$/.exec(d.trim());
  if (!m) return 3600;
  const n = parseInt(m[1], 10);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}
