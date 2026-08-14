// API LOAD — realistic weighted mix of the real OyeChats endpoints (Phase 10),
// ramped 10 -> 500 VUs. Weighting reflects the production nginx-log distribution
// (health/widget-config/poll dominate; dashboard reads moderate; chat is light
// but optional). Chat is included ONLY when CHAT=1 (needs the mock stack).
//
//   k6 run -e BASE_URL=... -e BOT_KEY=... -e API_KEY=... load-tests/scenarios/api-load.js
//   k6 run -e MAXVUS=250 ...                # cap the ramp
import http from 'k6/http';
import { sleep } from 'k6';
import { env } from '../config/environments.js';
import { apiThresholds, chatThresholds, merge } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, adminHeaders, url } from '../helpers/http.js';
import { chatTTFB, chatTotal } from '../helpers/metrics.js';
import { sessionId, pickQuestion } from '../helpers/data.js';

const CHAT = __ENV.CHAT === '1';
const MAXVUS = parseInt(__ENV.MAXVUS || '500', 10);

// Ramp through the requested user levels: 10,25,50,100,250,500 (clamped to MAXVUS).
const levels = [10, 25, 50, 100, 250, 500].filter((n) => n <= MAXVUS);
const stages = [];
for (const n of levels) {
  stages.push({ duration: '1m', target: n }); // ramp to level
  stages.push({ duration: '1m', target: n }); // hold to read percentiles
}
stages.push({ duration: '30s', target: 0 });

export const options = {
  scenarios: { api: { executor: 'ramping-vus', startVUs: 1, stages, gracefulStop: '30s' } },
  thresholds: CHAT ? merge(apiThresholds, chatThresholds) : apiThresholds,
};

export function setup() {
  env.assertSafe({ llm: CHAT });
}

// Weighted endpoint picker. Adjust weights to match your traffic model.
function pick() {
  const r = Math.random();
  if (r < 0.30) return 'health';
  if (r < 0.55) return 'widget';
  if (r < 0.72) return 'poll';
  if (r < 0.88 && env.API_KEY) return 'dashboard';
  if (r < 0.96 && env.API_KEY) return 'leads';
  return CHAT ? 'chat' : 'widget';
}

export default function () {
  const a = pick();
  if (a === 'health') {
    ok(http.get(url('/health'), { tags: { kind: 'api' } }), 'health');
  } else if (a === 'widget') {
    ok(http.get(url('/bots/settings/public'), botHeaders({ tags: { kind: 'api' } })), 'widget-config');
  } else if (a === 'poll') {
    ok(http.get(url('/crawl/progress'), adminHeaders({ tags: { kind: 'api' } })), 'crawl/progress');
  } else if (a === 'dashboard') {
    ok(http.get(url('/subscriptions/current'), adminHeaders({ tags: { kind: 'api' } })), 'subscriptions/current');
  } else if (a === 'leads') {
    ok(http.get(url('/leads?limit=200'), adminHeaders({ tags: { kind: 'api' } })), 'leads');
  } else if (a === 'chat') {
    const body = JSON.stringify({ question: pickQuestion(), session_id: sessionId('api') });
    const res = http.post(url('/chat/stream'), body, botHeaders({ tags: { kind: 'chat' }, timeout: '120s' }));
    ok(res, 'chat/stream');
    chatTTFB.add(res.timings.waiting);
    chatTotal.add(res.timings.duration);
  }
  sleep(Math.random() * 1.5 + 0.3);
}
