import type { ModelConfig } from './types';

/**
 * The runtime knobs — models, RAG, the crawler — as a draft with rules.
 *
 * Every bound below is one `ModelConfigPatch` declares, plus the one it validates
 * across fields: `chunk_overlap` must stay under `chunk_size`. That check exists
 * because the failure is not a rejected request, it is an uncaught `ValueError`
 * inside `RecursiveCharacterTextSplitter` on the next upload or crawl — a
 * platform-wide ingestion outage produced by two separately-valid saves. The
 * editor therefore validates the *effective* pair, exactly as the handler does.
 */

export interface RuntimeDraft {
  primary_model: string;
  fallback_model: string;
  gate_model: string;
  chunk_size: string;
  chunk_overlap: string;
  rerank_top_n: string;
  relevance_threshold: string;
  embed_concurrency: string;
  crawl_provider_primary: string;
  jina_fetch_concurrency: string;
  spider_fetch_concurrency: string;
  impersonation_enabled: boolean;
}

export function draftFromConfig(config: ModelConfig): RuntimeDraft {
  return {
    primary_model: config.primary_model,
    fallback_model: config.fallback_model,
    gate_model: config.gate_model,
    chunk_size: String(config.rag.chunk_size),
    chunk_overlap: String(config.rag.chunk_overlap),
    rerank_top_n: String(config.rag.rerank_top_n),
    relevance_threshold: String(config.rag.relevance_threshold),
    embed_concurrency: String(config.embed.concurrency),
    crawl_provider_primary: config.crawler.primary_provider,
    jina_fetch_concurrency: String(config.crawler.jina_fetch_concurrency),
    spider_fetch_concurrency: String(config.crawler.spider_fetch_concurrency),
    impersonation_enabled: config.impersonation.enabled,
  };
}

function integer(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decimal(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** LiteLLM ids are a vendor's catalogue, so the shape is bounded, not enumerated. */
const MODEL_ID = /^[a-zA-Z0-9._/-]{1,128}$/;

export function validateRuntimeDraft(draft: RuntimeDraft): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const key of ['primary_model', 'fallback_model', 'gate_model'] as const) {
    const value = draft[key].trim();
    if (!value) errors[key] = 'A model id is required.';
    else if (!MODEL_ID.test(value))
      errors[key] = 'Letters, digits, dot, underscore, slash and hyphen only, up to 128 characters.';
  }

  const bounded: [keyof RuntimeDraft, string, number, number][] = [
    ['chunk_size', 'Chunk size', 200, 8000],
    ['chunk_overlap', 'Chunk overlap', 0, 2000],
    ['rerank_top_n', 'Rerank top N', 1, 20],
    ['embed_concurrency', 'Embedding concurrency', 1, 64],
    ['jina_fetch_concurrency', 'Jina concurrency', 1, 50],
    ['spider_fetch_concurrency', 'Spider concurrency', 1, 50],
  ];
  for (const [key, label, min, max] of bounded) {
    const value = integer(draft[key] as string);
    if (value === null) errors[key] = `${label} must be a whole number.`;
    else if (value < min || value > max) errors[key] = `${label} must be between ${min} and ${max}.`;
  }

  const threshold = decimal(draft.relevance_threshold);
  if (threshold === null) errors.relevance_threshold = 'Enter a number between 0 and 1.';
  else if (threshold < 0 || threshold > 1) errors.relevance_threshold = 'Between 0 and 1.';

  // The cross-field rule, and the reason this whole module exists.
  const size = integer(draft.chunk_size);
  const overlap = integer(draft.chunk_overlap);
  if (size !== null && overlap !== null && overlap >= size)
    errors.chunk_overlap = `Overlap must be below chunk size (${size}). This pair would crash ingestion on the next upload or crawl.`;

  return errors;
}

/**
 * The PUT body — only the fields that moved.
 *
 * Every key present is written and audited, so echoing an unchanged value would
 * put a no-op edit in the audit log next to the one that mattered.
 */
export function runtimePayload(draft: RuntimeDraft, config: ModelConfig): Record<string, unknown> {
  const current = draftFromConfig(config);
  const payload: Record<string, unknown> = {};

  for (const key of ['primary_model', 'fallback_model', 'gate_model', 'crawl_provider_primary'] as const) {
    if (draft[key].trim() !== current[key]) payload[key] = draft[key].trim();
  }
  for (const key of [
    'chunk_size',
    'chunk_overlap',
    'rerank_top_n',
    'embed_concurrency',
    'jina_fetch_concurrency',
    'spider_fetch_concurrency',
  ] as const) {
    if (draft[key].trim() !== current[key]) payload[key] = integer(draft[key]);
  }
  if (draft.relevance_threshold.trim() !== current.relevance_threshold)
    payload.relevance_threshold = decimal(draft.relevance_threshold);
  if (draft.impersonation_enabled !== current.impersonation_enabled)
    payload.impersonation_enabled = draft.impersonation_enabled;

  return payload;
}

/** Model options for a select, with the vendor's own id kept visible. */
export function modelOptions(config: ModelConfig | null, current: string) {
  const known = (config?.known_models ?? []).map((model) => ({
    value: model.id,
    label: `${model.label} · ${model.provider} · ${model.tier}`,
  }));
  // A model that is in force but not in the catalogue must still be selectable,
  // or opening this form and pressing Save would silently move production off it.
  if (current && !known.some((option) => option.value === current))
    known.unshift({ value: current, label: `${current} · in force, not in the catalogue` });
  return known;
}
