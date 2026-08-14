// SPIKE — sudden traffic slam + recovery observation (Phase 13). Ramps 50 -> 500
// in seconds, holds, drops, then watches recovery. Answers: does the single
// worker shed load gracefully or collapse? Non-chat by default (add CHAT=1 only
// against the mock stack). Watch server DB pool + CPU via runner/sample-server.sh.
import http from 'k6/http';
import { sleep } from 'k6';
import { env } from '../config/environments.js';
import { apiThresholds } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, adminHeaders, url } from '../helpers/http.js';

const PEAK = parseInt(__ENV.PEAK || '500', 10);

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 50 }, // pre-spike
        { duration: '10s', target: PEAK }, // SLAM
        { duration: '1m', target: PEAK }, // hold at peak
        { duration: '10s', target: 50 }, // drop
        { duration: '2m', target: 50 }, // observe recovery
        { duration: '20s', target: 0 },
      ],
      gracefulStop: '30s',
    },
  },
  // Do NOT fail the run on threshold breach here — the whole point is to SEE the
  // breach and recovery. Percentiles are recorded for the report.
  thresholds: {},
};

export function setup() {
  env.assertSafe();
}

export default function () {
  ok(http.get(url('/health'), { tags: { kind: 'api' } }), 'health');
  ok(http.get(url('/bots/settings/public'), botHeaders({ tags: { kind: 'api' } })), 'widget-config');
  if (env.API_KEY) ok(http.get(url('/crawl/progress'), adminHeaders({ tags: { kind: 'api' } })), 'crawl/progress');
  sleep(Math.random() * 0.5 + 0.2);
}
