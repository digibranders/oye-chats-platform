// JOURNEY ANALYTICS — reproduces the dashboard's most expensive frontend
// behaviour (Phase 11): the Analytics->Journey tab fires an 11-endpoint burst
// every 15s (~44 req/min/tab). Each VU = one operator sitting on that tab.
// Quantifies backend impact at 10/25/50/100/250 concurrent Journey tabs.
//
//   k6 run -e TABS=50 -e BASE_URL=... -e API_KEY=... load-tests/scenarios/journey-analytics.js
import http from 'k6/http';
import { sleep, group } from 'k6';
import { env } from '../config/environments.js';
import { analyticsThresholds } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { adminHeaders, url } from '../helpers/http.js';
import { requireApiKey } from '../helpers/auth.js';

const TABS = parseInt(__ENV.TABS || '50', 10);

export const options = {
  scenarios: {
    journey: { executor: 'constant-vus', vus: TABS, duration: __ENV.DURATION || '2m', gracefulStop: '15s' },
  },
  thresholds: analyticsThresholds,
};

// The 11 calls the UI issues per tick (align paths with
// app/src/features/analytics/useJourneyAnalytics.ts if they drift).
const JOURNEY_CALLS = [
  '/analytics/journey/summary',
  '/analytics/journey/top-pages?scope=all',
  '/analytics/journey/top-pages?scope=pre',
  '/analytics/journey/top-pages?scope=chat',
  '/analytics/journey/top-pages?scope=post',
  '/analytics/journey/conversion-paths?scope=all',
  '/analytics/journey/conversion-paths?scope=pre',
  '/analytics/journey/conversion-paths?scope=post',
  '/analytics/journey/post-chat',
  '/analytics/journey/pre-chat-sequences',
  '/analytics/journey/summary?window=7d',
];

export function setup() {
  requireApiKey();
  env.assertSafe();
}

export default function () {
  group('journey-burst', () => {
    const reqs = JOURNEY_CALLS.map((p) => ['GET', url(p), null, adminHeaders({ tags: { kind: 'analytics' } })]);
    const responses = http.batch(reqs);
    responses.forEach((r, i) => ok(r, `journey[${i}]`));
  });
  sleep(15); // the UI's 15s poll cadence
}
