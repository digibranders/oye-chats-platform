import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Input, SaveBar, SettingBand, SettingGroup, SettingRow, toast } from '../../ui';
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

/** The unit, inside the control rather than in the label. */
function Seconds() {
  return <span className="pr-1 text-xs text-text-tertiary">sec</span>;
}

/**
 * What happens to a visitor while they wait for one of your team.
 *
 * On the Team page rather than on the chatbot, because these four numbers are
 * a statement about the people: how long they get to notice a chat, how long a
 * visitor is asked to trust that somebody will, and how many may be waiting at
 * once. They are stored on the chatbot row.
 *
 * Four integers, four rows. As four `Field`s in a card they were four sentences
 * used as labels over 620px of page — "Seconds an operator has to accept" is a
 * label doing a description's job, and the hint under it repeated the bound the
 * validator already enforces.
 */
export function QueueSettingsCard({ bot, onSaved }: QueueSettingsCardProps) {
  const id = useId();
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

  function numeric(field: keyof QueueSettings) {
    return (
      <Input
        id={`${id}-${field}`}
        className="figure"
        inputMode="numeric"
        required
        trailing={field === 'maxQueue' ? undefined : <Seconds />}
        value={draft[field]}
        onChange={(event) => set(field, event.target.value)}
      />
    );
  }

  return (
    <SettingGroup title="Waiting and routing">
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
        label="Accept timeout"
        htmlFor={`${id}-acceptSeconds`}
        description="Then it returns to the queue."
        controlWidth="sm"
        error={errors.acceptSeconds}
      >
        {numeric('acceptSeconds')}
      </SettingRow>

      <SettingRow
        label="Offer offline form after"
        htmlFor={`${id}-waitSeconds`}
        controlWidth="sm"
        error={errors.waitSeconds}
      >
        {numeric('waitSeconds')}
      </SettingRow>

      <SettingRow
        label="Hold a dropped visitor"
        htmlFor={`${id}-visitorDropSeconds`}
        controlWidth="sm"
        error={errors.visitorDropSeconds}
      >
        {numeric('visitorDropSeconds')}
      </SettingRow>

      <SettingRow
        label="Queue length"
        htmlFor={`${id}-maxQueue`}
        description="Past this, visitors go straight to the offline form."
        controlWidth="sm"
        error={errors.maxQueue}
      >
        {numeric('maxQueue')}
      </SettingRow>

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
    </SettingGroup>
  );
}
