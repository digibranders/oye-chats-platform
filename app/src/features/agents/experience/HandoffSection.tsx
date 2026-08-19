import { type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Input,
  LockedState,
  Select,
  Switch,
  Textarea,
  buttonClass,
} from '../../../ui';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { BusinessHoursField } from './BusinessHoursField';
import {
  HANDOFF_DELAY_OPTIONS,
  LEAD_FIELD_LABELS,
  LEAD_FIELD_ORDER,
  LIMITS,
  MAX_QUEUE,
  PLACEHOLDERS,
  QUEUE_TIMEOUT,
  type DraftErrors,
  type ExperienceDraft,
  type ExperienceMeta,
  type LeadFieldName,
} from './experience-model';

/**
 * What happens when the chatbot is not enough.
 *
 * Live chat, the hours a person is actually there, and the form a visitor fills
 * in before the conversation starts. They sit together because they are one
 * decision from the visitor's side — "can I reach a human, and what do you want
 * from me first" — even though they are three unrelated columns on the record.
 */

export interface HandoffSectionProps {
  draft: ExperienceDraft;
  meta: ExperienceMeta;
  errors: DraftErrors;
  readOnly: boolean;
  onChange: (patch: Partial<ExperienceDraft>) => void;
}

function toInt(raw: string): number {
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? 0 : value;
}

