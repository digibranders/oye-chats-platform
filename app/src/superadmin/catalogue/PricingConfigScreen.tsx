import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingRows,
  LockedState,
  Section,
  Stack,
  Textarea,
  buttonClass,
  formatDateTime,
  toast,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList } from '../usePlatform';
import {
  formatConfigValue,
  parseConfigValue,
  partitionConfig,
  specFor,
  type PricingKeySpec,
} from './pricing-keys';
import type { JsonValue, PricingConfigRow } from './types';

/**
 * The credit economics.
 *
 * `pricing_config` is the live price list. `credit_service` reads it through a
 * sixty-second in-memory cache, and the write path invalidates that cache, so a
 * value changed here is charging differently within seconds — on the widget, in
 * ingestion, and in the top-up checkout. Nothing about that is visible from the
 * key name, so every row states what it does and which code path reads it.
 *
 * The screen deliberately shows less than the endpoint returns. `pricing-config`
 * is one table serving five jobs; the switches, the model knobs and the public
 * pricing copy each have an owner elsewhere that validates them properly, and
 * they are listed here as pointers rather than as editable rows.
 */

interface EditTarget {
  key: string;
  spec?: PricingKeySpec;
  current: JsonValue;
}

function initialText(value: JsonValue, kind: PricingKeySpec['kind'] | undefined): string {
  if (kind === 'json' || (typeof value === 'object' && value !== null)) return JSON.stringify(value, null, 2);
  if (value === null || value === undefined) return '';
  return String(value);
}

