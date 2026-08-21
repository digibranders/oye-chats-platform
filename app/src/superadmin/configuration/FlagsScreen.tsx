import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LockedState,
  Section,
  Stack,
  Switch,
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
  describeFlagChange,
  isDangerousChange,
  partitionFlags,
  type FlagRow,
} from './flags-model';
import type { ConfigRow } from './types';

/**
 * Feature flags.
 *
 * A flag here is a switch on production: it takes effect for every customer, at
 * once, with the pricing cache invalidated on the way out. So the screen owes
 * three things and does nothing else.
 *
 * The current value is visible without opening anything. The consequence is
 * written next to the switch, in both directions, before it is touched. And
 * every flip confirms — with a destructive confirm only in the direction that
 * actually removes something, because a red dialog on every toggle teaches
 * people to click past it.
 */
interface PendingFlip {
  row: FlagRow;
  next: boolean;
}

/**
 * A flags console is a list of eight booleans, so it is a table.
 *
 * It was a three-column grid of cards, each holding a switch, a variable-length
 * sentence, the key, a "read by", a badge and a timestamp — so the internal
 * hairline landed at a different height in every card of a row, and eight rows
 * took 600px instead of 350. LaunchDarkly and Stripe both render this as a
 * table. The whenOn/whenOff sentence is a tooltip on the flag's name.
 */