export function HandoffSection({
  draft,
  meta,
  errors,
  readOnly,
  onChange,
}: HandoffSectionProps): ReactElement {
  const { hasFeature, isFree, loading: entitlementsLoading } = useEntitlements();
  const liveChatIncluded = hasFeature('live_chat');
  /**
   * Billing attaches to the chatbot, not to the workspace, and
   * `entitlements.plan_slug` reports the highest-priced plan across all of
   * them. So a paid workspace can hold a Free chatbot whose own widget config
   * is resolved with `get_bot_entitlements` and will not carry live chat — the
   * switch below would save happily and change nothing a visitor sees. The gate
   * still follows the workspace, as the rest of the console does; what is added
   * here is saying so out loud.
   */
  const chatbotOnFree = meta.planSlug === 'free';

  const toggleLeadField = (name: LeadFieldName, on: boolean): void => {
    onChange({
      leadFormFields: on
        ? draft.leadFormFields.some((row) => row.field === name)
          ? draft.leadFormFields
          : [...draft.leadFormFields, { field: name, required: false }]
        : draft.leadFormFields.filter((row) => row.field !== name),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {entitlementsLoading ? (
        <Card>
          <CardHeader
            eyebrow="Live chat"
            titleAs="h2"
            title="Talking to a person"
            description="Checking what your plan includes…"
          />
        </Card>
      ) : !liveChatIncluded ? (
        <LockedState
          title="Live chat is on Starter and above"
          description="Visitors can ask for a person, land in your inbox, and carry on the same conversation with someone from your team. Until then the chatbot answers on its own and the handoff controls are not offered — anything set here would never reach a visitor."
          action={
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              Compare plans
            </Link>
          }
        />
      ) : (
        <Card>
          <CardHeader
            eyebrow="Live chat"
            titleAs="h2"
            title="Talking to a person"
            description="Whether a visitor can ask for someone from your team, and what they see while they wait."
          />
          <CardBody className="flex flex-col gap-5">
            {chatbotOnFree ? (
              <Alert tone="warning" title={`This chatbot is on the ${meta.planName} plan`}>
                Your workspace includes live chat, but plans are per chatbot and this one does not
                have it — visitors will not be offered a person until it is on a paid plan.
              </Alert>
            ) : null}
            <Switch
              label="Let visitors ask for a person"
              description="Adds the live chat control to the widget. Conversations arrive in your inbox."
              checked={draft.liveChatEnabled}
              disabled={readOnly}
              onCheckedChange={(liveChatEnabled) => onChange({ liveChatEnabled })}
            />

            {draft.liveChatEnabled ? (
              <>
                <Field
                  label="While they wait"
                  hint="Shown from the moment they ask until someone accepts."
                >
                  <Textarea
                    rows={2}
                    value={draft.waitingMessage}
                    maxLength={LIMITS.waitingMessage}
                    disabled={readOnly}
                    placeholder={PLACEHOLDERS.waitingMessage}
                    onChange={(event) => onChange({ waitingMessage: event.target.value })}
                  />
                </Field>

                <Field
                  label="When nobody is available"
                  hint="The reply when a visitor asks for a person and none of your team is online. Different from the widget's general offline banner, which is on the Messages tab."
                >
                  <Textarea
                    rows={2}
                    value={draft.handoffOfflineMessage}
                    maxLength={LIMITS.handoffOfflineMessage}
                    disabled={readOnly}
                    placeholder={PLACEHOLDERS.handoffOfflineMessage}
                    onChange={(event) => onChange({ handoffOfflineMessage: event.target.value })}
                  />
                </Field>

                <Field
                  label="Offer the handoff"
                  hint="How long the chatbot waits after suggesting a person before showing the form."
                >
                  <Select
                    options={HANDOFF_DELAY_OPTIONS}
                    value={String(draft.handoffDelaySeconds)}
                    disabled={readOnly}
                    onChange={(event) =>
                      onChange({ handoffDelaySeconds: toInt(event.target.value) })
                    }
                    className="max-w-xs"
                  />
                </Field>

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field
                    label="Give up waiting after"
                    hint={`Between ${QUEUE_TIMEOUT.min} and ${QUEUE_TIMEOUT.max} seconds.`}
                    error={errors.queueTimeoutSeconds ?? null}
                  >
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={QUEUE_TIMEOUT.min}
                      max={QUEUE_TIMEOUT.max}
                      step={5}
                      value={draft.queueTimeoutSeconds}
                      disabled={readOnly}
                      onChange={(event) =>
                        onChange({ queueTimeoutSeconds: toInt(event.target.value) })
                      }
                      trailing={<span className="text-xs">sec</span>}
                      className="figure"
                    />
                  </Field>
                  <Field
                    label="Most people waiting at once"
                    hint={`Between ${MAX_QUEUE.min} and ${MAX_QUEUE.max}. Past it, visitors are offered the offline form instead of a queue.`}
                    error={errors.maxQueueSize ?? null}
                  >
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={MAX_QUEUE.min}
                      max={MAX_QUEUE.max}
                      step={1}
                      value={draft.maxQueueSize}
                      disabled={readOnly}
                      onChange={(event) => onChange({ maxQueueSize: toInt(event.target.value) })}
                      className="figure"
                    />
                  </Field>
                </div>
              </>
            ) : null}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          eyebrow="Availability"
          titleAs="h2"
          title="When someone is there"
          description="This chatbot's own hours. Every chatbot in the workspace keeps its own — a support bot and a sales bot rarely keep the same ones."
        />
        <CardBody className="flex flex-col gap-4">
          {errors.businessHours ? (
            <Alert tone="danger" title="This schedule would never open">
              {errors.businessHours}
            </Alert>
          ) : null}
          <BusinessHoursField
            value={draft.businessHours}
            onChange={(businessHours) => onChange({ businessHours })}
            errors={errors}
            disabled={readOnly}
          />
        </CardBody>
      </Card>

      {!entitlementsLoading && isFree ? (
        <LockedState
          title="The pre-chat form is on Starter and above"
          description="Ask a visitor for their details before the conversation starts, and every chat arrives with a name and a way to reply. Leads are not stored on the Free plan, so the form has nowhere to put what it collects."
          action={
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              Compare plans
            </Link>
          }
        />
      ) : (
        <Card>
          <CardHeader
            eyebrow="Lead form"
            titleAs="h2"
            title="What to ask before the chat starts"
            description="A short form shown to a new visitor. Every field you add is one more reason to close the window, so ask for as little as you can."
          />
          <CardBody className="flex flex-col gap-5">
            <Switch
              label="Ask before chatting"
              description="New visitors fill this in before their first message."
              checked={draft.leadFormEnabled}
              disabled={readOnly}
              onCheckedChange={(leadFormEnabled) => onChange({ leadFormEnabled })}
            />

            {draft.leadFormEnabled ? (
              <fieldset className="min-w-0">
                <legend className="text-base font-medium text-text-primary">Fields to collect</legend>
                <ul className="mt-2.5 flex flex-col">
                  {LEAD_FIELD_ORDER.map((name) => {
                    const row = draft.leadFormFields.find((field) => field.field === name);
                    return (
                      <li
                        key={name}
                        className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-2.5 first:border-t-0"
                      >
                        <Checkbox
                          label={LEAD_FIELD_LABELS[name]}
                          checked={row !== undefined}
                          disabled={readOnly}
                          onCheckedChange={(checked) => toggleLeadField(name, checked === true)}
                        />
                        {row ? (
                          <Checkbox
                            label="Required"
                            checked={row.required}
                            disabled={readOnly}
                            onCheckedChange={(checked) =>
                              onChange({
                                leadFormFields: draft.leadFormFields.map((field) =>
                                  field.field === name
                                    ? { ...field, required: checked === true }
                                    : field,
                                ),
                              })
                            }
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ) : null}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
