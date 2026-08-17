// LIVE-CHAT WEBSOCKET CAPACITY — how many concurrent live-chat sockets can one
// box actually hold, and does message delivery stay timely as they pile up?
//
// This measures a DIFFERENT ceiling from every other scenario here. Bot chat is
// SSE (`/chat/stream`); a WebSocket is only opened once a visitor is escalated
// to a human operator (widget/src/components/LiveChatMode.jsx). So concurrent WS
// = escalated conversations + connected operators, not one-per-visitor.
//
// ⚠️ WHY WORKER COUNT DOES NOT HELP THIS NUMBER
// `manager = ConnectionManager()` (app/services/live_chat_service.py) keeps the
// sockets in in-process dicts, so `gunicorn.conf.py` pins WEB_CONCURRENCY=1. With
// >1 worker a visitor and their operator can land on different processes and stop
// seeing each other — the connections still open, they just silently stop talking.
// Therefore this is a SINGLE-PROCESS ceiling regardless of WEB_CONCURRENCY, and
// running it multi-worker measures the bug, not the capacity (see MODE below).
//
// Each VU opens one visitor socket against its own pre-seeded warm session, holds
// it, and sends a periodic ping so the connection is doing real work rather than
// merely existing. We record: how many sockets actually opened, how many survived
// the hold, and the ping→pong round-trip latency as the count climbs.
//
//   CONNS=200 HOLD=45s k6 run load-tests/scenarios/livechat-ws.js
import ws from 'k6/ws';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { env } from '../config/environments.js';
import { requireBotKey } from '../helpers/auth.js';

const CONNS = parseInt(__ENV.CONNS || '100', 10);
const HOLD_S = parseInt((__ENV.HOLD || '45s').replace('s', ''), 10);
// Must be <= the number of warm sessions seeded (datasets/seed_fixtures.py --warm).
const WARM = parseInt(__ENV.WARM || '500', 10);
const PING_EVERY_S = parseInt(__ENV.PING_EVERY_S || '10', 10);

const wsConnected = new Rate('ws_connect_success');
const wsRoundTrip = new Trend('ws_round_trip_ms', true);
const wsOpened = new Counter('ws_opened');
const wsErrors = new Counter('ws_errors');
const wsClosedEarly = new Counter('ws_closed_early');

export const options = {
  scenarios: {
    sockets: {
      executor: 'per-vu-iterations',
      vus: CONNS,
      iterations: 1,
      // Each VU holds one socket for HOLD, so the whole run is ~HOLD long.
      maxDuration: `${HOLD_S + 60}s`,
    },
  },
  thresholds: {
    // A socket that cannot be established is the failure we care about most.
    ws_connect_success: ['rate>0.99'],
    // Delivery must stay timely while the connection count climbs.
    ws_round_trip_ms: ['p(95)<1000'],
  },
};

export function setup() {
  requireBotKey();
  env.assertSafe({ llm: false }); // sockets alone drive no LLM traffic
  return { conns: CONNS };
}

export default function () {
  const sessionId = `session_warm_${(__VU - 1) % WARM}`;
  const base = env.BASE_URL.replace(/^http/, 'ws');
  const url = `${base}/ws/chat/${sessionId}`;

  // k6 can set real headers, so use X-Bot-Key rather than the browser-only
  // subprotocol fallback. Unique X-Forwarded-For per VU mirrors distinct
  // visitors so per-IP limits model reality instead of throttling the run.
  //
  // Origin is REQUIRED, not optional decoration: when the bot has
  // ``domain_check_enabled`` the WS handler runs the same origin whitelist as
  // the HTTP path, and ``is_origin_allowed`` rejects a missing hostname
  // outright (4403). A real widget always sends one because the browser does.
  // ``localhost`` is auto-allowed outside production (app/core/origin_check.py),
  // which is why the default works against a local/staging target; override
  // with WS_ORIGIN to match a bot that has an explicit allowed_domains list.
  const params = {
    headers: {
      'X-Bot-Key': env.BOT_KEY,
      'X-Forwarded-For': `10.${Math.floor(__VU / 254) % 254}.${__VU % 254}.11`,
      Origin: __ENV.WS_ORIGIN || 'http://localhost',
    },
  };

  const res = ws.connect(url, params, (socket) => {
    let opened = false;
    let pendingSince = 0;

    socket.on('open', () => {
      opened = true;
      wsOpened.add(1);
      wsConnected.add(true);

      // Periodic application-level ping so the socket is exercised, not idle.
      socket.setInterval(() => {
        pendingSince = Date.now();
        try {
          socket.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {
          wsErrors.add(1);
        }
      }, PING_EVERY_S * 1000);

      socket.setTimeout(() => socket.close(), HOLD_S * 1000);
    });

    // Any frame back from the server closes the round-trip we are timing.
    socket.on('message', () => {
      if (pendingSince) {
        wsRoundTrip.add(Date.now() - pendingSince);
        pendingSince = 0;
      }
    });

    socket.on('error', (e) => {
      // k6 reports a normal close as an error on some paths; ignore those.
      if (e && e.error && !String(e.error).includes('close')) wsErrors.add(1);
    });

    socket.on('close', () => {
      if (!opened) wsConnected.add(false);
    });
  });

  // 101 Switching Protocols is the success code for a WebSocket upgrade.
  const upgraded = check(res, { 'ws upgrade 101': (r) => r && r.status === 101 });
  if (!upgraded) {
    wsConnected.add(false);
    wsClosedEarly.add(1);
  }
}