function flagColumns(onFlip: (row: FlagRow, next: boolean) => void): readonly Column<FlagRow>[] {
  return [
    {
      key: 'label',
      header: 'Flag',
      rowHeader: true,
      render: (row) => {
        const name = row.spec?.label ?? row.key;
        const sentence = row.value ? (row.spec?.whenOn ?? 'On.') : (row.spec?.whenOff ?? 'Off.');
        return (
          <Tooltip content={sentence}>
            <span className="cursor-help font-medium underline decoration-dotted underline-offset-2">
              {name}
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: 'state',
      header: 'State',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <Badge tone={row.value ? 'success' : 'neutral'} dot>
            {row.value ? 'On' : 'Off'}
          </Badge>
          <Switch
            size="sm"
            label={row.spec?.label ?? row.key}
            hideLabel
            checked={row.value}
            onCheckedChange={(next) => onFlip(row, next)}
          />
        </div>
      ),
    },
    {
      key: 'read_by',
      header: 'Read by',
      secondary: true,
      render: (row) => row.spec?.readBy ?? null,
    },
    { key: 'key', header: 'Key', type: 'id', secondary: true, render: (row) => row.key },
    {
      key: 'updated_at',
      header: 'Changed',
      secondary: true,
      render: (row) => (row.updated_at ? formatDateTime(row.updated_at) : null),
    },
  ];
}

/**
 * The same table for a row this console cannot describe.
 *
 * An undocumented flag has no `spec`, so the documented column set gave it a
 * "Flag" column and a "Key" column printing the identical string, an entirely
 * blank "Read by" column, and a dotted-underline tooltip on its name whose only
 * content was the word "On." — twenty rows of a table where three of five
 * columns carried nothing.
 */
function undocumentedColumns(
  onFlip: (row: FlagRow, next: boolean) => void,
): readonly Column<FlagRow>[] {
  const documented = flagColumns(onFlip);
  const state = documented.find((column) => column.key === 'state');
  const changed = documented.find((column) => column.key === 'updated_at');
  return [
    {
      key: 'key',
      header: 'Flag',
      rowHeader: true,
      type: 'id',
      render: (row) => row.key,
    },
    ...(state ? [state] : []),
    ...(changed ? [changed] : []),
  ];
}

export function FlagsScreen() {
  const flags = usePlatformList<ConfigRow>('/feature-flags');
  const [pending, setPending] = useState<PendingFlip | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parts = useMemo(() => partitionFlags(flags.items), [flags.items]);
  const flip = useCallback((row: FlagRow, next: boolean) => setPending({ row, next }), []);
  const columns = useMemo(() => flagColumns(flip), [flip]);
  const looseColumns = useMemo(() => undocumentedColumns(flip), [flip]);

  async function commit(): Promise<void> {
    if (!pending) return;
    try {
      await platform.put(`/feature-flags/${encodeURIComponent(pending.row.key)}`, { value: pending.next });
      toast.success(
        `${pending.row.spec?.label ?? pending.row.key} turned ${pending.next ? 'on' : 'off'} for the whole platform.`,
      );
      setPending(null);
      flags.reload();
    } catch (cause) {
      setPending(null);
      setError(cause instanceof Error ? cause.message : 'The flag could not be changed.');
    }
  }

  if (flags.forbidden) {
    return <LockedState title={FORBIDDEN_TITLE} description={forbiddenDescription('the feature flags')} />;
  }

  const loading = flags.loading && flags.items.length === 0;
  const dangerous = pending ? isDangerousChange(pending.row.spec, pending.next) : false;

  return (
    <Stack>
      {error ? (
        <Alert tone="danger" live title="The flag was not changed">
          {error}
        </Alert>
      ) : null}

      <Section
        title="Switches"
        description="Each applies to every customer at once, within seconds. There is no per-account override and no staged rollout."
      >
        <DataTable
          caption="Feature flags this console can describe"
          columns={columns}
          rows={parts.known}
          rowKey={(row) => row.key}
          rowNoun="switch"
          rowNounPlural="switches"
          loading={loading}
          error={flags.error}
          onRetry={flags.reload}
          empty={
            <EmptyState
              title="No switch is stored"
              description="Every flag is running on its hardcoded default. Flipping one here writes the first row for it."
            />
          }
        />
      </Section>

      {parts.missing.length > 0 ? (
        <Alert tone="neutral" title="Some switches have no row yet">
          <p>
            They are running on the hardcoded default rather than an explicit value, which looks identical
            from here until somebody edits the default. Missing:{' '}
            <span className="figure">{parts.missing.map((spec) => spec.key).join(', ')}</span>.
          </p>
        </Alert>
      ) : null}

      {parts.undocumented.length > 0 ? (
        <Section
          title="Undocumented switches"
          description="Boolean rows nothing here can describe. Shown rather than hidden, and every flip is treated as destructive."
        >
          <DataTable
            caption="Boolean rows this console cannot describe"
            columns={looseColumns}
            rows={parts.undocumented}
            rowKey={(row) => row.key}
            rowNoun="switch"
            rowNounPlural="switches"
          />
        </Section>
      ) : null}

      {/* One hairline row, not three cards of chrome carrying one link each. */}
      <p className="text-xs text-text-tertiary">
        The flags endpoint is the pricing-config table under another name, so it also carries{' '}
        <span className="figure">{parts.elsewhere.pricing}</span> rows for{' '}
        <Link className={buttonClass('link')} to="/platform/catalogue/pricing">
          Credit pricing
        </Link>
        , <span className="figure">{parts.elsewhere.runtime}</span> for{' '}
        <Link className={buttonClass('link')} to="/platform/platform/runtime">
          Runtime
        </Link>{' '}
        and <span className="figure">{parts.elsewhere.content}</span> for{' '}
        <Link className={buttonClass('link')} to="/platform/catalogue/content">
          Pricing page copy
        </Link>
        .
      </p>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        destructive={dangerous}
        title={
          pending
            ? `Turn ${pending.row.spec?.label ?? pending.row.key} ${pending.next ? 'on' : 'off'} for everyone?`
            : 'Change this flag?'
        }
        confirmLabel={pending?.next ? 'Turn on' : 'Turn off'}
        onConfirm={commit}
        description={
          pending ? (
            <div className="space-y-2">
              <p>{describeFlagChange(pending.row.spec, pending.row.key, pending.next)}</p>
              <p className="figure text-xs">
                {pending.row.key}: {String(pending.row.value)} → {String(pending.next)}
              </p>
              <p className="text-xs">
                It applies to every customer immediately and is recorded in the audit log against your
                account.
              </p>
            </div>
          ) : null
        }
      />
    </Stack>
  );
}
