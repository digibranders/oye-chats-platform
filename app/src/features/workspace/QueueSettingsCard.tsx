import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Card, CardBody, CardHeader, Field, Input, SaveBar, toast } from '../../ui';
import { updateBot } from '../../services/api';
import type { Bot } from '../../types/domain';
import {
  queueSettingsChanged,
  readQueueSettings,
  toQueuePatch,
  validateQueueSettings,
  type QueueSettings,
} from './queueSettings';

export interface QueueSettingsCardProps {
  bot: Bot;
  onSaved: () => void;
}

/**
 * What happens to a visitor while they wait for one of your team.
 *
 * On the Team page rather than on the chatbot, because these three numbers are
 * a statement about the people: how long they get to notice a chat, how long a
 * visitor is asked to trust that somebody will, and how many may be waiting at
 * once. They are stored on the chatbot row, and the card says so.
 */
export function QueueSettingsCard({ bot, onSaved }: QueueSettingsCardProps) {
  const [baseline, setBaseline] = useState<QueueSettings>(() => readQueueSettings(bot));
  const [draft, setDraft] = useState<QueueSettings>(() => readQueueSettings(bot));
  const [errors, setErrors] = useState<Partial<Record<keyof QueueSettings, string>>>({});

  // Re-seeded during render when the chatbot changes, so the form never paints
  // one frame of the previous chatbot's numbers.
  const [seededFor, setSeededFor] = useState(bot.id);
  if (seededFor !== bot.id) {
    setSeededFor(bot.id);
    const next = readQueueSettings(bot);
    setBaseline(next);
    setDraft(next);
    setErrors({});
  }

  const save = useMutation({
    mutationFn: () => updateBot(bot.id, toQueuePatch(draft)),
    onSuccess: () => {
      setBaseline(draft);
      toast.success('Queue settings saved');
      onSaved();
    },
  });

  function set(field: keyof QueueSettings, value: string): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submit(): void {
    const found = validateQueueSettings(draft);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    save.mutate();
  }

  return (
    <Card>
      <CardHeader
        title="Waiting and routing"
        titleAs="h2"
        description={`How long a visitor waits for one of your team on ${bot.name ?? 'this chatbot'}, what happens when nobody picks up, and how long a dropped conversation is held open.`}
      />
      <CardBody className="space-y-5">
        {save.isError ? (
          <Alert tone="danger" live title="We could not save that">
            {save.error instanceof Error
              ? save.error.message
              : 'Something went wrong. Please try again.'}
          </Alert>
        ) : null}

        <Field
          label="Seconds an operator has to accept"
          required
          hint="After this, the conversation goes back to the queue for somebody else. Between 5 seconds and an hour."
          error={errors.acceptSeconds}
        >
          <Input
            className="figure"
            inputMode="numeric"
            value={draft.acceptSeconds}
            onChange={(event) => set('acceptSeconds', event.target.value)}
          />
        </Field>

        <Field
          label="Seconds a visitor waits before we offer the offline form"
          required
          hint="Short enough that they do not give up, long enough that somebody can reach their keyboard. Between 5 seconds and 10 minutes."
          error={errors.waitSeconds}
        >
          <Input
            className="figure"
            inputMode="numeric"
            value={draft.waitSeconds}
            onChange={(event) => set('waitSeconds', event.target.value)}
          />
        </Field>

        <Field
          label="Seconds a dropped visitor is held before the chat closes"
          required
          hint="If a visitor loses their connection mid-conversation, this is how long their operator keeps the chat open waiting for them to come back. Between 5 seconds and an hour."
          error={errors.visitorDropSeconds}
        >
          <Input
            className="figure"
            inputMode="numeric"
            value={draft.visitorDropSeconds}
            onChange={(event) => set('visitorDropSeconds', event.target.value)}
          />
        </Field>

        <Field
          label="Visitors who may wait at once"
          required
          hint="Past this, new visitors are sent straight to the offline form instead of joining a queue they will not get through."
          error={errors.maxQueue}
        >
          <Input
            className="figure"
            inputMode="numeric"
            value={draft.maxQueue}
            onChange={(event) => set('maxQueue', event.target.value)}
          />
        </Field>
      </CardBody>
      <SaveBar
          variant="footer"
        dirty={queueSettingsChanged(baseline, draft)}
        saving={save.isPending}
        onSave={submit}
        onDiscard={() => {
          setDraft(baseline);
          setErrors({});
        }}
      />
    </Card>
  );
}
