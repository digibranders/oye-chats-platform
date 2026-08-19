import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  Combobox,
  ErrorState,
  Field,
  Input,
  LoadingRows,
  Switch,
  toast,
} from '../../ui';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../../services/api';
import { keys } from '../../query/keys';
import { usePushSubscription } from '../../hooks/usePushSubscription';
import { SaveBar } from '../workspace/SaveBar';
import {
  PUSH_EVENTS,
  defaultPreferences,
  describeQuietHours,
  fromWire,
  isFullySilenced,
  localTimezone,
  preferencesChanged,
  toWire,
  validateTime,
  type PushPreferences,
} from './notificationPreferences';

/**
 * Settings ▸ Account ▸ Alerts.
 *
 * Two layers that the console this replaces conflated into one, and then only
 * shipped half of.
 *
 * **This device** is the browser's push permission and subscription. It is
 * per-device and it is the layer the old page had — honest about permission
 * state, but with nothing behind it.
 *
 * **Every device** is the account-level preference: which events are worth a
 * push at all, and the hours during which none of them are. That is
 * `GET/PUT /operators/me/notification-preferences`, which has been consulted on
 * every dispatch since push shipped and had no client function and no UI.
 * Without it the only way to stop a 3am handoff alert was to revoke
 * notifications in the browser and lose all of them.
 */

function timezoneOptions(current: string): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (kind: string) => string[] })
      .supportedValuesOf;
    if (supported) {
      const list = supported('timeZone');
      return list.includes(current) ? list : [current, ...list];
    }
  } catch {
    /* Fall through to the short list on a browser without it. */
  }
  return [...new Set(['UTC', current].filter(Boolean))];
}

