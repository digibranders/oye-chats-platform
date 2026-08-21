import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Combobox,
  ErrorState,
  FieldSet,
  Input,
  LoadingRows,
  SaveBar,
  SettingBand,
  SettingGroup,
  SettingRow,
  Switch,
  toast,
} from '../../ui';
import { getNotificationPreferences, updateNotificationPreferences } from '../../services/api';
import { keys } from '../../query/keys';
import { usePushSubscription } from '../../hooks/usePushSubscription';
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
  const fieldId = useId();
  const device = usePushSubscription();

  const stored = useQuery({
    queryKey: keys.workspace.notificationPreferences(),
    queryFn: getNotificationPreferences,
    staleTime: 5 * 60_000,
  });

  const [baseline, setBaseline] = useState<PushPreferences>(defaultPreferences);
  const [draft, setDraft] = useState<PushPreferences>(defaultPreferences);
  const [timeErrors, setTimeErrors] = useState<{
    start?: string;
    end?: string;
  }>({});
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
    <SettingGroup title="How we reach you" id="alerts">
      {/* ── This device ───────────────────────────────────────────────────── */}
      <SettingRow
        label="This device"
        description="Reaches you when this tab is in the background."
        badge={
          <Badge tone={device.phase.status === 'subscribed' ? 'success' : 'neutral'}>
            {device.phase.status === 'subscribed'
              ? 'On'
              : device.phase.status === 'denied'
                ? 'Blocked'
                : device.phase.status === 'unsupported'
                  ? 'Unavailable'
                  : 'Off'}
          </Badge>
        }
        controlWidth="auto"
      >
        {device.phase.status === 'checking' ? (
          <span className="text-xs text-text-secondary">Checking…</span>
        ) : device.phase.status === 'denied' ? (
          <Button size="sm" variant="secondary" onClick={device.recheck}>
            Re-check
          </Button>
        ) : device.phase.status === 'error' ? (
          <Button size="sm" variant="secondary" onClick={device.recheck}>
            Try again
          </Button>
        ) : device.phase.status === 'subscribed' ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void device.disable()}
            loading={device.busy}
            iconLeft={<BellOff aria-hidden />}
          >
            Turn off on this device
          </Button>
        ) : device.phase.status === 'default' ? (
          <Button
            size="sm"
            onClick={() => void device.enable()}
            loading={device.busy}
            iconLeft={<Bell aria-hidden />}
          >
            Turn on for this device
          </Button>
        ) : null}
      </SettingRow>

      {/* The device's own failure modes, each of which the reader has to act on
          — so they stay, beside the row that produced them. */}
      {device.actionError ||
      device.phase.status === 'unsupported' ||
      device.phase.status === 'denied' ||
      device.phase.status === 'disabled' ||
      device.phase.status === 'incomplete' ||
      device.phase.status === 'error' ? (
        <SettingBand className="space-y-3">
          {device.actionError ? (
            <Alert tone="danger" live>
              {device.actionError}
            </Alert>
          ) : null}

          {device.phase.status === 'unsupported' ? (
            <Alert tone="neutral">
              This browser cannot receive push notifications. A recent Chrome, Edge or Firefox on
              desktop can.
            </Alert>
          ) : null}

          {device.phase.status === 'denied' ? (
            <Alert tone="warning" title="Notifications are blocked in your browser">
              Click the lock icon beside the address bar, allow notifications, then re-check.
            </Alert>
          ) : null}

          {device.phase.status === 'disabled' || device.phase.status === 'incomplete' ? (
            <Alert tone="neutral">
              Push delivery is switched off on our side. It starts working here on its own once it
              is back.
            </Alert>
          ) : null}

          {device.phase.status === 'error' ? (
            <Alert tone="danger" live>
              {device.phase.message}
            </Alert>
          ) : null}
        </SettingBand>
      ) : null}

      {/* ── Every device ──────────────────────────────────────────────────── */}
      {stored.isPending ? (
        <SettingBand>
          <LoadingRows rows={3} />
        </SettingBand>
      ) : stored.isError ? (
        <ErrorState
          size="panel"
          title="We could not load your alert preferences"
          description={stored.error instanceof Error ? stored.error.message : undefined}
          onRetry={() => void stored.refetch()}
        />
      ) : (
        <>
          {save.isError ? (
            <SettingBand>
              <Alert tone="danger" live title="We could not save that">
                {save.error instanceof Error
                  ? save.error.message
                  : 'Something went wrong. Please try again.'}
              </Alert>
            </SettingBand>
          ) : null}

          <SettingRow
            label="Send me push alerts"
            description="Applies everywhere you are signed in."
            controlWidth="auto"
          >
            <Switch
              hideLabel
              label="Send me push alerts"
              checked={draft.enabled}
              onCheckedChange={(next) => setDraft((current) => ({ ...current, enabled: next }))}
            />
          </SettingRow>

          {/* One name for the group, visible and in a real `legend`. It used to
              carry an `sr-only` legend saying "Which events are worth a push"
              over a `<p>` reading "Worth interrupting me for" — two names for
              one group, and the visible one was not a heading.

              `disabled` on the group as well as on each switch: Base UI's
              `Switch` is a span, so the native `fieldset[disabled]` inheritance
              does not reach it — but the legend is what tells the reader *why*
              three switches have gone quiet, and without it the name stayed at
              full contrast above three controls that had gone grey. */}
          <SettingBand>
            <FieldSet legend="Worth interrupting me for" disabled={!draft.enabled}>
              <div className="space-y-3">
                {PUSH_EVENTS.map((event) => (
                  <Switch
                    key={event.key}
                    label={event.label}
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
              </div>
            </FieldSet>
          </SettingBand>

          {silenced ? (
            <SettingBand>
              <Alert tone="warning">
                Nothing can reach you right now. Conversations still arrive in the inbox.
              </Alert>
            </SettingBand>
          ) : null}

          <SettingRow
            label="Quiet hours"
            badge={
              draft.quietHours ? (
                <Badge tone="neutral">{describeQuietHours(draft.quietHours)}</Badge>
              ) : undefined
            }
            controlWidth="auto"
          >
            <Switch
              hideLabel
              label="Quiet hours"
              checked={draft.quietHours !== null}
              onCheckedChange={(next) =>
                setDraft((current) => ({
                  ...current,
                  quietHours: next ? { start: '22:00', end: '07:00', tz: localTimezone() } : null,
                }))
              }
            />
          </SettingRow>

          {draft.quietHours ? (
            <>
              <SettingRow
                label="From"
                htmlFor={`${fieldId}-from`}
                controlWidth="sm"
                error={timeErrors.start}
              >
                <Input
                  id={`${fieldId}-from`}
                  type="time"
                  required
                  className="figure"
                  value={draft.quietHours.start}
                  onChange={(event) => {
                    setTimeErrors((current) => ({
                      ...current,
                      start: undefined,
                    }));
                    setDraft((current) => ({
                      ...current,
                      quietHours: current.quietHours
                        ? { ...current.quietHours, start: event.target.value }
                        : null,
                    }));
                  }}
                />
              </SettingRow>
              <SettingRow
                label="Until"
                htmlFor={`${fieldId}-until`}
                controlWidth="sm"
                error={timeErrors.end}
              >
                <Input
                  id={`${fieldId}-until`}
                  type="time"
                  required
                  className="figure"
                  value={draft.quietHours.end}
                  onChange={(event) => {
                    setTimeErrors((current) => ({
                      ...current,
                      end: undefined,
                    }));
                    setDraft((current) => ({
                      ...current,
                      quietHours: current.quietHours
                        ? { ...current.quietHours, end: event.target.value }
                        : null,
                    }));
                  }}
                />
              </SettingRow>
              <SettingRow label="Timezone">
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
                        ? {
                            ...current.quietHours,
                            tz: zone ?? current.quietHours.tz,
                          }
                        : null,
                    }))
                  }
                />
              </SettingRow>
            </>
          ) : null}
        </>
      )}

      {!stored.isPending && !stored.isError ? (
        <SaveBar
          variant="footer"
          dirty={dirty}
          saving={save.isPending}
          onSave={submit}
          onDiscard={() => {
            setDraft(baseline);
            setTimeErrors({});
          }}
        />
      ) : null}
    </SettingGroup>
  );
}
