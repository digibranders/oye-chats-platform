/**
 * Shapes returned by the configuration endpoints.
 *
 * Written against the handlers in `superadmin_routes_v2.py` and
 * `superadmin_ops_routes.py`. Where a field is optional here it is because the
 * server genuinely omits it: `/llm/usage` has a fallback query path that drops
 * the latency percentiles and the fallback and error counts when the `case()`
 * construct is unavailable, and every screen has to survive that.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** `GET /superadmin/feature-flags` — the same rows `pricing-config` serves. */
export interface ConfigRow {
  key: string;
  value: JsonValue;
  updated_at: string | null;
}

export interface KnownModel {
  id: string;
  label: string;
  provider: string;
  tier: string;
}

export interface KnownCrawlProvider {
  id: string;
  label: string;
  notes: string;
}

export interface ModelConfig {
  primary_model: string;
  fallback_model: string;
  gate_model: string;
  rag: {
    chunk_size: number;
    chunk_overlap: number;
    rerank_top_n: number;
    relevance_threshold: number;
  };
  embed: { concurrency: number };
  crawler: {
    primary_provider: string;
    fallback_provider: string;
    jina_fetch_concurrency: number;
    spider_fetch_concurrency: number;
  };
  impersonation: {
    /** The effective state: the environment floor AND the stored row. */
    enabled: boolean;
    /** True when the environment refuses it, so the toggle cannot lift it. */
    locked_by_env: boolean;
  };
  known_models: KnownModel[];
  known_crawl_providers: KnownCrawlProvider[];
}

export interface ModelConfigWriteResult {
  ok: boolean;
  changed: string[];
  primary_model: string;
  fallback_model: string;
  gate_model: string;
  crawl_provider_primary: string;
}

export interface LlmUsageRow {
  date: string;
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** USD cents. */
  cost_cents: number;
  p50_latency_ms?: number | null;
  p95_latency_ms?: number | null;
  fallback_count?: number;
  error_count?: number;
}

export interface LlmCostRow {
  key: string | null;
  label: string | null;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_cents: number;
  error_count: number;
}

export interface EmailTemplate {
  id: string | number | null;
  key: string;
  name: string;
  audience: string;
  category: string;
  description: string;
  trigger: string;
  metered: boolean;
  sender_fn: string;
}

export interface EmailTemplates {
  provider: string;
  manage_url: string;
  from_address: string | null;
  from_name: string | null;
  enabled: boolean;
  templates: EmailTemplate[];
}

export interface WebhookDelivery {
  id: number;
  webhook_id: number;
  event: string;
  status_code: number | null;
  attempt: number;
  next_retry_at: string | null;
  created_at: string | null;
  delivered_at: string | null;
}

export interface WebhookRegistration {
  id: number;
  bot_id: number;
  bot_name: string | null;
  client_name: string | null;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface FailedWebhook {
  id: number;
  provider: string;
  event_id: string | null;
  event_type: string | null;
  error: string | null;
  status: string;
  created_at: string | null;
  replayed_at: string | null;
}

export interface AuditEntry {
  id: number;
  actor_id: number | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | number | null;
  before: JsonValue;
  after: JsonValue;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface LogEntry {
  timestamp: string | null;
  level: string;
  message: string;
  unit: string | null;
  pid: string | number | null;
}

export interface LogsResponse {
  /** False on a host without journalctl — the entries are then a placeholder. */
  available: boolean;
  service: string;
  entries: LogEntry[];
}

export interface SafetyNetMetrics {
  hours: number;
  bot_id: number | null;
  totals: Record<string, number>;
  series: Record<string, Record<string, number>>;
}

export interface LangfuseSummary {
  configured: boolean;
  host: string | null;
  daily_metrics: JsonValue[];
  recent_traces: JsonValue[];
  scores: JsonValue[];
  error?: string;
}
