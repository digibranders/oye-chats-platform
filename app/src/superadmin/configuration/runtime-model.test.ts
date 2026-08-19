import { describe, expect, it } from 'vitest';
import { draftFromConfig, modelOptions, runtimePayload, validateRuntimeDraft } from './runtime-model';
import type { ModelConfig } from './types';

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    primary_model: 'openai/gpt-5.4-mini',
    fallback_model: 'gemini/gemini-2.5-flash',
    gate_model: 'gemini/gemini-2.5-flash',
    rag: { chunk_size: 1000, chunk_overlap: 200, rerank_top_n: 5, relevance_threshold: 0.5 },
    embed: { concurrency: 8 },
    crawler: {
      primary_provider: 'spider',
      fallback_provider: 'jina',
      jina_fetch_concurrency: 5,
      spider_fetch_concurrency: 10,
    },
    impersonation: { enabled: true, locked_by_env: false },
    known_models: [
      { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'OpenAI', tier: 'fast' },
      { id: 'gemini/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google', tier: 'fast' },
    ],
    known_crawl_providers: [
      { id: 'spider', label: 'Spider.cloud', notes: 'Bulk scraper.' },
      { id: 'jina', label: 'Jina Reader', notes: 'Markdown reader.' },
    ],
    ...overrides,
  };
}

describe('validation', () => {
  it('accepts the running configuration unchanged', () => {
    expect(validateRuntimeDraft(draftFromConfig(config()))).toEqual({});
  });

  it('refuses an overlap at or above the chunk size — the pair that crashes ingestion', () => {
    const draft = { ...draftFromConfig(config()), chunk_overlap: '1000' };
    expect(validateRuntimeDraft(draft).chunk_overlap).toMatch(/below chunk size/i);
  });

  it('catches the cross-field failure even when each value is individually legal', () => {
    // 500 is a valid overlap and 300 a valid size; together they are an outage.
    const draft = { ...draftFromConfig(config()), chunk_size: '300', chunk_overlap: '500' };
    expect(validateRuntimeDraft(draft).chunk_size).toBeUndefined();
    expect(validateRuntimeDraft(draft).chunk_overlap).toBeTruthy();
  });

  it('bounds every numeric knob the way the API does', () => {
    expect(validateRuntimeDraft({ ...draftFromConfig(config()), chunk_size: '10' }).chunk_size).toBeTruthy();
    expect(validateRuntimeDraft({ ...draftFromConfig(config()), rerank_top_n: '99' }).rerank_top_n).toBeTruthy();
    expect(
      validateRuntimeDraft({ ...draftFromConfig(config()), embed_concurrency: '0' }).embed_concurrency,
    ).toBeTruthy();
    expect(
      validateRuntimeDraft({ ...draftFromConfig(config()), spider_fetch_concurrency: '51' })
        .spider_fetch_concurrency,
    ).toBeTruthy();
  });

  it('keeps the relevance threshold inside 0 and 1', () => {
    expect(
      validateRuntimeDraft({ ...draftFromConfig(config()), relevance_threshold: '1.5' }).relevance_threshold,
    ).toBeTruthy();
    expect(
      validateRuntimeDraft({ ...draftFromConfig(config()), relevance_threshold: '0.75' })
        .relevance_threshold,
    ).toBeUndefined();
  });

  it('refuses an empty or malformed model id', () => {
    expect(validateRuntimeDraft({ ...draftFromConfig(config()), primary_model: '' }).primary_model).toBeTruthy();
    expect(
      validateRuntimeDraft({ ...draftFromConfig(config()), gate_model: 'gpt 5 mini' }).gate_model,
    ).toBeTruthy();
  });
});

describe('the payload', () => {
  it('is empty when nothing moved', () => {
    expect(runtimePayload(draftFromConfig(config()), config())).toEqual({});
  });

  it('carries only what changed, so the audit log records one thing', () => {
    const draft = { ...draftFromConfig(config()), chunk_size: '1200' };
    expect(runtimePayload(draft, config())).toEqual({ chunk_size: 1200 });
  });

  it('sends the threshold as a number, not as the typed string', () => {
    const draft = { ...draftFromConfig(config()), relevance_threshold: '0.75' };
    expect(runtimePayload(draft, config())).toEqual({ relevance_threshold: 0.75 });
  });

  it('sends the impersonation switch only when it is flipped', () => {
    const draft = { ...draftFromConfig(config()), impersonation_enabled: false };
    expect(runtimePayload(draft, config())).toEqual({ impersonation_enabled: false });
  });

  it('trims a model id rather than resending the same value with whitespace', () => {
    const draft = { ...draftFromConfig(config()), primary_model: ' openai/gpt-5.4-mini ' };
    expect(runtimePayload(draft, config())).toEqual({});
  });
});

describe('model options', () => {
  it('lists the catalogue the API supplies', () => {
    expect(modelOptions(config(), 'openai/gpt-5.4-mini').map((option) => option.value)).toEqual([
      'openai/gpt-5.4-mini',
      'gemini/gemini-2.5-flash',
    ]);
  });

  it('keeps a model that is in force but missing from the catalogue selectable', () => {
    // Otherwise opening the form and pressing Save silently moves production
    // off the model it is actually running.
    const options = modelOptions(config(), 'anthropic/claude-haiku-4.5');
    expect(options[0].value).toBe('anthropic/claude-haiku-4.5');
    expect(options[0].label).toMatch(/in force/i);
  });

  it('survives a config that has not loaded yet', () => {
    expect(modelOptions(null, '')).toEqual([]);
  });
});
