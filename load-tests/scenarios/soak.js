// SOAK — sustained moderate load for a long duration (Phase 14) to expose slow
// leaks: memory growth, connection leaks, latency drift, queue buildup. Run at a
// SAFE sustained level (well below the knee) for 30m / 1h / 2h. Watch RSS and DB
// connection count trend upward over time via runner/sample-server.sh.
//
//   k6 run -e DURATION=1h -e VUS=15 -e CHAT=1 -e MOCK_LLM_VERIFIED=1 \
//          -e BASE_URL=http://127.0.0.1:8001 -e BOT_KEY=... load-tests/scenarios/soak.js
//
// TWO THINGS THIS SCENARIO GETS WRONG IF YOU CHANGE THEM BACK
//
// 1. Every VU sends a DISTINCT X-Forwarded-For. Without it all VUs share the
//    driver's single IP and SlowAPI's per-(bot_key, IP) limit on /chat/stream
//    (30/min) becomes the binding constraint: a measured run produced 9,861
//    429s against 1,800 200s in one hour -- 84.6% of chat traffic rejected at
//    the limiter, with the 1,800 being exactly the 30/min ceiling. The soak
//    then measures SlowAPI rather than the RAG path, for however many hours it
//    runs. Real visitors arrive from many addresses, so per-VU IPs are also the
//    more faithful model.
//
// 2. Run the server with GUNICORN_MAX_REQUESTS=0 for a soak. The default
//    recycles a worker every 10,000 requests (+/- 1,000 jitter), which resets
//    its RSS and file descriptors -- exactly the counters a soak exists to
//    watch drift. With recycling on, a leak is erased roughly hourly and the
//    run cannot detect the thing it was started to detect.
import http from 'k6/http';
import { sleep } from 'k6';
import { env } from '../config/environments.js';
import { apiThresholds, chatThresholds, merge } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, adminHeaders, url } from '../helpers/http.js';
import { chatTTFB, chatTotal } from '../helpers/metrics.js';
import { sessionId, pickQuestion } from '../helpers/data.js';

const CHAT = __ENV.CHAT === '1';
const VUS = parseInt(__ENV.VUS || '15', 10);

// One stable synthetic visitor IP per VU (see note 1 above). Same shape as
// ws-soak.js so both arms of a soak model visitors the same way.
function vuIp() {
  const vu = __VU;
  return `10.${Math.floor(vu / 254) % 254}.${vu % 254}.31`;
}

// Merge the per-VU IP into a header set built by the shared helpers, without
// mutating what they return.
function fromVu(base) {
  return { ...base, headers: { ...base.headers, 'X-Forwarded-For': vuIp() } };
}

export const options = {
  scenarios: { soak: { executor: 'constant-vus', vus: VUS, duration: __ENV.DURATION || '30m', gracefulStop: '30s' } },
  thresholds: CHAT ? merge(apiThresholds, chatThresholds) : apiThresholds,
};

export function setup() {
  env.assertSafe({ llm: CHAT });
}

export default function () {
  ok(http.get(url('/health'), { tags: { kind: 'api' } }), 'health');
  ok(http.get(url('/bots/settings/public'), fromVu(botHeaders({ tags: { kind: 'api' } }))), 'widget-config');
  if (env.API_KEY) ok(http.get(url('/crawl/progress'), fromVu(adminHeaders({ tags: { kind: 'api' } }))), 'crawl/progress');
  if (CHAT) {
    const body = JSON.stringify({ question: pickQuestion(), session_id: sessionId('soak') });
    const res = http.post(url('/chat/stream'), body, fromVu(botHeaders({ tags: { kind: 'chat' }, timeout: '120s' })));
    ok(res, 'chat/stream');
    chatTTFB.add(res.timings.waiting);
    chatTotal.add(res.timings.duration);
  }
  sleep(Math.random() * 3 + 2);
}
