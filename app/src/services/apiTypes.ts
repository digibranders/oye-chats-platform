import type { AxiosError } from 'axios';

/**
 * The backend's error envelope. No endpoint returns all of it, hence every
 * field optional.
 *
 * `detail` is deliberately loose: FastAPI puts a plain string there for a
 * simple abort, an object with `message` for a structured error (402
 * insufficient_credits and friends), and an ARRAY of per-field objects for a
 * 422 validation failure. `buildApiError` branches on all three.
 */
export interface ApiErrorEnvelope {
  detail?: string | { message?: string; error?: string; [key: string]: unknown } | unknown[];
  /** SlowAPI's 429 shape, which is `{"error": "..."}` rather than FastAPI's `{"detail": ...}`. */
  error?: string;
}

/** An axios rejection whose response body is the standard envelope. */
export type ApiAxiosError = AxiosError<ApiErrorEnvelope>;

/**
 * The error every API call in `services/api` rejects with.
 *
 * `buildApiError` has always attached `status`, `detail` and `data` to a plain
 * Error, and `api.d.ts` never described any of them, so all 119 consumers read
 * those fields through an implicit `any`. A real subclass makes `instanceof`
 * narrowing work and gives the fields a checked shape.
 *
 * Note what is NOT here: a `code`. The one `err.code` read in the codebase is
 * against axios's own `ERR_CANCELED` on a raw rejection, not against this.
 */
export class ApiError extends Error {
  /** HTTP status, or undefined for a network-level failure with no response. */
  readonly status: number | undefined;
  /** `response.data.detail` verbatim, or null when the body carried none. */
  readonly detail: unknown;
  /** The whole response body, for callers needing more than message + detail. */
  readonly data: unknown;

  constructor(
    message: string,
    options: { status?: number; detail?: unknown; data?: unknown } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.detail = options.detail ?? null;
    this.data = options.data;
  }
}

/** Narrowing helper for `catch` blocks, which bind `unknown` under strict. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
