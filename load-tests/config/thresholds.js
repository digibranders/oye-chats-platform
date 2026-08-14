// Central threshold definitions (Phase 17). These are INITIAL engineering
// targets, not universal truths — see load-tests/README.md §Thresholds for how
// to re-tune them once real baselines exist for the target environment.
//
// A k6 run exits non-zero when a threshold is breached. That is intentional:
// the stress/spike profiles are SUPPOSED to breach, and the VU level at which
// they do is the capacity answer.

// General (non-chat) API endpoints — simple DB round-trips.
export const apiThresholds = {
  'http_req_duration{kind:api}': ['p(95)<500', 'p(99)<1500'],
  'http_req_failed{kind:api}': ['rate<0.01'],
  journey_errors: ['rate<0.01'],
};

// Analytics endpoints do heavier aggregation — a looser ceiling.
export const analyticsThresholds = {
  'http_req_duration{kind:analytics}': ['p(95)<2000', 'p(99)<5000'],
};

// Chat / streaming path. TTFB = retrieval + relevance gate + first token.
// With MOCK_LLM these reflect APPLICATION latency; with real LLM they include
// provider latency and must NOT be compared to the mock numbers.
export const chatThresholds = {
  chat_time_to_first_byte: ['p(95)<3000'],
  chat_total_stream_ms: ['p(95)<12000'],
  'http_req_failed{kind:chat}': ['rate<0.01'],
  journey_errors: ['rate<0.01'],
};

// Smoke must be clean at ~zero concurrency or the harness/target is broken.
export const smokeThresholds = {
  http_req_failed: ['rate<0.01'],
  journey_errors: ['rate<0.01'],
};

export function merge(...objs) {
  return Object.assign({}, ...objs);
}
