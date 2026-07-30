/**
 * Shared helpers for classifying errors thrown by `services/api.js`. Every
 * API call rejects with an `Error` decorated by `buildApiError` there:
 * `apiError.status` (HTTP status) and `apiError.data` (parsed response body).
 */

interface ApiErrorLike {
  status?: number;
  data?: { detail?: { must_subscribe?: boolean } };
}

/**
 * True when the API refused a request because a paid subscription is
 * required - the backend's uniform "paywall" signal (`HTTP 402` with
 * `detail.must_subscribe`), e.g. `can_client_add_new_bot` in
 * `plan_entitlements_service.py` refusing a second bot without an active
 * subscription. Callers should route this to the shared upgrade modal
 * instead of surfacing it as a raw error.
 */
export function requiresSubscription(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const apiError = err as ApiErrorLike;
  return apiError.status === 402 && apiError.data?.detail?.must_subscribe === true;
}
