// Response checks that feed the shared error metric. A failed check NEVER throws
// (that would abort the VU and skew results) — it records an error and returns
// false so the caller can branch.
import { check } from 'k6';
import { errors, requests } from './metrics.js';

export function ok(res, name, expected = 200) {
  requests.add(1);
  const passed = check(res, {
    [`${name} status ${expected}`]: (r) => r.status === expected,
  });
  errors.add(!passed);
  return passed;
}

// Accept any 2xx (some endpoints return 200/201/204).
export function ok2xx(res, name) {
  requests.add(1);
  const passed = check(res, { [`${name} 2xx`]: (r) => r.status >= 200 && r.status < 300 });
  errors.add(!passed);
  return passed;
}