export function NotificationsSection() {
  const device = usePushSubscription();

  const stored = useQuery({
    queryKey: keys.workspace.notificationPreferences(),
    queryFn: getNotificationPreferences,
    staleTime: 5 * 60_000,
  });

  const [baseline, setBaseline] = useState<PushPreferences>(defaultPreferences);
  const [draft, setDraft] = useState<PushPreferences>(defaultPreferences);
  const [timeErrors, setTimeErrors] = useState<{ start?: string; end?: string }>({});
  const [adopted, setAdopted] = useState(false);

  // Adopt the server's copy once, during render. An effect would paint the
  // defaults first — every switch on — and then correct itself, which reads as
  // the page turning the user's alerts back on in front of them. Adopting only
  // once is also what stops a background refetch overwriting an edit in
  // progress.
  if (!adopted && stored.data) {
    setAdopted(true);
    const next = fromWire(stored.data);
    setBaseline(next);
    setDraft(next);
  }

  const save = useMutation({
    mutationFn: () => updateNotificationPreferences(toWire(draft)),
    onSuccess: (result) => {
      // Adopt what the server echoed rather than what we sent: it normalises,
      // and trusting our own copy is how a UI starts disagreeing with reality.
      const confirmed = fromWire(result);
      setBaseline(confirmed);
      setDraft(confirmed);
      toast.success('Alert preferences saved');
    },
  });

  function submit() {
    if (draft.quietHours) {
      const errors = {
        start: validateTime(draft.quietHours.start) ?? undefined,
        end: validateTime(draft.quietHours.end) ?? undefined,
      };
      if (errors.start || errors.end) {
        setTimeErrors(errors);
        return;
      }
    }
    setTimeErrors({});
    save.mutate();
  }

  const dirty = preferencesChanged(baseline, draft);
  const silenced = isFullySilenced(draft);

  return (
    <Card>
      <CardHeader
        eyebrow="Alerts"
        title="How we reach you"
        titleAs="h2"
        description="A live conversation is only useful if somebody notices it. These decide what is worth interrupting you for."
      />

      {/* ── This device ───────────────────────────────────────────────────── */}
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-medium text-text-primary">This device</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
              Browser notifications, so an incoming chat reaches you even when this tab is in the
              background.
            </p>
          </div>
          <Badge tone={device.phase.status === 'subscribed' ? 'success' : 'neutral'}>
            {device.phase.status === 'subscribed'
              ? 'On'
              : device.phase.status === 'denied'
                ? 'Blocked'
                : device.phase.status === 'unsupported'
                  ? 'Unavailable'
                  : 'Off'}
          </Badge>
        </div>

        {device.actionError ? (
          <Alert tone="danger" live>
            {device.actionError}
          </Alert>
        ) : null}

        {device.phase.status === 'checking' ? (
          <p className="text-xs text-text-secondary">Checking this device…</p>
        ) : null}

        {device.phase.status === 'unsupported' ? (
          <Alert tone="neutral">
            This browser cannot receive push notifications. A recent Chrome, Edge or Firefox on
            desktop can.
          </Alert>
        ) : null}

        {device.phase.status === 'denied' ? (
          <Alert
            tone="warning"
            title="Notifications are blocked in your browser"
            action={
              <Button size="sm" variant="secondary" onClick={device.recheck}>
                Re-check
              </Button>
            }
          >
            We cannot undo that from here — click the lock icon beside the address bar, allow
            notifications, then re-check.
          </Alert>
        ) : null}

        {device.phase.status === 'disabled' || device.phase.status === 'incomplete' ? (
          <Alert tone="neutral">
            Your browser is ready, but push delivery is currently switched off on our side. It will
            start working here on its own once it is back — there is nothing to do on this device.
          </Alert>
        ) : null}

        {device.phase.status === 'error' ? (
          <Alert
            tone="danger"
            live
            action={
              <Button size="sm" variant="secondary" onClick={device.recheck}>
                Try again
              </Button>
            }
          >
            {device.phase.message}
          </Alert>
        ) : null}

        {device.phase.status === 'subscribed' ? (
          <Button
            variant="secondary"
            onClick={() => void device.disable()}
            loading={device.busy}
            iconLeft={<BellOff aria-hidden className="h-4 w-4" />}
          >
            Turn off on this device
          </Button>
        ) : null}

        {device.phase.status === 'default' ? (
          <Button
            onClick={() => void device.enable()}
            loading={device.busy}
            iconLeft={<Bell aria-hidden className="h-4 w-4" />}
          >
            Turn on for this device
          </Button>
        ) : null}
      </CardBody>

      {/* ── Every device ──────────────────────────────────────────────────── */}
      <CardSection className="space-y-4">
        <div>
          <h3 className="text-base font-medium text-text-primary">Every device</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
            These follow your account, not this browser, and apply everywhere you are signed in.
          </p>
        </div>

        {stored.isPending ? (
          <LoadingRows rows={3} />
        ) : stored.isError ? (
          <ErrorState
            compact
            title="We could not load your alert preferences"
            description={stored.error instanceof Error ? stored.error.message : undefined}
            onRetry={() => void stored.refetch()}
          />
        ) : (
          <>
            {save.isError ? (
              <Alert tone="danger" live title="We could not save that">
                {save.error instanceof Error
                  ? save.error.message
                  : 'Something went wrong. Please try again.'}
              </Alert>
            ) : null}

            <Switch
              label="Send me push alerts"
              description="The master switch. With it off, nothing below applies."
              checked={draft.enabled}
              onCheckedChange={(next) => setDraft((current) => ({ ...current, enabled: next }))}
            />

            <fieldset
              className="min-w-0 space-y-3 border-t border-border pt-4"
              disabled={!draft.enabled}
            >
              <legend className="sr-only">Which events are worth a push</legend>
              <p className="text-base font-medium text-text-primary">Worth interrupting me for</p>
              {PUSH_EVENTS.map((event) => (
                <Switch
                  key={event.key}
                  size="sm"
                  label={event.label}
                  description={event.description}
                  disabled={!draft.enabled}
                  checked={draft.events[event.key]}
                  onCheckedChange={(next) =>
                    setDraft((current) => ({
                      ...current,
                      events: { ...current.events, [event.key]: next },
                    }))
                  }
                />
              ))}
            </fieldset>

            {silenced ? (
              <Alert tone="warning">
                Nothing can reach you right now. Conversations still arrive in the inbox, but
                nobody will be told about them until someone opens it.
              </Alert>
            ) : null}

            <div className="border-t border-border pt-4">
              <Switch
                label="Quiet hours"
                description={describeQuietHours(draft.quietHours)}
                checked={draft.quietHours !== null}
                onCheckedChange={(next) =>
                  setDraft((current) => ({
                    ...current,
                    quietHours: next
                      ? { start: '22:00', end: '07:00', tz: localTimezone() }
                      : null,
                  }))
                }
              />

              {draft.quietHours ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <Field label="From" required error={timeErrors.start}>
                    <Input
                      type="time"
                      className="figure"
                      value={draft.quietHours.start}
                      onChange={(event) => {
                        setTimeErrors((current) => ({ ...current, start: undefined }));
                        setDraft((current) => ({
                          ...current,
                          quietHours: current.quietHours
                            ? { ...current.quietHours, start: event.target.value }
                            : null,
                        }));
                      }}
                    />
                  </Field>
                  <Field label="Until" required error={timeErrors.end}>
                    <Input
                      type="time"
                      className="figure"
                      value={draft.quietHours.end}
                      onChange={(event) => {
                        setTimeErrors((current) => ({ ...current, end: undefined }));
                        setDraft((current) => ({
                          ...current,
                          quietHours: current.quietHours
                            ? { ...current.quietHours, end: event.target.value }
                            : null,
                        }));
                      }}
                    />
                  </Field>
                  <Field label="Timezone" hint="Quiet hours are read in this zone.">
                    <Combobox
                      label="Quiet hours timezone"
                      value={draft.quietHours.tz}
                      options={timezoneOptions(draft.quietHours.tz).map((zone) => ({
                        value: zone,
                        label: zone,
                      }))}
                      onValueChange={(zone) =>
                        setDraft((current) => ({
                          ...current,
                          quietHours: current.quietHours
                            ? { ...current.quietHours, tz: zone ?? current.quietHours.tz }
                            : null,
                        }))
                      }
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          </>
        )}
      </CardSection>

      {!stored.isPending && !stored.isError ? (
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onSave={submit}
          onDiscard={() => {
            setDraft(baseline);
            setTimeErrors({});
          }}
        />
      ) : null}
    </Card>
  );
}
