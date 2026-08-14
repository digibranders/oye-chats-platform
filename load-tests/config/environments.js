// Environment resolution + HARD safety guards for OyeChats load tests.
//
// Design goal: make it EASY to run against a local/staging target and HARD to
// accidentally (a) hit production or (b) spend real LLM money. Guards fail hard
// (throw) rather than warn — a warning in a load test is a warning nobody reads.
//
// Env vars (all optional except where a mode requires them):
//   TEST_ENV        local | staging | production   (default: local)
//   BASE_URL        target API base URL             (default: http://localhost:8000)
//   BOT_KEY         X-Bot-Key for widget/chat endpoints (seeded test bot)
//   API_KEY         X-API-Key for admin/dashboard endpoints (seeded test admin)
//   OPERATOR_KEY    X-Operator-Key for operator endpoints
//   MOCK_LLM        true | false                    (default: true)
//   ALLOW_REAL_LLM_TEST, TEST_PROVIDER, LOAD_TEST_OPENAI_API_KEY,
//   CONFIRM_REAL_LLM_LOAD_TEST, MAX_REAL_LLM_*      (real-LLM mode — see below)

const TEST_ENV = (__ENV.TEST_ENV || 'local').toLowerCase();
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';

// ── Known production fingerprints — execution is refused if the target or the
//    loaded secrets match ANY of these, regardless of other flags. ────────────
const PROD_FINGERPRINTS = [
  'api.oyechats.com',
  '159.223.45.213',
  'oyechats-api',
];

// MOCK_LLM defaults to TRUE. Real LLM must be turned ON explicitly.
const MOCK_LLM = (__ENV.MOCK_LLM || 'true').toLowerCase() !== 'false';

// Real-LLM mode requires the full set of explicit acknowledgements.
const ALLOW_REAL_LLM_TEST = (__ENV.ALLOW_REAL_LLM_TEST || '') === 'true';
const CONFIRM_REAL_LLM_LOAD_TEST = (__ENV.CONFIRM_REAL_LLM_LOAD_TEST || '') === 'true';
const TEST_PROVIDER = (__ENV.TEST_PROVIDER || '').toLowerCase();
const LOAD_TEST_OPENAI_API_KEY = __ENV.LOAD_TEST_OPENAI_API_KEY || '';

// Hard ceilings for real-LLM runs (Phase 8A). Overridable only WITH the confirm flag.
const MAX_REAL_LLM_VUS = parseInt(__ENV.MAX_REAL_LLM_VUS || '10', 10);
const MAX_REAL_LLM_REQUESTS = parseInt(__ENV.MAX_REAL_LLM_REQUESTS || '100', 10);
const MAX_REAL_LLM_DURATION = __ENV.MAX_REAL_LLM_DURATION || '5m';

function isProdTarget() {
  const hay = BASE_URL.toLowerCase();
  return PROD_FINGERPRINTS.some((f) => hay.includes(f)) || TEST_ENV === 'production';
}

// A load-test key must NOT be a production key. We can't see prod's key value,
// but we CAN refuse the obvious footguns: an empty real-LLM key, or a key passed
// through the app's PRODUCTION env var name instead of the dedicated one.
function assertRealLlmSecretsAreDedicated() {
  if (__ENV.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is present in the load-test environment. Real-LLM tests must ' +
        'use LOAD_TEST_OPENAI_API_KEY (a dedicated OYECHATS_LOADTEST project key) and must ' +
        'NEVER inherit the production key. Unset OPENAI_API_KEY before running.',
    );
  }
  if (!LOAD_TEST_OPENAI_API_KEY) {
    throw new Error(
      'Real-LLM test requested but LOAD_TEST_OPENAI_API_KEY is not set. Refusing to run ' +
        '(will not silently fall back to any production key). Set a dedicated test key.',
    );
  }
}

// THE gate. Every scenario calls this in setup() before generating any traffic.
// `opts.llm` = true means this scenario drives the chat/LLM path.
function assertSafe(opts = {}) {
  // 1. Never touch production.
  if (isProdTarget()) {
    throw new Error(
      `Refusing to run: target "${BASE_URL}" (TEST_ENV=${TEST_ENV}) looks like PRODUCTION. ` +
        `Point BASE_URL at a local/staging API. Production load testing is not supported by this harness.`,
    );
  }

  // 2. LLM isolation.
  if (opts.llm) {
    if (MOCK_LLM) {
      // Mock mode: the TARGET API must be routed to the mock server. We can't
      // introspect the API from k6, so we require the operator to have started
      // the API with OPENAI_API_BASE/GEMINI_EMBED_URL pointed at the mock. The
      // mock-stack bring-up script sets MOCK_LLM_VERIFIED=1 after probing it.
      if (__ENV.MOCK_LLM_VERIFIED !== '1') {
        throw new Error(
          'MOCK_LLM=true but the target API has not been verified as routed to the mock LLM. ' +
            'Bring the target up with runner/start-mock-stack.sh (it sets MOCK_LLM_VERIFIED=1), ' +
            'or set it yourself only after confirming OPENAI_API_BASE points at the mock server.',
        );
      }
    } else {
      // Real mode: require the full explicit acknowledgement set.
      if (!ALLOW_REAL_LLM_TEST) throw new Error('Real LLM disabled. Set ALLOW_REAL_LLM_TEST=true (and see README §Real-LLM).');
      if (TEST_PROVIDER !== 'openai') throw new Error('Real LLM requires TEST_PROVIDER=openai.');
      assertRealLlmSecretsAreDedicated();
      const overLimit = (__ENV.__OVER_REAL_LIMIT === '1');
      if (overLimit && !CONFIRM_REAL_LLM_LOAD_TEST) {
        throw new Error('Real-LLM limits exceeded. To override the hard ceilings set CONFIRM_REAL_LLM_LOAD_TEST=true.');
      }
    }
  }
}

export const env = {
  TEST_ENV,
  BASE_URL,
  BOT_KEY: __ENV.BOT_KEY || 'bot-loadtest-000000',
  API_KEY: __ENV.API_KEY || '',
  OPERATOR_KEY: __ENV.OPERATOR_KEY || '',
  MOCK_LLM,
  realLlm: {
    ALLOW_REAL_LLM_TEST,
    CONFIRM_REAL_LLM_LOAD_TEST,
    TEST_PROVIDER,
    LOAD_TEST_OPENAI_API_KEY, // used only by the real-LLM scenario, never logged
    MAX_REAL_LLM_VUS,
    MAX_REAL_LLM_REQUESTS,
    MAX_REAL_LLM_DURATION,
  },
  isProdTarget,
  assertSafe,
};
