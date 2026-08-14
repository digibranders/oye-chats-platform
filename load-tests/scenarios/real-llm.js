// REAL-LLM VALIDATION — Phase 9 / 8A Mode 2. A SMALL, opt-in run against a REAL
// provider to validate LiteLLM integration, streaming, provider latency, retries,
// fallback and rate limiting. It is NOT a capacity test — never mix its numbers
// with the mock (application-capacity) numbers.
//
// Requires ALL of (see config/environments.js):
//   MOCK_LLM=false ALLOW_REAL_LLM_TEST=true TEST_PROVIDER=openai
//   LOAD_TEST_OPENAI_API_KEY=<dedicated OYECHATS_LOADTEST key>   (never the prod key)
//   OPENAI_API_KEY unset in this shell
// Hard caps (override only WITH CONFIRM_REAL_LLM_LOAD_TEST=true):
//   MAX_REAL_LLM_VUS=10  MAX_REAL_LLM_REQUESTS=100  MAX_REAL_LLM_DURATION=5m
//
// IMPORTANT: the TARGET API instance must itself be configured with the dedicated
// LOAD_TEST key as its OPENAI_API_KEY — k6 only sends X-Bot-Key; the API makes the
// provider call. This scenario asserts the *test harness* isn't holding a prod key,
// and enforces concurrency/volume caps. Cost is ESTIMATED unless the API echoes usage.
import http from 'k6/http';
import { sleep, group } from 'k6';
import { env } from '../config/environments.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, url } from '../helpers/http.js';
import { requireBotKey } from '../helpers/auth.js';
import { chatTTFB, chatTotal, llmRequests } from '../helpers/metrics.js';
import { sessionId, pickQuestion } from '../helpers/data.js';

const VUS = parseInt(__ENV.VUS || '2', 10); // start tiny: 1,2,5,10
const r = env.realLlm;

// Enforce hard caps BEFORE k6 builds the scenario.
const overVus = VUS > r.MAX_REAL_LLM_VUS;
if (overVus) {
  // Signal to the safety gate; it throws unless CONFIRM_REAL_LLM_LOAD_TEST=true.
  __ENV.__OVER_REAL_LIMIT = '1';
}

export const options = {
  scenarios: {
    real: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: Math.min(parseInt(__ENV.ITERATIONS || '20', 10), r.MAX_REAL_LLM_REQUESTS),
      maxDuration: r.MAX_REAL_LLM_DURATION,
      gracefulStop: '30s',
    },
  },
  // No pass/fail thresholds — this is a behaviour probe, not a capacity gate.
  thresholds: {},
};

export function setup() {
  requireBotKey();
  // llm:true + MOCK_LLM=false triggers the full real-LLM acknowledgement checks.
  env.assertSafe({ llm: true });
  return {};
}

export default function () {
  group('real-llm-turn', () => {
    const body = JSON.stringify({ question: pickQuestion(), session_id: sessionId('real') });
    const res = http.post(url('/chat/stream'), body, botHeaders({ tags: { kind: 'chat' }, timeout: '120s' }));
    ok(res, 'chat/stream');
    llmRequests.add(1);
    chatTTFB.add(res.timings.waiting);
    chatTotal.add(res.timings.duration);
    // Token/retry/fallback/429 counts come from the SERVER side (Langfuse / the
    // API's llm_call_logs / provider dashboard), not from k6 — the widget stream
    // does not echo usage. Record them into the results file manually from those
    // sources; see README §Real-LLM cost tracking.
  });
  sleep(Math.random() * 3 + 2);
}
