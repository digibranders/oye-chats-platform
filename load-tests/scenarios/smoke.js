// SMOKE — 1 VU, a few iterations. Proves scripts + auth + target + safety guards
// before ANY real load. Must pass at zero concurrency. Run first, always.
//
//   k6 run -e BASE_URL=http://localhost:8000 -e BOT_KEY=... -e API_KEY=... \
//          load-tests/scenarios/smoke.js
import http from 'k6/http';
import { sleep } from 'k6';
import { env } from '../config/environments.js';
import { smokeThresholds } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, adminHeaders, url } from '../helpers/http.js';

export const options = { vus: 1, iterations: 5, thresholds: smokeThresholds };

export function setup() {
  env.assertSafe(); // no llm flag — smoke never calls the chat path
}

export default function () {
  ok(http.get(url('/health/live'), { tags: { kind: 'api' } }), 'health/live');
  ok(http.get(url('/bots/settings/public'), botHeaders({ tags: { kind: 'api' } })), 'bots/settings/public');
  if (env.API_KEY) {
    ok(http.get(url('/subscriptions/current'), adminHeaders({ tags: { kind: 'api' } })), 'subscriptions/current');
  }
  sleep(1);
}
