// DASHBOARD — models steady-state load from OPEN admin tabs (Phase 11), at the
// real poll cadences the frontend audit found. Each VU = one idle dashboard tab.
// Answers "how many open tabs before polling alone pressures the single worker?"
//   - /crawl/progress            every 30s (idle probe, every page)
//   - /subscriptions/payment-recovery every 5 min (billing banners)
//   - live-chat preview history  every 4s IF PREVIEW=1 (drawer open)
import http from 'k6/http';
import { sleep } from 'k6';
import { env } from '../config/environments.js';
import { apiThresholds } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { adminHeaders, url } from '../helpers/http.js';
import { requireApiKey } from '../helpers/auth.js';

const TABS = parseInt(__ENV.TABS || '50', 10);
const PREVIEW = __ENV.PREVIEW === '1';
const PREVIEW_SID = __ENV.PREVIEW_SID || '';

export const options = {
  scenarios: { dash: { executor: 'constant-vus', vus: TABS, duration: __ENV.DURATION || '3m', gracefulStop: '15s' } },
  thresholds: apiThresholds,
};

export function setup() {
  requireApiKey();
  env.assertSafe();
}

let lastCrawl = 0;
let lastBilling = 0;
let lastPreview = 0;

export default function () {
  const now = Date.now();
  if (now - lastCrawl >= 30000) {
    ok(http.get(url('/crawl/progress'), adminHeaders({ tags: { kind: 'api' } })), 'crawl/progress');
    lastCrawl = now;
  }
  if (now - lastBilling >= 300000) {
    ok(http.get(url('/subscriptions/payment-recovery'), adminHeaders({ tags: { kind: 'api' } })), 'payment-recovery');
    lastBilling = now;
  }
  if (PREVIEW && PREVIEW_SID && now - lastPreview >= 4000) {
    ok(http.get(url(`/chat/history/${PREVIEW_SID}?limit=50`), adminHeaders({ tags: { kind: 'api' } })), 'chat-history-preview');
    lastPreview = now;
  }
  sleep(1);
}
