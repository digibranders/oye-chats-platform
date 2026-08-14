// CHAT CONCURRENCY — THE most important experiment (Phase 7).
//
// Holds a FIXED number of concurrent chat conversations (CONC) against the RAG
// /chat/stream path for DURATION, and measures where latency/errors inflect.
// The runner (runner/run-knee-test.sh) invokes this once per level:
//   1, 5, 10, 15, 20, 30, 50, 100   (and 250/500/1000 for mock-only sweeps)
// writing a separate result file per level, WHILE sampling the server's DB pool,
// CPU and memory (runner/sample-server.sh). Cross-referencing k6 latency with
// pg_stat_activity connection count is how we confirm/deny the ~10-15 pool knee.
//
// MOCK_LLM=true by default -> measures APPLICATION capacity (no provider latency).
// Never mix these numbers with real-LLM numbers (Phase 8A).
//
//   k6 run -e CONC=15 -e DURATION=1m -e MOCK_LLM_VERIFIED=1 \
//          -e BASE_URL=http://127.0.0.1:8001 -e BOT_KEY=... \
//          load-tests/scenarios/chat-concurrency.js
import http from 'k6/http';
import { sleep, group } from 'k6';
import { env } from '../config/environments.js';
import { chatThresholds, merge } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, url } from '../helpers/http.js';
import { requireBotKey } from '../helpers/auth.js';
import { chatTTFB, chatTotal } from '../helpers/metrics.js';
import { sessionId, pickQuestion } from '../helpers/data.js';

const CONC = parseInt(__ENV.CONC || '10', 10);
const DURATION = __ENV.DURATION || '1m';
// Number of pre-seeded warm sessions (see datasets/seed_fixtures.py --warm).
// Each VU drives its OWN warm session so requests run the full RAG/LLM path
// (not the first-turn name-ask short-circuit) and never collide cross-VU.
const WARM = parseInt(__ENV.WARM || '120', 10);
// Optional per-request latency override forwarded to the mock (lets one run
// sweep 500ms/1s/2s/5s/10s generation without restarting the API).
const MOCK_LATENCY_MS = __ENV.MOCK_LATENCY_MS || '';

export const options = {
  scenarios: {
    chat: {
      executor: 'constant-vus',
      vus: CONC,
      duration: DURATION,
      gracefulStop: '30s',
    },
  },
  // Add a per-level tag so results files stay self-describing.
  tags: { conc: String(CONC) },
  thresholds: merge(chatThresholds, {
    // Record (do not fail on) the raw stream duration percentiles we care about.
    'chat_total_stream_ms': ['p(50)>=0'],
  }),
};

export function setup() {
  requireBotKey();
  env.assertSafe({ llm: true });
  return { conc: CONC };
}

export default function () {
  // One warm session per VU -> full generation path, no cross-VU collision.
  const sid = `session_warm_${(__VU - 1) % WARM}`;
  group('chat-turn', () => {
    const body = JSON.stringify({ question: pickQuestion(), session_id: sid });
    const extraHeaders = MOCK_LATENCY_MS ? { 'x-mock-latency-ms': MOCK_LATENCY_MS } : {};
    // Unique client IP per VU (via X-Forwarded-For) so each simulated visitor
    // gets its OWN rate-limit bucket ({bot_key}:{ip}) instead of all VUs sharing
    // one — otherwise the 30/min /chat/stream limit caps the whole run. The test
    // API must run with --proxy-headers --forwarded-allow-ips="*". This mirrors
    // real widget traffic (many distinct visitor IPs), it is NOT a limit bypass.
    extraHeaders['X-Forwarded-For'] = `10.${Math.floor(__VU / 254) % 254}.${__VU % 254}.7`;
    const params = botHeaders({ tags: { kind: 'chat', conc: String(CONC) }, timeout: '120s' });
    Object.assign(params.headers, extraHeaders);

    const res = http.post(url('/chat/stream'), body, params);
    ok(res, 'chat/stream');
    // k6 buffers SSE; waiting = server think time before first byte (TTFB proxy),
    // duration = full stream. Both climb sharply once the DB pool saturates.
    chatTTFB.add(res.timings.waiting);
    chatTotal.add(res.timings.duration);
  });
  // Small think time so we sustain ~CONC concurrent streams rather than hammering.
  sleep(Math.random() * 2 + 1);
}
