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
// REQUIRED query params. Every /analytics/journey/* route declares
// ``bot_id: RowId = Query(...)`` and ``period: YearMonth = Query(...)``
// (api/app/api/analytics_routes.py), so omitting them returns 422 before any
// query runs. This scenario previously sent neither, which meant it measured
// FastAPI's validation-rejection path — fast, cheap, and nothing to do with
// analytics load. Any capacity number produced before this fix is invalid.
const BOT_ID = __ENV.BOT_ID || '1';
// Calendar month as YYYY-MM. Defaults to the current month so a fresh run
// targets data the seed actually created.
const PERIOD = __ENV.PERIOD || (() => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
})();
const Q = `bot_id=${BOT_ID}&period=${PERIOD}`;

export const options = {
  scenarios: {
    journey: { executor: 'constant-vus', vus: TABS, duration: __ENV.DURATION || '2m', gracefulStop: '15s' },
  },
  thresholds: analyticsThresholds,
};

// The 11 calls the UI issues per tick (align paths with
// app/src/features/analytics/useJourneyAnalytics.ts if they drift).
const JOURNEY_CALLS = [
  `/analytics/journey/summary?${Q}`,
  `/analytics/journey/top-pages?${Q}&scope=all`,
  `/analytics/journey/top-pages?${Q}&scope=pre`,
  `/analytics/journey/top-pages?${Q}&scope=chat`,
  `/analytics/journey/top-pages?${Q}&scope=post`,
  // conversion-paths takes ``conversion_type`` (a Literal over the three real
  // conversion events), NOT a ``scope`` — sending scope returned 422.
  `/analytics/journey/conversion-paths?${Q}&conversion_type=meeting_booked`,
  `/analytics/journey/conversion-paths?${Q}&conversion_type=handoff_requested`,
  `/analytics/journey/conversion-paths?${Q}&conversion_type=offline_message_sent`,
  `/analytics/journey/post-chat?${Q}`,
  `/analytics/journey/pre-chat-sequences?${Q}`,
  `/analytics/journey/summary?${Q}`,
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