export function PricingConfigScreen() {
  const config = usePlatformList<PricingConfigRow>('/pricing-config');
  const [target, setTarget] = useState<EditTarget | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const parts = useMemo(() => partitionConfig(config.items), [config.items]);

  function openEditor(row: PricingConfigRow): void {
    const spec = specFor(row.key);
    setTarget({ key: row.key, spec, current: row.value });
    setText(initialText(row.value, spec?.kind));
    setError(null);
  }

  async function save(): Promise<void> {
    if (!target) return;
    const kind = target.spec?.kind ?? 'json';
    const parsed = parseConfigValue(kind, text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await platform.put(`/pricing-config/${encodeURIComponent(target.key)}`, { value: parsed.value });
      toast.success(`${target.spec?.label ?? target.key} updated. The pricing cache was cleared.`);
      setTarget(null);
      config.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The value could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  if (config.forbidden) {
    return (
      <LockedState
        title="You cannot read the pricing configuration"
        description="Your super-admin account is not permitted to load these keys. Nothing was changed."
      />
    );
  }

  const loading = config.loading && config.items.length === 0;

  return (
    <Stack>
      <Alert tone="warning" title="These values are the live price list">
        <span className="figure">credit_service</span> reads them behind a sixty-second cache that the save
        path clears, so a change is charging within seconds. There is no versioning here and no scheduled
        change: the value you write is the value the next chat, crawl and upload is billed at.
      </Alert>

      <Section
        title="Credit costs and balance behaviour"
        description="Every key the credit ledger reads, with the path that reads it."
      >
        <Card>
          {loading ? (
            <CardBody>
              <LoadingRows rows={6} />
            </CardBody>
          ) : config.error ? (
            <CardBody>
              <Alert tone="danger" title="These keys could not be loaded" action={<Button size="sm" onClick={config.reload}>Try again</Button>}>
                {config.error}
              </Alert>
            </CardBody>
          ) : parts.money.length === 0 ? (
            <EmptyState
              title="No pricing keys are stored"
              description="Every read falls back to the hardcoded defaults in credit_service. Run scripts/seed_pricing_config.py --apply to make the live prices explicit."
            />
          ) : (
            <ul>
              {parts.money.map((row) => {
                const spec = specFor(row.key);
                return (
                  <li key={row.key} className="border-b border-border px-5 py-4 last:border-b-0">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-base font-medium text-text-primary">{spec?.label ?? row.key}</p>
                        <p className="figure mt-0.5 text-2xs text-text-tertiary">{row.key}</p>
                        <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
                          {spec?.description ?? 'Undocumented key. Nothing in this console knows what reads it.'}
                        </p>
                        {spec ? (
                          <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
                            Read by {spec.readBy}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <div className="text-right">
                          <p className="figure text-lg font-semibold text-text-primary">
                            {formatConfigValue(row.value)}
                            {spec?.unit ? (
                              <span className="ml-1 text-xs font-normal text-text-tertiary">{spec.unit}</span>
                            ) : null}
                          </p>
                          <p className="text-2xs text-text-tertiary">
                            {row.updated_at ? `Changed ${formatDateTime(row.updated_at)}` : 'Never changed here'}
                          </p>
                        </div>
                        <Button size="sm" onClick={() => openEditor(row)}>
                          Change
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {parts.missingMoneyKeys.length > 0 ? (
          <Alert tone="warning" className="mt-3" title="Some documented keys have no row">
            <p>
              A missing key is not the same as a key set to its default:{' '}
              <span className="figure">credit_service</span> falls back to a hardcoded value, and the two look
              identical from here until someone edits the fallback. Missing:{' '}
              <span className="figure">{parts.missingMoneyKeys.map((spec) => spec.key).join(', ')}</span>.
            </p>
          </Alert>
        ) : null}
      </Section>

      {parts.unknown.length > 0 ? (
        <Section
          title="Undocumented keys"
          description="Rows in the table this console has no description for. They are shown rather than hidden, and edited as raw JSON."
        >
          <Card>
            <ul>
              {parts.unknown.map((row) => (
                <li
                  key={row.key}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-b-0"
                >
                  <span className="figure min-w-0 text-sm text-text-primary">{row.key}</span>
                  <span className="flex items-center gap-3">
                    <span className="figure text-xs text-text-secondary">{formatConfigValue(row.value)}</span>
                    <Button size="sm" variant="ghost" onClick={() => openEditor(row)}>
                      Edit raw
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      ) : null}

      <Section
        title="Also in this table, owned elsewhere"
        description="pricing_config is one key/value store doing several jobs. These keys have a screen that validates them; editing them raw here would bypass it."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Card>
            <CardHeader
              titleAs="h3"
              title="Switches"
              description="Booleans that turn behaviour off platform-wide."
            />
            <CardBody>
              <p className="text-xs text-text-secondary">
                {parts.switches.length > 0
                  ? parts.switches.map((row) => row.key).join(', ')
                  : 'None stored — every switch is at its default.'}
              </p>
              <Link className={`${buttonClass('link')} mt-2`} to="/platform/platform?view=flags">
                Configuration → Flags
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              titleAs="h3"
              title="Model and RAG"
              description="Written by the model-config endpoint, which cross-validates them."
            />
            <CardBody>
              <p className="text-xs text-text-secondary">
                {parts.runtime.length > 0
                  ? `${parts.runtime.length} key${parts.runtime.length === 1 ? '' : 's'} stored.`
                  : 'None stored — the runtime is on its environment defaults.'}
              </p>
              <Link className={`${buttonClass('link')} mt-2`} to="/platform/platform?view=runtime">
                Configuration → Runtime
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              titleAs="h3"
              title="Pricing page copy"
              description="Rendered on the public site. Edited through the validated content endpoint."
            />
            <CardBody>
              <p className="text-xs text-text-secondary">
                {parts.content.length > 0
                  ? parts.content.map((row) => row.key).join(', ')
                  : 'None stored — the pricing page renders its own defaults.'}
              </p>
              <Link className={`${buttonClass('link')} mt-2`} to="/platform/catalogue?view=content">
                Pricing page copy
              </Link>
            </CardBody>
          </Card>
        </div>
      </Section>

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setTarget(null);
        }}
        dismissible={!saving}
        title={target?.spec?.label ?? target?.key ?? 'Change value'}
        description={target?.key}
        footer={
          <>
            <Button variant="ghost" disabled={saving} onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Change the live price
            </Button>
          </>
        }
      >
        {target ? (
          <div className="flex flex-col gap-4">
            <Alert tone="warning" title="This takes effect immediately">
              {target.spec
                ? `Read by ${target.spec.readBy} The save clears the pricing cache, so the next charge uses the new value.`
                : 'Nothing in this console knows what reads this key. Whatever does will pick the new value up within a minute.'}
            </Alert>

            <div className="rounded-md border border-border bg-surface-sunken px-3 py-2.5">
              <p className="text-2xs uppercase tracking-eyebrow text-text-tertiary">Currently</p>
              <p className="figure mt-0.5 text-sm text-text-primary">{formatConfigValue(target.current)}</p>
            </div>

            {target.spec?.kind === 'json' || target.spec === undefined ? (
              <Field
                label="New value (JSON)"
                error={error}
                hint="Stored verbatim. The endpoint accepts any JSON, so a wrong shape is only discovered by whatever reads it."
              >
                <Textarea rows={10} className="figure" value={text} onChange={(event) => setText(event.target.value)} />
              </Field>
            ) : (
              <Field
                label={`New value${target.spec.unit ? ` (${target.spec.unit})` : ''}`}
                error={error}
                hint={target.spec.description}
              >
                <Input
                  className="figure"
                  inputMode={target.spec.kind === 'integer' ? 'numeric' : 'text'}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </Field>
            )}

            {target.spec?.key === 'topup_packs' ? (
              <Badge tone="warning">
                A pack must appear in this list to be purchasable at all — removing one withdraws it from sale.
              </Badge>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </Stack>
  );
}
