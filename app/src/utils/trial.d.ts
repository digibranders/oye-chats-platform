/**
 * Type shim for the legacy trial date helper (`utils/trial.js`).
 * Runtime stays in the `.js`.
 */

/** Human-friendly absolute date, e.g. "Jul 16, 2026". Returns the input unchanged if unparseable. */
export function formatTrialDate(iso: string): string;
