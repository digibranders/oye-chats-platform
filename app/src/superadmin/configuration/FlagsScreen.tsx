import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  LoadingRows,
  LockedState,
  Section,
  Stack,
  Switch,
  buttonClass,
  formatDateTime,
  toast,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList } from '../usePlatform';
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

function FlagCard({ row, onFlip }: { row: FlagRow; onFlip: (next: boolean) => void }) {
  const spec = row.spec;
  return (
    <Card>
      <CardBody>
        <Switch
          label={spec?.label ?? row.key}
          description={row.value ? (spec?.whenOn ?? 'On.') : (spec?.whenOff ?? 'Off.')}
          checked={row.value}
          onCheckedChange={onFlip}
        />
        <div className="mt-3 border-t border-border pt-2.5">
          <p className="figure text-2xs text-text-tertiary">{row.key}</p>
          {spec ? <p className="mt-1 text-xs text-text-secondary">Read by {spec.readBy}</p> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={row.value ? 'success' : 'neutral'} dot>
              {row.value ? 'On' : 'Off'}
            </Badge>
            <span className="text-2xs text-text-tertiary">
              {row.updated_at ? `Changed ${formatDateTime(row.updated_at)}` : 'Never changed here'}
            </span>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

export function FlagsScreen() {
  const flags = usePlatformList<ConfigRow>('/feature-flags');
  const [pending, setPending] = useState<PendingFlip | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parts = useMemo(() => partitionFlags(flags.items), [flags.items]);

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
    return (
      <LockedState
        title="You cannot read the feature flags"
        description="Your super-admin account is not permitted to load them. Nothing was changed."
      />
    );
  }

  const loading = flags.loading && flags.items.length === 0;
  const dangerous = pending ? isDangerousChange(pending.row.spec, pending.next) : false;

  return (
    <Stack>
      <Alert tone="warning" title="A flag here is a switch on production">
        Each one applies to every customer at once, regardless of their plan, and the save clears the config
        cache so it lands within seconds. There is no per-account override and no staged rollout.
      </Alert>

      {error ? (
        <Alert tone="danger" live title="The flag was not changed">
          {error}
        </Alert>
      ) : null}

      <Section title="Switches" description="The boolean rows this console knows how to explain.">
        {loading ? (
          <Card>
            <CardBody>
              <LoadingRows rows={3} />
            </CardBody>
          </Card>
        ) : flags.error ? (
          <Card>
            <CardBody>
              <Alert
                tone="danger"
                title="The flags could not be loaded"
                action={
                  <Button size="sm" onClick={flags.reload}>
                    Try again
                  </Button>
                }
              >
                {flags.error}
              </Alert>
            </CardBody>
          </Card>
        ) : parts.known.length === 0 ? (
          <Card>
            <EmptyState
              title="No switch is stored"
              description="Every flag is running on the hardcoded default in credit_service. Flipping one from here writes the first row for it."
            />
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {parts.known.map((row) => (
              <FlagCard key={row.key} row={row} onFlip={(next) => setPending({ row, next })} />
            ))}
          </div>
        )}
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
          description="Boolean rows nothing in this console can describe. They are shown rather than hidden, and every flip is treated as destructive."
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {parts.undocumented.map((row) => (
              <FlagCard key={row.key} row={row} onFlip={(next) => setPending({ row, next })} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="Not shown here"
        description="The flags endpoint is the pricing-config table under another name, so the response also carries rows that belong to other screens."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Card>
            <CardHeader titleAs="h3" title="Credit economics" description="Numeric prices and the top-up packs." />
            <CardBody>
              <p className="figure text-lg font-semibold text-text-primary">{parts.elsewhere.pricing}</p>
              <p className="text-xs text-text-secondary">non-boolean rows</p>
              <Link className={buttonClass('link', 'md', 'mt-2')} to="/platform/catalogue?view=pricing">
                Catalogue → Credit pricing
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardHeader titleAs="h3" title="Model and RAG" description="Written and cross-validated by the model-config endpoint." />
            <CardBody>
              <p className="figure text-lg font-semibold text-text-primary">{parts.elsewhere.runtime}</p>
              <p className="text-xs text-text-secondary">runtime rows</p>
              <Link className={buttonClass('link', 'md', 'mt-2')} to="/platform/platform?view=runtime">
                Runtime
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardHeader titleAs="h3" title="Pricing page copy" description="Marketing content for the public site." />
            <CardBody>
              <p className="figure text-lg font-semibold text-text-primary">{parts.elsewhere.content}</p>
              <p className="text-xs text-text-secondary">content rows</p>
              <Link className={buttonClass('link', 'md', 'mt-2')} to="/platform/catalogue?view=content">
                Catalogue → Pricing page copy
              </Link>
            </CardBody>
          </Card>
        </div>
      </Section>

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
