// AUTH THROUGHPUT — concurrent logins and registrations.
//
// This measures a ceiling nothing else here touches, and it is CPU-shaped rather
// than I/O-shaped: both paths run bcrypt at the default cost factor
// (app/core/security.py — `bcrypt.gensalt()`), which is ~250ms of pure CPU per
// call by design. So unlike chat (which waits on the LLM and therefore benefits
// from workers > cores), auth throughput is bounded by actual core count. Expect
// low absolute numbers and treat that as correct behaviour, not a regression:
// a cheap password hash would be the bug.
//
// RATE LIMITS ARE REAL AND TIGHT (api/app/api/auth_routes.py):
//   POST /auth/login    -> 10/minute
//   POST /auth/register ->  5/minute
// Both key on the caller's IP, so every VU sends a unique X-Forwarded-For to get
// its own bucket — exactly as distinct real users would. This is load shaping,
// NOT a limit bypass; the target must run with --proxy-headers (the systemd unit
// and start-mock-stack.sh both do).
//
// REGISTRATIONS WRITE ROWS. Each successful register creates a Client (plus
// whatever the signup flow provisions). Emails are unique per VU+iteration so
// runs don't collide, but the test DB grows — clean up between campaigns:
//   DELETE FROM clients WHERE email LIKE 'ltreg-%@example.invalid';
//
//   MODE=login    VUS=20 DURATION=45s k6 run load-tests/scenarios/auth-load.js
//   MODE=register VUS=10 DURATION=45s k6 run load-tests/scenarios/auth-load.js
//   MODE=both     VUS=20 DURATION=45s k6 run load-tests/scenarios/auth-load.js
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { env } from '../config/environments.js';
import { url } from '../helpers/http.js';

const MODE = (__ENV.MODE || 'login').toLowerCase(); // login | register | both
const VUS = parseInt(__ENV.VUS || '20', 10);
const DURATION = __ENV.DURATION || '45s';
const EMAIL = __ENV.CLIENT_EMAIL || 'loadtest@example.invalid';
const PASSWORD = __ENV.CLIENT_PASSWORD || 'LoadTest!Deterministic1';
// Distinguishes runs so re-running doesn't collide on already-taken emails.
const RUN_TAG = __ENV.RUN_TAG || `${Date.now()}`;

const loginMs = new Trend('auth_login_ms', true);
const registerMs = new Trend('auth_register_ms', true);
const loginOk = new Rate('auth_login_success');
const registerOk = new Rate('auth_register_success');
const rateLimited = new Counter('auth_rate_limited_429');

export const options = {
  scenarios: {
    auth: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '20s',
    },
  },
  thresholds: {
    // Deliberately generous: bcrypt is meant to be slow. We are finding the
    // throughput ceiling, not asserting a fast password hash.
    auth_login_ms: ['p(95)<5000'],
    // A 429 is the rate limiter working correctly, so it is not counted as a
    // failure here — but a 5xx or a rejected valid credential is.
    auth_login_success: ['rate>0.95'],
  },
};

export function setup() {
  env.assertSafe({ llm: false }); // auth touches no LLM
  return { mode: MODE };
}

// A UNIQUE IP PER REQUEST, not per VU. This is deliberate and it is the only way
// to measure server capacity here.
//
// /auth/login is 10/minute per IP and /auth/register is 5/minute per IP. With one
// IP per VU, 10 VUs can only ever land ~1.7 logins/sec and everything else
// returns 429 instantly — so the run measures the rate limiter (and reports a
// misleading ~200 rps of rejections) rather than how many bcrypt verifications
// the box can actually perform. Rotating the IP per request removes the limiter
// from the measurement, which is what we want when the question is "how many
// logins can this machine handle".
//
// The per-IP limit is a SEPARATE, already-known answer: 10 logins/min for one
// real user. Both numbers matter; they must not be conflated.
function headers() {
  const seq = __VU * 100000 + __ITER;
  const a = Math.floor(seq / 65536) % 240;
  const b = Math.floor(seq / 256) % 256;
  const c = seq % 256;
  return {
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `10.${a}.${b}.${c}`,
    },
    tags: { kind: 'api' },
  };
}

function doLogin() {
  const res = http.post(url('/auth/login'), JSON.stringify({ email: EMAIL, password: PASSWORD }), headers());
  loginMs.add(res.timings.duration);
  if (res.status === 429) {
    rateLimited.add(1);
    return; // limiter working as designed — neither success nor failure
  }
  const ok = check(res, { 'login 200': (r) => r.status === 200 });
  loginOk.add(ok);
}

function doRegister() {
  // Unique per VU + iteration + run so repeat runs never collide.
  const email = `ltreg-${RUN_TAG}-${__VU}-${__ITER}@example.invalid`;
  const body = JSON.stringify({
    name: 'LoadTest Signup',
    email,
    password: PASSWORD,
    company_name: 'LoadTest Co',
    billing_country: 'IN',
  });
  const res = http.post(url('/auth/register'), body, headers());
  registerMs.add(res.timings.duration);
  if (res.status === 429) {
    rateLimited.add(1);
    return;
  }
  // 200/201 both acceptable depending on the signup flow's response shape.
  const ok = check(res, { 'register 2xx': (r) => r.status === 200 || r.status === 201 });
  registerOk.add(ok);
}

export default function () {
  if (MODE === 'login') doLogin();
  else if (MODE === 'register') doRegister();
  else {
    // 'both' — a realistic ratio: logins vastly outnumber registrations.
    if (__ITER % 10 === 0) doRegister();
    else doLogin();
  }
}
