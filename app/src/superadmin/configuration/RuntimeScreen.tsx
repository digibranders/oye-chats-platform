import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Field,
  Input,
  LoadingRows,
  LockedState,
  Section,
  Select,
  Stack,
  Switch,
  toast,
  type SelectOption,
} from '../../ui';
import { platform } from '../client';
import { usePlatformResource } from '../usePlatform';
import {
  draftFromConfig,
  modelOptions,
  runtimePayload,
  validateRuntimeDraft,
  type RuntimeDraft,
} from './runtime-model';
import type { ModelConfig, ModelConfigWriteResult } from './types';

/**
 * The model and RAG runtime.
 *
 * Everything on this form is read on the next chat request, the next crawl and
 * the next upload — `runtime_config` caches it in memory and the write path
 * invalidates that cache. There is no deploy in between, which is the point of
 * the endpoint existing, and the reason the form confirms with a list of exactly
 * which keys are about to move.
 */
export function RuntimeScreen() {
  const config = usePlatformResource<ModelConfig>('/model-config');
  const [draft, setDraft] = useState<RuntimeDraft | null>(null);
  const [syncedFrom, setSyncedFrom] = useState<ModelConfig | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Derived during render rather than in an effect: an effect would paint an
  // empty form first and fill it a frame later, which reads as a form that lost
  // its values.
  if (config.data && config.data !== syncedFrom) {
    setSyncedFrom(config.data);
    setDraft(draftFromConfig(config.data));
    setShowErrors(false);
  }

  const errors = useMemo(() => (draft ? validateRuntimeDraft(draft) : {}), [draft]);
  const shown = showErrors ? errors : {};
  const payload = useMemo(
    () => (draft && config.data ? runtimePayload(draft, config.data) : {}),
    [draft, config.data],
  );
  const changedKeys = Object.keys(payload);

  function update(patch: Partial<RuntimeDraft>): void {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function attemptSave(): void {
    setSaveError(null);
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    if (changedKeys.length === 0) {
      toast('Nothing changed.');
      return;
    }
    setConfirmOpen(true);
  }

  async function commit(): Promise<void> {
    try {
      const result = await platform.put<ModelConfigWriteResult>('/model-config', payload);
      setConfirmOpen(false);
      toast.success(
        `${result.changed.length} setting${result.changed.length === 1 ? '' : 's'} applied. New requests pick them up within a few seconds.`,
      );
      config.reload();
    } catch (error) {
      setConfirmOpen(false);
      setSaveError(error instanceof Error ? error.message : 'The runtime could not be updated.');
    }
  }

  if (config.forbidden) {
    return (
      <LockedState
        title="You cannot read the runtime configuration"
        description="Your super-admin account is not permitted to load it. Nothing was changed."
      />
    );
  }

  if (config.loading && !config.data) {
    return (
      <Card>
        <CardBody>
          <LoadingRows rows={6} />
        </CardBody>
      </Card>
    );
  }

  if (config.error && !config.data) {
    return (
      <Alert
        tone="danger"
        title="The runtime configuration could not be loaded"
        action={
          <Button size="sm" onClick={config.reload}>
            Try again
          </Button>
        }
      >
        {config.error}
      </Alert>
    );
  }

  if (!config.data || !draft) return null;

  const models: SelectOption[] = modelOptions(config.data, draft.primary_model);
  const fallbackModels: SelectOption[] = modelOptions(config.data, draft.fallback_model);
  const gateModels: SelectOption[] = modelOptions(config.data, draft.gate_model);
  const crawlProviders: SelectOption[] = config.data.known_crawl_providers.map((provider) => ({
    value: provider.id,
    label: provider.label,
  }));
  const activeProviderNote = config.data.known_crawl_providers.find(
    (provider) => provider.id === draft.crawl_provider_primary,
  )?.notes;

  return (
    <Stack>
      <Alert tone="warning" title="These take effect without a deploy">
        The values are cached in memory for a few seconds and the save clears that cache, so the next chat,
        crawl and upload use them. A bad chunk pair here is an ingestion outage, not a rejected form.
      </Alert>

      {saveError ? (
        <Alert tone="danger" live title="Nothing was changed">
          {saveError}
        </Alert>
      ) : null}

      <Section title="Models" description="LiteLLM routes to the primary and falls back on failure.">
        <Card>
          <CardBody className="grid gap-4 md:grid-cols-3">
            <Field label="Primary model" error={shown.primary_model} hint="Every customer-facing completion.">
              <Select
                options={models}
                value={draft.primary_model}
                onChange={(event) => update({ primary_model: event.target.value })}
              />
            </Field>
            <Field
              label="Fallback model"
              error={shown.fallback_model}
              hint="Used when the primary errors. Pointing both at one provider removes the fallback."
            >
              <Select
                options={fallbackModels}
                value={draft.fallback_model}
                onChange={(event) => update({ fallback_model: event.target.value })}
              />
            </Field>
            <Field label="Gate model" error={shown.gate_model} hint="The relevance gate and chunk enrichment.">
              <Select
                options={gateModels}
                value={draft.gate_model}
                onChange={(event) => update({ gate_model: event.target.value })}
              />
            </Field>
          </CardBody>
          {draft.primary_model === draft.fallback_model ? (
            <CardBody className="border-t border-border">
              <Alert tone="warning" title="Primary and fallback are the same model">
                A provider outage would take both routes down together.
              </Alert>
            </CardBody>
          ) : null}
        </Card>
      </Section>

      <Section
        title="Retrieval"
        description="Chunking is applied at ingestion, so a change here affects documents indexed after it, not the corpus already stored."
      >
        <Card>
          <CardBody className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Chunk size" error={shown.chunk_size} hint="200 to 8,000 characters.">
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.chunk_size}
                onChange={(event) => update({ chunk_size: event.target.value })}
              />
            </Field>
            <Field
              label="Chunk overlap"
              error={shown.chunk_overlap}
              hint="0 to 2,000, and always below the chunk size."
            >
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.chunk_overlap}
                onChange={(event) => update({ chunk_overlap: event.target.value })}
              />
            </Field>
            <Field label="Rerank top N" error={shown.rerank_top_n} hint="1 to 20 chunks kept after reranking.">
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.rerank_top_n}
                onChange={(event) => update({ rerank_top_n: event.target.value })}
              />
            </Field>
            <Field
              label="Relevance threshold"
              error={shown.relevance_threshold}
              hint="0 to 1. Higher discards more retrieved context."
            >
              <Input
                className="figure"
                inputMode="decimal"
                value={draft.relevance_threshold}
                onChange={(event) => update({ relevance_threshold: event.target.value })}
              />
            </Field>
            <Field
              label="Embedding concurrency"
              error={shown.embed_concurrency}
              hint="1 to 64 parallel embedding calls. Bounded by the provider's rate limit, not by this."
            >
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.embed_concurrency}
                onChange={(event) => update({ embed_concurrency: event.target.value })}
              />
            </Field>
          </CardBody>
        </Card>
      </Section>

      <Section title="Crawler" description="The fallback provider is always the other one; it is not separately settable.">
        <Card>
          <CardBody className="grid gap-4 md:grid-cols-3">
            <Field label="Primary provider" hint={activeProviderNote}>
              <Select
                options={crawlProviders}
                value={draft.crawl_provider_primary}
                onChange={(event) => update({ crawl_provider_primary: event.target.value })}
              />
            </Field>
            <Field
              label="Jina concurrency"
              error={shown.jina_fetch_concurrency}
              hint="1 to 50 parallel reader fetches."
            >
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.jina_fetch_concurrency}
                onChange={(event) => update({ jina_fetch_concurrency: event.target.value })}
              />
            </Field>
            <Field
              label="Spider concurrency"
              error={shown.spider_fetch_concurrency}
              hint="1 to 50 parallel scraper fetches."
            >
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.spider_fetch_concurrency}
                onChange={(event) => update({ spider_fetch_concurrency: event.target.value })}
              />
            </Field>
          </CardBody>
          <CardBody className="border-t border-border">
            <p className="text-xs text-text-secondary">
              Fallback provider:{' '}
              <span className="figure text-text-primary">{config.data.crawler.fallback_provider}</span>
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Support impersonation"
        description="The runtime half of the kill switch. The environment variable is a floor this cannot lift."
      >
        <Card>
          <CardBody>
            <Switch
              label="Impersonation enabled"
              description={
                config.data.impersonation.locked_by_env
                  ? 'Refused by IMPERSONATION_ENABLED in the environment. The switch cannot turn it back on from here — that needs a deploy.'
                  : 'Lets a super-admin act as a customer for support. Turning it off ends the ability to start new sessions immediately.'
              }
              checked={draft.impersonation_enabled}
              disabled={config.data.impersonation.locked_by_env}
              onCheckedChange={(checked) => update({ impersonation_enabled: checked })}
            />
            {config.data.impersonation.locked_by_env ? (
              <Badge tone="neutral" className="mt-3">
                Locked by the environment
              </Badge>
            ) : null}
          </CardBody>
        </Card>
      </Section>

      <Card>
        <CardHeader
          titleAs="h2"
          title="Apply"
          description="Only the settings that moved are written, so the audit log records the change and nothing else."
          actions={
            <Button variant="primary" disabled={changedKeys.length === 0} onClick={attemptSave}>
              {changedKeys.length === 0
                ? 'No changes'
                : `Apply ${changedKeys.length} change${changedKeys.length === 1 ? '' : 's'}`}
            </Button>
          }
        />
        {changedKeys.length > 0 ? (
          <CardBody>
            <p className="figure text-xs text-text-secondary">{changedKeys.join(', ')}</p>
          </CardBody>
        ) : null}
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Change the live runtime?"
        confirmLabel="Apply now"
        onConfirm={commit}
        description={
          <div className="space-y-2">
            <p>
              These values are read by the next request. Nothing is queued, staged or reversible except by
              changing them back.
            </p>
            <ul className="figure list-disc space-y-0.5 pl-4 text-xs">
              {changedKeys.map((key) => (
                <li key={key}>
                  {key}: {String(payload[key])}
                </li>
              ))}
            </ul>
          </div>
        }
      />
    </Stack>
  );
}
