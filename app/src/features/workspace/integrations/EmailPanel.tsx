import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  buttonClass,
  SaveBar,
  SettingGroup,
  SettingRow,
  Stack,
  Switch,
  TagInput,
  toast,
  validateEmail,
} from '../../../ui';
import { updateBot } from '../../../services/api';
import type { Bot } from '../../../types/domain';
import { readEmailRouting, routingChanged, toBotPatch, type EmailRouting } from './emailModel';

export interface EmailPanelProps {
  bot: Bot;
  /** `'all'` unlocks recipient routing; `'reply_to_only'` is the Free ceiling. */
  access: 'all' | 'reply_to_only';
  onSaved: () => void;
}

/**
 * Where the notifications about this chatbot go.
 *
 * Two layers, in the order a person thinks about them: who hears about it at
 * all (the default recipients), and then the exceptions (a per-event list that
 * overrides the default). The exceptions stay collapsed until they exist,
 * because a workspace with one shared inbox should not have to read four
 * identical fields to discover it only needed one.
 */
export function EmailPanel({ bot, access, onSaved }: EmailPanelProps) {
  const [baseline, setBaseline] = useState<EmailRouting>(() => readEmailRouting(bot));
  const [draft, setDraft] = useState<EmailRouting>(() => readEmailRouting(bot));
  const [showOverrides, setShowOverrides] = useState(() => {
    const initial = readEmailRouting(bot);
    return (
      initial.qualifiedLead.length > 0 || initial.handoff.length > 0 || initial.offline.length > 0
    );
  });

  // Re-seeded during render when the chatbot changes. Keyed on the id, so a
  // background refetch of the *same* chatbot cannot wipe an edit in progress —
  // and done here rather than in an effect so the form never shows one frame of
  // the previous chatbot's recipients.
  const [seededFor, setSeededFor] = useState(bot.id);
  if (seededFor !== bot.id) {
    setSeededFor(bot.id);
    const next = readEmailRouting(bot);
    setBaseline(next);
    setDraft(next);
  }

  const save = useMutation({
    mutationFn: () => updateBot(bot.id, toBotPatch(draft)),
    onSuccess: () => {
      setBaseline(draft);
      toast.success('Email routing saved');
      onSaved();
    },
  });

  const set = <K extends keyof EmailRouting>(key: K, value: EmailRouting[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const dirty = routingChanged(baseline, draft);
  const restricted = access !== 'all';

  return (
    <Stack>
      {restricted ? (
        <Alert
          tone="plan"
          title="Recipient routing is not on your plan"
          action={
            <Link to="/billing" className={buttonClass('secondary', 'sm')}>
              See plans
            </Link>
          }
        >
          Reply-to is available on every plan. Routing notifications to chosen inboxes needs a paid
          plan; until then they go to the owner.
        </Alert>
      ) : null}

      {save.isError ? (
        <Alert tone="danger" live title="We could not save that">
          {save.error instanceof Error
            ? save.error.message
            : 'Something went wrong. Please try again.'}
        </Alert>
      ) : null}

      <SettingGroup title="Addresses" description="Sent from notifications@oyechats.com.">
        <SettingRow label="Reply-to" description="Empty uses the owner's address." stacked>
          <TagInput
            label="Reply-to address"
            values={draft.replyTo ? [draft.replyTo] : []}
            maxValues={1}
            placeholder="support@yourdomain.com"
            validate={validateEmail}
            normalize={(value) => value.trim().toLowerCase()}
            onValuesChange={(values) => set('replyTo', values[0] ?? '')}
          />
        </SettingRow>

        <SettingRow label="Default recipients" stacked disabled={restricted}>
          <TagInput
            label="Default recipients"
            values={draft.recipients}
            disabled={restricted}
            placeholder="sales@yourdomain.com"
            validate={validateEmail}
            normalize={(value) => value.trim().toLowerCase()}
            onValuesChange={(values) => set('recipients', values)}
          />
        </SettingRow>

        {!restricted ? (
          <>
            <SettingRow label="Route some events elsewhere" controlWidth="auto">
              {/* No `size="sm"`. Five switches on this page sit in a
                  `SettingRow` and four of them were the default 20px; this one
                  was 16, which reads as a rendering fault rather than as a
                  smaller control. */}
              <Switch
                hideLabel
                label="Route some events elsewhere"
                checked={showOverrides}
                onCheckedChange={(next) => {
                  setShowOverrides(next);
                  if (!next) {
                    // Turning overrides off has to clear them, or the toggle
                    // hides lists that are still in effect.
                    setDraft((current) => ({
                      ...current,
                      qualifiedLead: [],
                      handoff: [],
                      offline: [],
                    }));
                  }
                }}
              />
            </SettingRow>
            {showOverrides ? (
              <>
                <SettingRow
                  label="Qualified leads go to"
                  description="Leave empty to use the default recipients."
                  stacked
                >
                  <TagInput
                    label="Qualified lead recipients"
                    values={draft.qualifiedLead}
                    placeholder="sales@yourdomain.com"
                    validate={validateEmail}
                    normalize={(value) => value.trim().toLowerCase()}
                    onValuesChange={(values) => set('qualifiedLead', values)}
                  />
                </SettingRow>
                <SettingRow label="Handoff requests go to" stacked>
                  <TagInput
                    label="Handoff request recipients"
                    values={draft.handoff}
                    placeholder="support@yourdomain.com"
                    validate={validateEmail}
                    normalize={(value) => value.trim().toLowerCase()}
                    onValuesChange={(values) => set('handoff', values)}
                  />
                </SettingRow>
                <SettingRow label="Offline messages go to" stacked>
                  <TagInput
                    label="Offline message recipients"
                    values={draft.offline}
                    placeholder="inbox@yourdomain.com"
                    validate={validateEmail}
                    normalize={(value) => value.trim().toLowerCase()}
                    onValuesChange={(values) => set('offline', values)}
                  />
                </SettingRow>
              </>
            ) : null}
          </>
        ) : null}
      </SettingGroup>

      {/* One group, one save bar. Five switches in a `space-y-4` stack with no
          hairlines and a description under each label read as one wall of text
          — the "arranged vertically line by line" complaint exactly. */}
      <SettingGroup
        title="What we email about"
        description="Off means no email — the event still fires webhooks."
      >
        <SettingRow label="A lead qualifies" controlWidth="auto">
          <Switch
            hideLabel
            label="A lead qualifies"
            checked={draft.onQualified}
            onCheckedChange={(next) => set('onQualified', next)}
          />
        </SettingRow>
        <SettingRow label="A visitor asks for a person" controlWidth="auto">
          <Switch
            hideLabel
            label="A visitor asks for a person"
            checked={draft.onHandoff}
            onCheckedChange={(next) => set('onHandoff', next)}
          />
        </SettingRow>
        <SettingRow label="An offline message arrives" controlWidth="auto">
          <Switch
            hideLabel
            label="An offline message arrives"
            checked={draft.onOffline}
            onCheckedChange={(next) => set('onOffline', next)}
          />
        </SettingRow>
        <SettingRow label="Send the visitor a receipt" controlWidth="auto">
          <Switch
            hideLabel
            label="Send the visitor a receipt"
            checked={draft.visitorConfirmation}
            onCheckedChange={(next) => set('visitorConfirmation', next)}
          />
        </SettingRow>
        <SettingRow
          label="Attach the transcript"
          description="Think twice on a shared inbox."
          controlWidth="auto"
        >
          <Switch
            hideLabel
            label="Attach the transcript"
            checked={draft.transcript}
            onCheckedChange={(next) => set('transcript', next)}
          />
        </SettingRow>
        <SaveBar
          variant="footer"
          dirty={dirty}
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={() => setDraft(baseline)}
        />
      </SettingGroup>
    </Stack>
  );
}
