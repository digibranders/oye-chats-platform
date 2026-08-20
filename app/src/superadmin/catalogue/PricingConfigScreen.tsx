import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  LockedState,
  PropertyGrid,
  Section,
  Stack,
  Textarea,
  Tooltip,
  buttonClass,
  formatDateTime,
  toast,
  type Column,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList } from '../usePlatform';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
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

/**
 * The price list, as a table.
 *
 * "What it does" is truncated with the whole sentence on a tooltip: it is a
 * caveat a reader needs once, and it was costing three of the five lines every
 * row spent.
 */
function moneyColumns(onEdit: (row: PricingConfigRow) => void): readonly Column<PricingConfigRow>[] {
  return [
    {
      key: 'label',
      header: 'Key',
      rowHeader: true,
      render: (row) => {
        const spec = specFor(row.key);
        const note = spec?.description
          ? `${spec.description} Read by ${spec.readBy}`
          : 'Undocumented key. Nothing in this console knows what reads it.';
        return (
          <Tooltip content={note}>
            <span className="cursor-help font-medium underline decoration-dotted underline-offset-2">
              {spec?.label ?? row.key}
            </span>
          </Tooltip>
        );
      },
    },
    { key: 'key', header: 'Stored as', type: 'id', secondary: true, render: (row) => row.key },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      render: (row) => <span className="figure font-medium">{formatConfigValue(row.value)}</span>,
    },
    {
      key: 'unit',
      header: 'Unit',
      secondary: true,
      render: (row) => specFor(row.key)?.unit ?? null,
    },
    {
      key: 'updated_at',
      header: 'Changed',
      secondary: true,
      render: (row) => (row.updated_at ? formatDateTime(row.updated_at) : null),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="ghost" onClick={() => onEdit(row)}>
          Change
        </Button>
      ),
    },
  ];
}

function unknownColumns(onEdit: (row: PricingConfigRow) => void): readonly Column<PricingConfigRow>[] {
  return [
    { key: 'key', header: 'Key', rowHeader: true, type: 'id', render: (row) => row.key },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      render: (row) => <span className="figure">{formatConfigValue(row.value)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="ghost" onClick={() => onEdit(row)}>
          Edit raw
        </Button>
      ),
    },
  ];
}

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
  const moneyCols = useMemo(() => moneyColumns(openEditor), []);
  const unknownCols = useMemo(() => unknownColumns(openEditor), []);

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
        title={FORBIDDEN_TITLE}
        description={forbiddenDescription('the pricing configuration')}
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
        {/* A price list is a table. It was a `<ul>` of five-line rows at about
            110px each, so ten keys were an 1,100px scroll. */}
        <DataTable
          caption="Credit pricing keys"
          columns={moneyCols}
          rows={parts.money}
          rowKey={(row) => row.key}
          rowNoun="key"
          loading={loading}
          error={config.error}
          onRetry={config.reload}
          empty={
            <EmptyState
              title="No pricing keys are stored"
              description="Every read falls back to the hardcoded defaults. Seed them to make the live prices explicit."
            />
          }
        />

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
          <DataTable
            caption="Undocumented pricing keys"
            columns={unknownCols}
            rows={parts.unknown}
            rowKey={(row) => row.key}
            rowNoun="key"
          />
        </Section>
      ) : null}

      {/* One hairline row, not three cards of chrome carrying one link each. */}
      <p className="text-xs text-text-tertiary">
        pricing_config is one key/value store doing several jobs, and the rest of it is validated
        elsewhere: <span className="figure">{parts.switches.length}</span> switches in{' '}
        <Link className={buttonClass('link')} to="/platform/platform">
          Flags
        </Link>
        , <span className="figure">{parts.runtime.length}</span> in{' '}
        <Link className={buttonClass('link')} to="/platform/platform/runtime">
          Runtime
        </Link>{' '}
        and <span className="figure">{parts.content.length}</span> in{' '}
        <Link className={buttonClass('link')} to="/platform/catalogue/content">
          Pricing page copy
        </Link>
        .
      </p>

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setTarget(null);
        }}
        dismissible={!saving}
        title={target?.spec?.label ?? target?.key ?? 'Change value'}
        description={
          target?.spec
            ? `${target.key} — read by ${target.spec.readBy} The save clears the pricing cache, so the next charge uses the new value.`
            : `${target?.key ?? ''} — nothing here knows what reads it.`
        }
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
            <PropertyGrid
              density="compact"
              items={[
                {
                  label: 'Currently',
                  value: <span className="figure">{formatConfigValue(target.current)}</span>,
                },
              ]}
            />

            {target.spec?.kind === 'json' || target.spec === undefined ? (
              <Field
                label="New value (JSON)"
                error={error}
                hint="Stored verbatim — a wrong shape is only discovered by whatever reads it."
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
              <Alert tone="warning">
                A pack must appear in this list to be purchasable at all — removing one withdraws it
                from sale.
              </Alert>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </Stack>
  );
}
