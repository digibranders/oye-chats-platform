import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  Input,
  SaveBar,
  Select,
  SettingBand,
  SettingGroup,
  SettingRow,
  Switch,
  toast,
} from '../../../ui';
import { updateBot } from '../../../services/api';
import type { Bot } from '../../../types/domain';
import { MEETING_PROVIDERS, readIntegrations, validateMeetingUrl } from './emailModel';

export interface MeetingsPanelProps {
  bot: Bot;
  onSaved: () => void;
}

interface MeetingDraft {
  enabled: boolean;
  providerId: string;
  url: string;
}

function readMeetings(bot: Bot): MeetingDraft {
  const settings = readIntegrations(bot);
  const providerId =
    MEETING_PROVIDERS.find((provider) => provider.id === settings.meeting_provider)?.id ??
    MEETING_PROVIDERS[0].id;
  const provider = MEETING_PROVIDERS.find((candidate) => candidate.id === providerId)!;
  return {
    enabled: settings.meeting_booking_enabled ?? false,
    providerId,
    url: (settings[provider.field] as string | null | undefined) ?? '',
  };
}

/**
 * Let the chatbot offer a time.
 *
 * One provider at a time, deliberately. The row carries a URL column per
 * provider and the previous page rendered all three at once, so a customer
 * could fill in two and had no way of telling which one the widget would
 * actually show. The chosen provider's URL is written; the others are left
 * exactly as they were, so switching back does not lose a link.
 */
export function MeetingsPanel({ bot, onSaved }: MeetingsPanelProps) {
  const fieldId = useId();
  const [baseline, setBaseline] = useState<MeetingDraft>(() => readMeetings(bot));
  const [draft, setDraft] = useState<MeetingDraft>(() => readMeetings(bot));
  const [urlError, setUrlError] = useState<string | null>(null);

  // Re-seeded during render when the chatbot changes — see `EmailPanel` for why
  // this is not an effect.
  const [seededFor, setSeededFor] = useState(bot.id);
  if (seededFor !== bot.id) {
    setSeededFor(bot.id);
    const next = readMeetings(bot);
    setBaseline(next);
    setDraft(next);
    setUrlError(null);
  }

  const provider = MEETING_PROVIDERS.find((candidate) => candidate.id === draft.providerId)!;

  const save = useMutation({
    mutationFn: () =>
      updateBot(bot.id, {
        meeting_booking_enabled: draft.enabled,
        meeting_provider: draft.enabled ? draft.providerId : null,
        [provider.field]: draft.enabled ? draft.url.trim() : null,
      }),
    onSuccess: () => {
      setBaseline(draft);
      toast.success('Meeting booking saved');
      onSaved();
    },
  });

  function submit() {
    if (draft.enabled) {
      const reason = validateMeetingUrl(provider, draft.url);
      if (reason) {
        setUrlError(reason);
        return;
      }
    }
    setUrlError(null);
    save.mutate();
  }

  const dirty = JSON.stringify(baseline) !== JSON.stringify(draft);

  return (
    <SettingGroup title="Meeting booking">
      {save.isError ? (
        <SettingBand>
          <Alert tone="danger" live title="We could not save that">
            {save.error instanceof Error
              ? save.error.message
              : 'Something went wrong. Please try again.'}
          </Alert>
        </SettingBand>
      ) : null}

      {/* The off-state explanation is the switch's own description, so the row
          does not appear and disappear — which is what made the card jump
          height on every toggle. */}
      <SettingRow
        label="Offer a booking link"
        description="Off: the chatbot captures contact details instead."
        controlWidth="auto"
      >
        <Switch
          hideLabel
          label="Offer a booking link"
          checked={draft.enabled}
          onCheckedChange={(next) => setDraft((current) => ({ ...current, enabled: next }))}
        />
      </SettingRow>

      {draft.enabled ? (
        <>
          <SettingRow label="Scheduling tool" htmlFor={`${fieldId}-provider`}>
            <Select
              id={`${fieldId}-provider`}
              required
              value={draft.providerId}
              options={MEETING_PROVIDERS.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
              }))}
              onChange={(event) => {
                const nextId = event.target.value;
                const next = MEETING_PROVIDERS.find((candidate) => candidate.id === nextId)!;
                const settings = readIntegrations(bot);
                setUrlError(null);
                setDraft((current) => ({
                  ...current,
                  providerId: nextId,
                  // Restore whatever was already saved for that provider,
                  // rather than carrying the previous provider's URL across
                  // into a field it can never be valid in.
                  url: (settings[next.field] as string | null | undefined) ?? '',
                }));
              }}
            />
          </SettingRow>

          <SettingRow
            label={`${provider.name} link`}
            htmlFor={`${fieldId}-url`}
            description={`Must be on ${provider.host}.`}
            stacked
            error={urlError ?? undefined}
          >
            <Input
              id={`${fieldId}-url`}
              required
              value={draft.url}
              onChange={(event) => {
                setUrlError(null);
                setDraft((current) => ({
                  ...current,
                  url: event.target.value,
                }));
              }}
              placeholder={provider.placeholder}
              inputMode="url"
            />
          </SettingRow>
        </>
      ) : null}

      <SaveBar
        variant="footer"
        dirty={dirty}
        saving={save.isPending}
        onSave={submit}
        onDiscard={() => {
          setDraft(baseline);
          setUrlError(null);
        }}
      />
    </SettingGroup>
  );
}
