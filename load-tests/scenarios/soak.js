// SOAK — sustained moderate load for a long duration (Phase 14) to expose slow
// leaks: memory growth, connection leaks, latency drift, queue buildup. Run at a
// SAFE sustained level (well below the knee) for 30m / 1h / 2h. Watch RSS and DB
// connection count trend upward over time via runner/sample-server.sh.
//
//   k6 run -e DURATION=1h -e VUS=15 -e CHAT=1 -e MOCK_LLM_VERIFIED=1 \
//          -e BASE_URL=http://127.0.0.1:8001 -e BOT_KEY=... load-tests/scenarios/soak.js
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

export const options = {
  scenarios: { soak: { executor: 'constant-vus', vus: VUS, duration: __ENV.DURATION || '30m', gracefulStop: '30s' } },
  thresholds: CHAT ? merge(apiThresholds, chatThresholds) : apiThresholds,
};

export function setup() {
  env.assertSafe({ llm: CHAT });
}

export default function () {
  ok(http.get(url('/health'), { tags: { kind: 'api' } }), 'health');
  ok(http.get(url('/bots/settings/public'), botHeaders({ tags: { kind: 'api' } })), 'widget-config');
  if (env.API_KEY) ok(http.get(url('/crawl/progress'), adminHeaders({ tags: { kind: 'api' } })), 'crawl/progress');
  if (CHAT) {
    const body = JSON.stringify({ question: pickQuestion(), session_id: sessionId('soak') });
    const res = http.post(url('/chat/stream'), body, botHeaders({ tags: { kind: 'chat' }, timeout: '120s' }));
    ok(res, 'chat/stream');
    chatTTFB.add(res.timings.waiting);
    chatTotal.add(res.timings.duration);
  }
  sleep(Math.random() * 3 + 2);
}
