import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Alert, buttonClass, Card, CardBody, CardHeader, CardSection, Field, SaveBar, Stack, Switch, TagInput, toast, validateEmail } from '../../../ui';
import { updateBot } from '../../../services/api';
import type { Bot } from '../../../types/domain';
import {
  readEmailRouting,
  routingChanged,
  toBotPatch,
  type EmailRouting,
} from './emailModel';

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
      initial.qualifiedLead.length > 0 ||
      initial.handoff.length > 0 ||
      initial.offline.length > 0
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
          You can set the reply-to address, so a visitor's reply reaches you. Choosing who gets
          notified — and routing different events to different inboxes — needs a paid plan. Until
          then notifications go to the workspace owner's email.
        </Alert>
      ) : null}

      {save.isError ? (
        <Alert tone="danger" live title="We could not save that">
          {save.error instanceof Error
            ? save.error.message
            : 'Something went wrong. Please try again.'}
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Addresses"
          titleAs="h2"
          description="We send from notifications@oyechats.com. These decide where the replies and the alerts go."
        />
        <CardBody className="space-y-5">
          <Field
            label="Reply-to address"
            hint="When someone replies to one of our emails, it lands here. Leave it empty to use the workspace owner's address."
          >
            <TagInput
              label="Reply-to address"
              values={draft.replyTo ? [draft.replyTo] : []}
              maxValues={1}
              placeholder="support@yourdomain.com"
              validate={validateEmail}
              normalize={(value) => value.trim().toLowerCase()}
              onValuesChange={(values) => set('replyTo', values[0] ?? '')}
            />
          </Field>

          <Field
            label="Default recipients"
            hint="Everyone here is emailed about every event you have switched on below."
            disabled={restricted}
          >
            <TagInput
              label="Default recipients"
              values={draft.recipients}
              disabled={restricted}
              placeholder="sales@yourdomain.com"
              validate={validateEmail}
              normalize={(value) => value.trim().toLowerCase()}
              onValuesChange={(values) => set('recipients', values)}
            />
          </Field>

          {!restricted ? (
            <div>
              <Switch
                size="sm"
                label="Route some events elsewhere"
                description="Send qualified leads, handoffs or offline messages to different inboxes."
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
              {showOverrides ? (
                <div className="mt-4 space-y-5 border-t border-border pt-4">
                  <Field
                    label="Qualified leads go to"
                    hint="Leave empty to use the default recipients."
                  >
                    <TagInput
                      label="Qualified lead recipients"
                      values={draft.qualifiedLead}
                      placeholder="sales@yourdomain.com"
                      validate={validateEmail}
                      normalize={(value) => value.trim().toLowerCase()}
                      onValuesChange={(values) => set('qualifiedLead', values)}
                    />
                  </Field>
                  <Field
                    label="Handoff requests go to"
                    hint="Leave empty to use the default recipients."
                  >
                    <TagInput
                      label="Handoff request recipients"
                      values={draft.handoff}
                      placeholder="support@yourdomain.com"
                      validate={validateEmail}
                      normalize={(value) => value.trim().toLowerCase()}
                      onValuesChange={(values) => set('handoff', values)}
                    />
                  </Field>
                  <Field
                    label="Offline messages go to"
                    hint="Leave empty to use the default recipients."
                  >
                    <TagInput
                      label="Offline message recipients"
                      values={draft.offline}
                      placeholder="inbox@yourdomain.com"
                      validate={validateEmail}
                      normalize={(value) => value.trim().toLowerCase()}
                      onValuesChange={(values) => set('offline', values)}
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardBody>
        {/* A `CardSection`, not a second card: two cards over one draft would
            need two save bars, and a page with two save bars for one form is a
            page where the user cannot tell which button keeps their work. */}
        <CardSection className="space-y-4">
          <div>
            <h3 className="text-base font-semibold text-text-primary">What we email about</h3>
            <p className="mt-1 text-xs text-text-secondary">
              Switched off means no email. The event still happens, and still fires webhooks.
            </p>
          </div>
          <Switch
            label="A lead qualifies"
            description="Someone reached the qualified tier and is worth calling."
            checked={draft.onQualified}
            onCheckedChange={(next) => set('onQualified', next)}
          />
          <Switch
            label="A visitor asks for a person"
            description="Sent the moment a handoff is requested, so somebody can pick it up."
            checked={draft.onHandoff}
            onCheckedChange={(next) => set('onHandoff', next)}
          />
          <Switch
            label="A visitor leaves a message while you are away"
            description="The offline form's submissions."
            checked={draft.onOffline}
            onCheckedChange={(next) => set('onOffline', next)}
          />
          <Switch
            label="Confirm to the visitor that we got their message"
            description="A short receipt to the visitor, not to you."
            checked={draft.visitorConfirmation}
            onCheckedChange={(next) => set('visitorConfirmation', next)}
          />
          <Switch
            label="Attach the conversation transcript"
            description="Includes the full exchange in the notification. Useful for context; think about it if your inbox is shared widely."
            checked={draft.transcript}
            onCheckedChange={(next) => set('transcript', next)}
          />
        </CardSection>
        <SaveBar
          variant="footer"
          dirty={dirty}
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={() => setDraft(baseline)}
        />
      </Card>
    </Stack>
  );
}
