// BASELINE — steady, safe, moderate load to establish reference percentiles for
// the NON-chat web tier (Phase 6). No LLM. Run after smoke, before stress.
import http from 'k6/http';
import { sleep } from 'k6';
import { env } from '../config/environments.js';
import { apiThresholds } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, adminHeaders, url } from '../helpers/http.js';

const VUS = parseInt(__ENV.VUS || '10', 10);

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: VUS },
        { duration: __ENV.HOLD || '3m', target: VUS },
        { duration: '30s', target: 0 },
      ],
      gracefulStop: '20s',
    },
  },
  thresholds: apiThresholds,
};

export function setup() {
  env.assertSafe();
}

export default function () {
  // Cheap, cached, read-only endpoints — representative of the highest-frequency
  // real traffic (health probes + widget config bootstrap).
  ok(http.get(url('/health'), { tags: { kind: 'api' } }), 'health');
  ok(http.get(url('/bots/settings/public'), botHeaders({ tags: { kind: 'api' } })), 'widget-config');
  if (env.API_KEY) {
    ok(http.get(url('/subscriptions/current'), adminHeaders({ tags: { kind: 'api' } })), 'subscriptions/current');
  }
  sleep(Math.random() + 0.5);
}
