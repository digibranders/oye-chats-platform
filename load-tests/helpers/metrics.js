// Custom k6 metrics, shared across scenarios so dashboards and result parsing
// see stable metric names.
import { Trend, Rate, Counter } from 'k6/metrics';

// Chat latency, split so we can separate "think time before first token" from
// "total generation" — the two degrade differently as concurrency rises.
export const chatTTFB = new Trend('chat_time_to_first_byte', true); // ms to METADATA/first byte
export const chatTotal = new Trend('chat_total_stream_ms', true); // ms full stream

// Journey/aggregate error rate independent of k6's http_req_failed so a failed
// application-level check (not just a non-2xx) counts.
export const errors = new Rate('journey_errors');
export const requests = new Counter('journey_requests');

// Real-LLM cost/behaviour counters (Phase 8A). Populated only by the real-LLM
// scenario; zero elsewhere. Token counts come from the response body when the
// API echoes usage, else stay 0 and are reported as "unavailable".
export const llmRequests = new Counter('llm_requests');
export const llmRetries = new Counter('llm_retries');
export const llm429 = new Counter('llm_rate_limited');
export const llmFallbacks = new Counter('llm_fallbacks');
export const llmPromptTokens = new Counter('llm_prompt_tokens');
export const llmCompletionTokens = new Counter('llm_completion_tokens');
