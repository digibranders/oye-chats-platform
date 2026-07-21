/**
 * Type shim for the legacy trial date helpers (`utils/trial.js`).
 * Runtime stays in the `.js`; all counts are ceil-rounded so every countdown
 * in the app agrees. Each returns `null` when the ISO input is missing/unparseable.
 */

/** Whole days until the trial-end ISO timestamp (ceil; 0/negative once lapsed). */
export function trialDaysLeft(iso: string, nowMs?: number): number | null;

/** Whole days until an arbitrary ISO timestamp (ceil) — e.g. data-retention deadline. */
export function daysUntil(iso: string, nowMs?: number): number | null;

/** Human-friendly absolute date, e.g. "Jul 16, 2026". Returns the input unchanged if unparseable. */
export function formatTrialDate(iso: string): string;
