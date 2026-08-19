/** Shapes returned by the platform's watch endpoints. */

export interface CommandCentre {
  operator_transfers: number;
  bant_qualified_leads: number;
  chats_total: number;
  feature_requests: number;
  booked_meetings: number;
  /** USD cents, normalised server-side across INR and USD invoices. */
  revenue_last_month_cents: number;
  revenue_current_month_cents: number;
  growth_last_year_cents: number;
  growth_current_year_cents: number;
  /** Null when last year was zero — a growth rate against nothing is not a number. */
  growth_pct: number | null;
  signups_last_month: number;
  signups_current_month: number;
}

export interface PlatformStats {
  total_clients: number;
  total_messages: number;
  total_sessions: number;
}

export type ServiceState = 'connected' | 'unreachable' | 'disabled' | 'unknown' | string;

export interface SystemHealth {
  status: 'healthy' | 'degraded' | string;
  version: string;
  database: ServiceState;
  redis: ServiceState;
  worker: ServiceState;
  razorpay: ServiceState;
  storage: ServiceState;
}

export interface QueueStatus {
  queue_name: string;
  pending: number;
  in_flight: number;
  failed: number;
  /** 1 or 0 — the endpoint reports a count, not a boolean. */
  workers_alive: number;
  oldest_pending_seconds: number;
}

export interface TimeseriesPoint {
  date: string;
  value: number;
}

export type TimeseriesMetric = 'revenue' | 'messages' | 'signups';

/** Every service the health endpoint reports, in the order they are read. */
export const HEALTH_SERVICES = [
  { key: 'database', label: 'Database' },
  { key: 'redis', label: 'Redis' },
  { key: 'worker', label: 'Background worker' },
  { key: 'razorpay', label: 'Razorpay' },
  { key: 'storage', label: 'File storage' },
] as const;

/**
 * A service state, as a tone.
 *
 * `disabled` is neutral, not a fault: a platform running without Razorpay in a
 * staging environment is configured that way on purpose, and painting it red
 * trains an operator to ignore the one that matters. `unknown` is a warning,
 * because "we could not tell" is genuinely worse than "it is off".
 */
export function serviceTone(state: ServiceState): 'success' | 'warning' | 'danger' | 'neutral' {
  if (state === 'connected') return 'success';
  if (state === 'unreachable') return 'danger';
  if (state === 'disabled') return 'neutral';
  return 'warning';
}

export function serviceLabel(state: ServiceState): string {
  if (state === 'connected') return 'Connected';
  if (state === 'unreachable') return 'Unreachable';
  if (state === 'disabled') return 'Not configured';
  return 'Unknown';
}
