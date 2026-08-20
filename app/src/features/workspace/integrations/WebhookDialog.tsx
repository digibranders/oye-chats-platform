import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  CopyField,
  Dialog,
  Field,
  FieldSet,
  Input,
  toast,
} from '../../../ui';
import { createWebhook, updateWebhook } from '../../../services/api';
import type { Webhook } from '../../../types/domain';
import { DEFAULT_EVENTS, WEBHOOK_EVENTS, validateWebhookUrl } from './webhookModel';

export interface WebhookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates a new endpoint. */
  webhook: Webhook | null;
  botId: number | null;
  onSaved: () => void;
}

/**
 * Register or edit a delivery endpoint.
 *
 * The signing secret is returned by the create call and never again — every
 * later read masks it — so it is revealed here once, in a copy field, with the
 * dialog staying open until the user says they have it. The previous console
 * rendered it into a paragraph beside a copy button that copied the mask.
 */
export function WebhookDialog({ open, onOpenChange, webhook, botId, onSaved }: WebhookDialogProps) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([...DEFAULT_EVENTS]);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  // Seeded during render on which endpoint is open, so the fields never show a
  // frame of the previous one.
  const seed = open ? (webhook ? String(webhook.id) : 'new') : null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (seeded !== seed) {
    setSeeded(seed);
    if (seed !== null) {
      setUrl(webhook?.url ?? '');
      setEvents(webhook && webhook.events.length > 0 ? [...webhook.events] : [...DEFAULT_EVENTS]);
      setUrlError(null);
      setEventsError(null);
      setSecret(null);
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      if (webhook) return updateWebhook(webhook.id, { url: url.trim(), events });
      if (botId == null) throw new Error('Pick a chatbot before adding an endpoint.');
      return createWebhook(botId, { url: url.trim(), events, is_active: true });
    },
    onSuccess: (result) => {
      onSaved();
      if (!webhook && result?.secret) {
        toast.success('Endpoint added');
        setSecret(result.secret);
        return;
      }
      toast.success(webhook ? 'Endpoint updated' : 'Endpoint added');
      onOpenChange(false);
    },
  });

  function submit() {
    const reason = validateWebhookUrl(url);
    if (reason) {
      setUrlError(reason);
      return;
    }
    if (events.length === 0) {
      setEventsError('Choose at least one event, or this endpoint will never be called.');
      return;
    }
    setUrlError(null);
    setEventsError(null);
    save.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={webhook ? 'Edit endpoint' : 'Add an endpoint'}
      description="We POST a JSON body to this URL each time one of the events below happens."
      dismissible={!save.isPending}
      footer={
        secret ? (
          <Button onClick={() => onOpenChange(false)}>I have saved the secret</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} loading={save.isPending}>
              {webhook ? 'Save changes' : 'Add endpoint'}
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <div className="space-y-4">
          <Alert tone="warning" live title="Copy this signing secret now">
            It is shown once. Every delivery carries an HMAC signature computed with it — without it
            your endpoint cannot tell our requests from anyone else's.
          </Alert>
          <CopyField value={secret} label="signing secret" />
        </div>
      ) : (
        <div className="space-y-5">
          {save.isError ? (
            <Alert tone="danger" live title="We could not save that endpoint">
              {save.error instanceof Error
                ? save.error.message
                : 'Something went wrong. Please try again.'}
            </Alert>
          ) : null}

          <Field
            label="Endpoint URL"
            required
            hint="Must be https and reachable from the public internet."
            error={urlError}
          >
            <Input
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setUrlError(null);
              }}
              placeholder="https://hooks.example.com/oyechats"
              inputMode="url"
              autoComplete="off"
            />
          </Field>

          <FieldSet legend="Events" hint="Only ticked events are sent.">
            <div className="space-y-2.5">
              {WEBHOOK_EVENTS.map((event) => (
                <Checkbox
                  key={event.value}
                  label={event.label}
                  description={event.description}
                  checked={events.includes(event.value)}
                  onCheckedChange={(checked) => {
                    setEventsError(null);
                    setEvents((current) =>
                      checked === true
                        ? [...current, event.value]
                        : current.filter((value) => value !== event.value),
                    );
                  }}
                />
              ))}
            </div>
            {eventsError ? (
              <p role="status" aria-live="polite" className="mt-2 text-xs text-danger">
                {eventsError}
              </p>
            ) : null}
          </FieldSet>
        </div>
      )}
    </Dialog>
  );
}
