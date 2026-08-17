// ACTIVE USERS — realistic mixed workload (Phase 2 model). One k6 VU = one active
// user with a STICKY persona (assigned from __VU), each with its own think time.
// This is the test that answers "how many ACTIVE users can we hold?", which is a
// very different number from "concurrent AI streams" — only ~5% of users are
// mid-chat at any moment.
//
// Persona mix (override with PCT_* env; must sum to 100):
//   70% idle/browsing   — occasional widget-config / health poll, long think time
//   20% normal API      — periodic authed dashboard reads
//    5% dashboard        — the heavier analytics/subscription reads
//    5% AI chat          — sends a chat message, waits, reads, repeats
//
// Every VU gets a UNIQUE client IP (X-Forwarded-For) so per-IP rate limits model
// distinct real users rather than throttling the whole test. Target API must run
// with --proxy-headers (staging compose + start-mock-stack.sh do).
//
//   k6 run -e USERS=1000 -e DURATION=2m -e MOCK_LLM_VERIFIED=1 \
//          -e BASE_URL=... -e BOT_KEY=... -e API_KEY=... load-tests/scenarios/active-users.js
import http from 'k6/http';
import { sleep, group } from 'k6';
import { env } from '../config/environments.js';
import { apiThresholds, chatThresholds, merge } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, adminHeaders, url } from '../helpers/http.js';
import { chatTTFB, chatTotal } from '../helpers/metrics.js';
import { pickQuestion } from '../helpers/data.js';

const USERS = parseInt(__ENV.USERS || '500', 10);
const WARM = parseInt(__ENV.WARM || '250', 10);
const PCT_IDLE = parseInt(__ENV.PCT_IDLE || '70', 10);
const PCT_API = parseInt(__ENV.PCT_API || '20', 10);
const PCT_DASH = parseInt(__ENV.PCT_DASH || '5', 10);
// remainder = AI

export const options = {
  scenarios: {
    users: {
      executor: 'ramping-vus',
      startVUs: Math.min(50, USERS),
      stages: [
        { duration: __ENV.RAMP || '30s', target: USERS },
        { duration: __ENV.HOLD || '2m', target: USERS },
        { duration: '20s', target: 0 },
      ],
      gracefulStop: '30s',
    },
  },
  thresholds: merge(apiThresholds, chatThresholds),
  // Big VU pools need a higher default; k6 warns otherwise.
  discardResponseBodies: false,
};

// Deterministic sticky persona from the VU id.
function persona() {
  const b = __VU % 100;
  if (b < PCT_IDLE) return 'idle';
  if (b < PCT_IDLE + PCT_API) return 'api';
  if (b < PCT_IDLE + PCT_API + PCT_DASH) return 'dash';
  return 'ai';
}

function xff() {
  // Unique-ish client IP per VU so each user is its own rate-limit bucket.
  return `10.${Math.floor(__VU / 254) % 254}.${__VU % 254}.${(__VU % 250) + 1}`;
}

export function setup() {
  env.assertSafe({ llm: true });
  return {};
}

export default function () {
  const p = persona();
  const ip = xff();
  const bh = botHeaders({ tags: { kind: 'api' } });
  bh.headers['X-Forwarded-For'] = ip;
  const ah = adminHeaders({ tags: { kind: 'api' } });
  ah.headers['X-Forwarded-For'] = ip;

  if (p === 'idle') {
    // Browsing: widget bootstrap / health, then a long read pause.
    ok(http.get(url('/bots/settings/public'), bh), 'widget-config');
    sleep(Math.random() * 25 + 15); // 15–40s
  } else if (p === 'api') {
    // Normal app usage: a couple of cheap authed reads, moderate pacing.
    if (env.API_KEY) {
      ok(http.get(url('/subscriptions/current'), ah), 'subscriptions/current');
      ok(http.get(url('/crawl/progress'), ah), 'crawl/progress');
    } else {
      ok(http.get(url('/bots/settings/public'), bh), 'widget-config');
    }
    sleep(Math.random() * 10 + 5); // 5–15s
  } else if (p === 'dash') {
    // Heavier dashboard reads (analytics-ish), 15s poll cadence.
    if (env.API_KEY) {
      const reqs = [
        ['GET', url('/subscriptions/current'), null, { ...ah, tags: { kind: 'analytics' } }],
        ['GET', url('/crawl/progress'), null, { ...ah, tags: { kind: 'analytics' } }],
        ['GET', url('/leads?limit=200'), null, { ...ah, tags: { kind: 'analytics' } }],
      ];
      http.batch(reqs).forEach((r, i) => ok(r, `dash[${i}]`));
    }
    sleep(15);
  } else {
    // AI chat: one turn against this VU's own warm session, then read.
    group('ai-chat', () => {
      const sid = `session_warm_${__VU % WARM}`;
      const params = botHeaders({ tags: { kind: 'chat' }, timeout: '120s' });
      params.headers['X-Forwarded-For'] = ip;
      const res = http.post(url('/chat/stream'), JSON.stringify({ question: pickQuestion(), session_id: sid }), params);
      ok(res, 'chat/stream');
      chatTTFB.add(res.timings.waiting);
      chatTotal.add(res.timings.duration);
    });
    sleep(Math.random() * 15 + 10); // 10–25s read/think before next message
  }
}
