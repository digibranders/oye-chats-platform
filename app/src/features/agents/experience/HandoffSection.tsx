import { type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Grid,
  Input,
  LoadingRows,
  Select,
  SettingGroup,
  SettingRow,
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
import { useTranslation } from '../../../i18n/useTranslation';

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
  const { t } = useTranslation();
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
        // A `Card` whose only child is a `CardHeader` paints a doubled,
        // square-ended hairline across its own rounded bottom edge.
        <Card>
          <CardBody>
            <LoadingRows rows={2} />
          </CardBody>
        </Card>
      ) : !liveChatIncluded ? (
        <SettingGroup title={t('agents.talkingToAPerson') || 'Talking to a person'} titleAs="h2">
          <SettingRow
            label={t('agents.letVisitorsAskForA') || 'Let visitors ask for a person'}
            badge={<Badge tone="plan">Starter and above</Badge>}
            description={t('agents.visitorsCanAskForA') || 'Visitors can ask for a person and land in your inbox.'}
            controlWidth="auto"
          >
            <Link to="/billing" className={buttonClass('secondary', 'sm')}>
              {t('agents.comparePlans') || 'Compare plans'}
            </Link>
          </SettingRow>
        </SettingGroup>
      ) : (
        <Card>
          <CardHeader eyebrow="Live chat" titleAs="h2" title={t('agents.talkingToAPerson') || 'Talking to a person'} />
          <CardBody className="flex flex-col gap-5">
            {chatbotOnFree ? (
              <Alert tone="warning" title={`This chatbot is on the ${meta.planName} plan`}>
                Your workspace includes live chat, but plans are per chatbot and this one does not
                have it — visitors will not be offered a person until it is on a paid plan.
              </Alert>
            ) : null}
            <Switch
              label={t('agents.letVisitorsAskForA') || 'Let visitors ask for a person'}
              description={t('agents.conversationsArriveInYourInbox') || 'Conversations arrive in your inbox.'}
              checked={draft.liveChatEnabled}
              disabled={readOnly}
              onCheckedChange={(liveChatEnabled) => onChange({ liveChatEnabled })}
            />

            {draft.liveChatEnabled ? (
              <>
                <Field
                  label={t('agents.whileTheyWait') || 'While they wait'}
                  hint={t('agents.shownFromTheMomentThey') || 'Shown from the moment they ask until someone accepts.'}
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

                <Field label={t('agents.whenNobodyIsAvailable') || 'When nobody is available'} hint={t('agents.whenNobodyOnYourTeam') || 'When nobody on your team is online.'}>
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
                  label={t('agents.offerTheHandoff') || 'Offer the handoff'}
                  hint={t('agents.delayBeforeTheFormAppears') || 'Delay before the form appears.'}
                  className="max-w-xs"
                >
                  <Select
                    label={t('agents.offerTheHandoff') || 'Offer the handoff'}
                    options={HANDOFF_DELAY_OPTIONS}
                    value={String(draft.handoffDelaySeconds)}
                    disabled={readOnly}
                    onValueChange={(value) => onChange({ handoffDelaySeconds: toInt(value) })}
                  />
                </Field>

                <Grid cols={2}>
                  <Field
                    label={t('agents.giveUpWaitingAfter') || 'Give up waiting after'}
                    error={errors.queueTimeoutSeconds ?? null}
                    className="max-w-xs"
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
                    label={t('agents.mostPeopleWaitingAtOnce') || 'Most people waiting at once'}
                    hint={t('agents.pastItVisitorsGetThe') || 'Past it, visitors get the offline form.'}
                    error={errors.maxQueueSize ?? null}
                    className="max-w-xs"
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
                </Grid>
              </>
            ) : null}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          eyebrow="Availability"
          titleAs="h2"
          title={t('agents.whenSomeoneIsThere') || 'When someone is there'}
          description={t('agents.thisChatbotsOwnHours') || 'This chatbot\'s own hours.'}
        />
        <CardBody className="flex flex-col gap-4">
          {!entitlementsLoading && isFree ? (
            // Business hours only govern the offline banner, which is a live-chat
            // concept — Free has no live chat, so the schedule is inert. Shown
            // locked with the same Starter+ nudge the rest of this section uses.
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <Badge tone="plan">Starter and above</Badge>
                <p className="mt-2 text-prose text-text-secondary">
                  {t('agents.businessHoursLocked') ||
                    'Set the hours this chatbot is staffed and show an offline banner outside them.'}
                </p>
              </div>
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                {t('agents.comparePlans') || 'Compare plans'}
              </Link>
            </div>
          ) : (
            <>
              {errors.businessHours ? (
                <Alert tone="danger" title={t('agents.thisScheduleWouldNeverOpen') || 'This schedule would never open'}>
                  {errors.businessHours}
                </Alert>
              ) : null}
              <BusinessHoursField
                value={draft.businessHours}
                onChange={(businessHours) => onChange({ businessHours })}
                errors={errors}
                disabled={readOnly}
              />
            </>
          )}
        </CardBody>
      </Card>

      {!entitlementsLoading && isFree ? (
        <SettingGroup title={t('agents.whatToAskBeforeThe') || 'What to ask before the chat starts'} titleAs="h2">
          <SettingRow
            label={t('agents.askBeforeChatting') || 'Ask before chatting'}
            badge={<Badge tone="plan">Starter and above</Badge>}
            description={t('agents.everyChatArrivesWithA') || 'Every chat arrives with a name and a way to reply.'}
            controlWidth="auto"
          >
            <Link to="/billing" className={buttonClass('secondary', 'sm')}>
              {t('agents.comparePlans') || 'Compare plans'}
            </Link>
          </SettingRow>
        </SettingGroup>
      ) : (
        <Card>
          <CardHeader
            eyebrow="Lead form"
            titleAs="h2"
            title={t('agents.whatToAskBeforeThe') || 'What to ask before the chat starts'}
            description={t('agents.everyFieldYouAddIs') || 'Every field you add is one more reason to close the window.'}
          />
          <CardBody className="flex flex-col gap-5">
            <Switch
              label={t('agents.askBeforeChatting') || 'Ask before chatting'}
              checked={draft.leadFormEnabled}
              disabled={readOnly}
              onCheckedChange={(leadFormEnabled) => onChange({ leadFormEnabled })}
            />

            {draft.leadFormEnabled ? (
              <fieldset className="min-w-0">
                <legend className="text-base font-medium text-text-primary">{t('agents.fieldsToCollect') || 'Fields to collect'}</legend>
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
                            label={t('agents.required') || 'Required'}
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
