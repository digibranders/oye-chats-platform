import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  EmptyState,
  Field,
  LoadingRows,
  LockedState,
  SearchField,
  Section,
  Select,
  Stack,
  Toolbar,
  formatNumber,
  type SelectOption,
} from '../../ui';
import { usePlatformResource, useUrlState } from '../usePlatform';
import {
  LEVEL_TONE,
  LOG_LEVELS,
  LOG_LINE_CHOICES,
  LOG_SERVICES,
  MAX_GREP_LENGTH,
  coerceLines,
  coerceService,
  levelCounts,
  logsAsText,
  logsParams,
} from './logs-model';
import type { LogsResponse } from './types';

/**
 * Server logs.
 *
 * This is the one screen a super-admin will copy out of and paste into a support
 * ticket, so the whole thing is built around that: the filters are in the URL so
 * the same view can be handed to a colleague, and the body is one copyable block
 * rather than a table somebody has to reassemble by hand.
 *
 * Two deliberate absences. There is no free-text service box — `fetch_logs`
 * allow-lists exactly two units and that check is what keeps a user string out
 * of a subprocess argument, so offering more would be inviting a refusal. And
 * there is no live tail: no streaming endpoint exists, and polling one into an
 * auto-scrolling pane would put a continuous feed of customer conversations on
 * screen that nobody asked to keep there. Fetching is an act.
 */

const SERVICE_OPTIONS: SelectOption[] = LOG_SERVICES.map((service) => ({ ...service }));
const LEVEL_OPTIONS: SelectOption[] = LOG_LEVELS.map((level) => ({ ...level }));
const LINE_OPTIONS: SelectOption[] = LOG_LINE_CHOICES.map((value) => ({
  value,
  label: `${formatNumber(Number(value))} lines`,
}));

export function LogsScreen() {
  const url = useUrlState();
  const service = coerceService(url.get('service', 'oyechats-api'));
  const lines = url.get('lines', '500');
  const level = url.get('level', '');
  const grep = url.get('grep', '');

  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());

  const logs = usePlatformResource<LogsResponse>('/logs', logsParams({ service, lines, level, grep }));

  const counts = useMemo(() => levelCounts(logs.data?.entries ?? []), [logs.data]);
  const text = useMemo(() => logsAsText(logs.data), [logs.data]);

  function refresh(): void {
    logs.reload();
    setFetchedAt(Date.now());
  }

  if (logs.forbidden) {
    return (
      <LockedState
        title="You cannot read the server journals"
        description="Your super-admin account is not permitted to tail them."
      />
    );
  }

  return (
    <Stack>
      <Toolbar sticky>
        <Field label="Service" hideLabel className="w-48">
          <Select
            size="sm"
            options={SERVICE_OPTIONS}
            value={service}
            onChange={(event) => url.set({ service: event.target.value })}
          />
        </Field>
        <Field label="Lines" hideLabel className="w-48">
          <Select
            size="sm"
            options={LINE_OPTIONS}
            value={String(coerceLines(lines))}
            onChange={(event) => url.set({ lines: event.target.value })}
          />
        </Field>
        <Field label="Level" hideLabel className="w-48">
          <Select
            size="sm"
            options={LEVEL_OPTIONS}
            value={level}
            onChange={(event) => url.set({ level: event.target.value || null })}
          />
        </Field>
        <div className="min-w-0 flex-1">
          <SearchField
            size="sm"
            label="Filter log lines"
            maxLength={MAX_GREP_LENGTH}
            placeholder="Match a substring…"
            // Longer than the default: every settled keystroke here starts a
            // journalctl subprocess on the box.
            debounceMs={500}
            value={grep}
            onValueChange={(next) => url.set({ grep: next.trim().slice(0, MAX_GREP_LENGTH) || null })}
          />
        </div>
        <Button size="sm" variant="secondary" onClick={refresh} iconLeft={<RefreshCw aria-hidden className="h-3.5 w-3.5" />}>
          Fetch again
        </Button>
      </Toolbar>

      <Section
        title={`${service}.service`}
        description="Read once, on request. These lines carry customer data — trim before pasting into a ticket."
      >
        <Card>
          <CardHeader
            titleAs="h3"
            title="Journal"
            description={
              logs.data
                ? `${formatNumber(logs.data.entries.length)} lines · fetched at ${new Date(fetchedAt).toLocaleTimeString()}`
                : 'Nothing fetched yet.'
            }
            actions={
              <div className="flex flex-wrap items-center gap-1.5">
                {Object.entries(counts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, count]) => (
                    <Badge key={name} tone={LEVEL_TONE[name] ?? 'neutral'}>
                      {name} {formatNumber(count)}
                    </Badge>
                  ))}
              </div>
            }
          />
          <CardBody>
            {logs.loading && !logs.data ? (
              <LoadingRows rows={8} />
            ) : logs.error && !logs.data ? (
              <Alert
                tone="danger"
                title="The journal could not be read"
                action={
                  <Button size="sm" onClick={refresh}>
                    Try again
                  </Button>
                }
              >
                {logs.error}
              </Alert>
            ) : logs.data && logs.data.entries.length === 0 ? (
              <EmptyState
                compact
                title="No lines matched"
                description={
                  grep || level
                    ? 'The unit is running; nothing in the last window matched this filter. Clear it to see everything.'
                    : 'The unit logged nothing in this window.'
                }
                action={
                  grep || level ? (
                    <Button
                      size="sm"
                      onClick={() => url.set({ grep: null, level: null })}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            ) : logs.data ? (
              <>
                {!logs.data.available ? (
                  <Alert tone="neutral" className="mb-3" title="journalctl is not available on this host">
                    The API answered with a placeholder line instead of a journal. On the droplet this reads
                    the real unit; locally there is nothing to read.
                  </Alert>
                ) : null}
                <CodeBlock
                  code={text}
                  label="log"
                  caption={`${service}.service — copy the whole block, then trim it before it goes anywhere`}
                  className="max-h-[32rem] overflow-y-auto"
                />
              </>
            ) : null}
          </CardBody>
        </Card>
      </Section>
    </Stack>
  );
}
