import { useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Columns,
  ErrorState,
  Eyebrow,
  Field,
  LockedState,
  Measure,
  Page,
  PageHeader,
  PropertyGrid,
  SaveBar,
  Select,
  Skeleton,
  Stack,
  Switch,
  buttonClass,
} from '../../../ui';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import {
  planIncludesEmailVerification,
  planIncludesVisitorIntelligence,
} from '../../../lib/planGates';
import { getClientSettings, getFrameworkPresets, updateBot } from '../../../services/api';
import { useSettingsDraft } from './useSettingsDraft';
import { DimensionsSection } from './DimensionsSection';
import { ThresholdsSection } from './ThresholdsSection';
import { TierOutcomesSection } from './TierOutcomesSection';
import { SignalsSection } from './SignalsSection';
import { LeadEnrichmentSection } from './LeadEnrichmentSection';
import { FunnelSection } from './FunnelSection';
import { FRAMEWORK_OPTIONS } from './qualification.config';
import {
  type QualificationDraft,
  enrichmentChanged,
  isRecord,
  parseQualification,
  presetKeysFor,
  scoringChanged,
  toEnrichmentPayload,
  toScoringPayload,
} from './qualification.draft';
import { useTierOutcomes } from './useTierOutcomes';
import { parseModel, validateModel } from './qualification.model';

const TITLE = 'Qualification';

/** The draft plus the server's framework catalog, loaded together. */
interface QualificationLoad {
  draft: QualificationDraft;
  /** `GET /bots/{id}/framework-presets` — the catalog, keyed by framework. */
  presets: Record<string, unknown>;
}

/** Two columns, the shape the page actually arrives in. */
function QualificationSkeleton() {
  return (
    <Page>
      <PageHeader title={TITLE} />
      <Columns
        asideWidth="sm"
        aside={
          <Stack>
            {[0, 1].map((index) => (
              <Card key={index}>
                <CardBody className="space-y-3">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-24 w-full" />
                </CardBody>
              </Card>
            ))}
          </Stack>
        }
        main={
          <Stack>
            {[0, 1, 2].map((index) => (
              <Card key={index}>
                <CardBody className="space-y-3">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-16 w-full" />
                </CardBody>
              </Card>
            ))}
          </Stack>
        }
      />
    </Page>
  );
}

function QualificationContent({ agentId, planSlug }: { agentId: number; planSlug: string }) {
  const { hasFeature } = useEntitlements();

  const load = useCallback(async (id: number): Promise<QualificationLoad> => {
    const [settings, presets] = await Promise.all([
      getClientSettings(id),
      // A catalog failure must not take the page down with it: the editor still
      // works from the stored config, it just cannot offer a fresh preset.
      getFrameworkPresets(id).catch(() => ({}) as Record<string, unknown>),
    ]);
    return { draft: parseQualification(settings, presets ?? {}), presets: presets ?? {} };
  }, []);

  const save = useCallback(
    async (id: number, next: QualificationLoad, previous: QualificationLoad) => {
      const tasks: Array<Promise<unknown>> = [];
      if (enrichmentChanged(next.draft, previous.draft)) {
        tasks.push(updateBot(id, toEnrichmentPayload(next.draft)));
      }
      if (scoringChanged(next.draft, previous.draft)) {
        tasks.push(updateBot(id, toScoringPayload(next.draft)));
      }
      await Promise.all(tasks);
    },
    [],
  );

  const state = useSettingsDraft<QualificationLoad>({ agentId, load, save });
  const outcomes = useTierOutcomes(agentId);

  const value = state.draft;
  const draft = value?.draft ?? null;

  // `update` is stable; `state` is a fresh object every render. Depending on the
  // object would give every section a new callback on each keystroke and defeat
  // the `memo` on all of them — which matters here because a rubric with six
  // dimensions and five answers each is around sixty controls, and typing one
  // digit into a threshold should not re-render all of them.
  const { update } = state;
  const setDraft = useCallback(
    (updater: (previous: QualificationDraft) => QualificationDraft) => {
      update((previous) => ({ ...previous, draft: updater(previous.draft) }));
    },
    [update],
  );

  const setModel = useCallback(
    (model: QualificationDraft['model']) => setDraft((previous) => ({ ...previous, model })),
    [setDraft],
  );
  const setThresholds = useCallback(
    (thresholds: QualificationDraft['model']['thresholds']) =>
      setDraft((previous) => ({ ...previous, model: { ...previous.model, thresholds } })),
    [setDraft],
  );
  const setDecay = useCallback(
    (decay: QualificationDraft['model']['decay']) =>
      setDraft((previous) => ({ ...previous, model: { ...previous.model, decay } })),
    [setDraft],
  );
  const setBehavioral = useCallback(
    (behavioral: QualificationDraft['model']['behavioral']) =>
      setDraft((previous) => ({ ...previous, model: { ...previous.model, behavioral } })),
    [setDraft],
  );
  const setEmailVerification = useCallback(
    (next: boolean) => setDraft((previous) => ({ ...previous, emailVerificationEnabled: next })),
    [setDraft],
  );
  const setCompanyLookup = useCallback(
    (next: boolean) => setDraft((previous) => ({ ...previous, companyLookupEnabled: next })),
    [setDraft],
  );

  const validation = useMemo(
    () =>
      draft
        ? validateModel(draft.model)
        : { dimensions: {}, thresholds: {}, behavioralMaxScore: null, blockedReason: null },
    [draft],
  );

  const presetKeys = useMemo(
    () => (value ? presetKeysFor(value.presets, value.draft.framework) : []),
    [value],
  );

  if (state.loadError) {
    return (
      <Page>
        <PageHeader title={TITLE} />
        <ErrorState
          framed
          title="We could not load this chatbot's qualification settings"
          description={state.loadError}
          onRetry={state.retry}
        />
      </Page>
    );
  }

  if (!value || !draft) return <QualificationSkeleton />;

  // Scoring is off, so nothing below it is in effect — but it stays readable.
  // Every control is `disabled` rather than the subtree being `inert`: disabled
  // controls are still announced, with their state, while `inert` would remove
  // the entire rubric from assistive tech, so a screen-reader user could not
  // read the configuration they were about to switch on. It blocks editing just
  // as effectively, which is the actual bug being closed here — a tab used to
  // reach the framework picker of a chatbot whose scoring was off, and changing
  // it marked the page dirty and PATCHed the rubric.
  const configDisabled = !draft.enabled;

  return (
    <Page>
      <PageHeader
        title={TITLE}
        // The master switch governs the whole page, not one card, so it lives in
        // the page header — with the state as a word beside it, because a bare
        // toggle floating at the right of a card header names nothing.
        description={
          draft.enabled ? undefined : 'Scoring is off. Leads are still captured, but nothing is scored.'
        }
        actions={
          <>
            {draft.enabled ? null : <Badge tone="neutral">Scoring off</Badge>}
            <span className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">{draft.enabled ? 'On' : 'Off'}</span>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(next) => setDraft((previous) => ({ ...previous, enabled: next }))}
                label="Score leads on this chatbot"
                hideLabel
              />
            </span>
            <Link to="/leads" className={buttonClass('secondary', 'sm')}>
              Scored leads
            </Link>
          </>
        }
      />

      <Stack>
        <Columns
          asideWidth="sm"
          stickyAside
          asideLabel="What this scoring produces"
          main={
            <Stack>
              <Card>
                <CardHeader
                  title="Lead scoring"
                  titleAs="h2"
                  description="Scores each conversation out of 100."
                />
                <CardBody>
                  <Field
                    disabled={configDisabled}
                    label="Framework"
                    hint={
                      FRAMEWORK_OPTIONS.find((option) => option.key === draft.framework)?.summary ??
                      'Choosing a framework replaces the dimensions below.'
                    }
                    className="max-w-md"
                  >
                    <Select
                      label="Framework"
                      disabled={configDisabled}
                      value={draft.framework}
                      options={FRAMEWORK_OPTIONS.map((option) => ({
                        value: option.key,
                        label: option.label,
                      }))}
                      onValueChange={(key) => {
                        setDraft((previous) => {
                          const preset = isRecord(value.presets[key])
                            ? (value.presets[key] as Record<string, unknown>)
                            : null;
                          return {
                            ...previous,
                            framework: key,
                            // Switching framework adopts that framework's model.
                            // A MEDDIC bot keeping BANT's four dimensions would
                            // be scored against dimensions its own prompt never
                            // asks about.
                            model: parseModel(preset, key, preset),
                          };
                        });
                      }}
                    />
                  </Field>
                </CardBody>
              </Card>

              <DimensionsSection
                model={draft.model}
                onChange={setModel}
                validation={validation}
                presetKeys={presetKeys}
                disabled={configDisabled}
              />

              <ThresholdsSection
                thresholds={draft.model.thresholds}
                onChange={setThresholds}
                validation={validation}
                disabled={configDisabled}
              />

              <SignalsSection
                model={draft.model}
                onDecayChange={setDecay}
                onBehavioralChange={setBehavioral}
                validation={validation}
                disabled={configDisabled}
              />
            </Stack>
          }
          aside={
            <Stack>
              {/* The receipt, beside the thresholds it grades. */}
              <FunnelSection agentId={agentId} />

              <TierOutcomesSection
                state={outcomes}
                agentId={agentId}
                webhooksAllowed={hasFeature('webhooks')}
              />

              <LeadEnrichmentSection
                emailVerificationEnabled={draft.emailVerificationEnabled}
                onToggleEmailVerification={setEmailVerification}
                emailVerificationPlanAllows={planIncludesEmailVerification(planSlug)}
                companyLookupEnabled={draft.companyLookupEnabled}
                onToggleCompanyLookup={setCompanyLookup}
                companyLookupPlanAllows={planIncludesVisitorIntelligence(planSlug)}
              />
            </Stack>
          }
        />

        <SaveBar
          dirty={state.dirty}
          saving={state.saving}
          saved={state.saved}
          saveError={state.saveError}
          // Only the scoring rubric can be invalid; the enrichment switches
          // cannot. When scoring is switched off the rubric is not sent at all,
          // so an invalid one must not hold the enrichment toggles hostage.
          blockedReason={draft.enabled ? validation.blockedReason : null}
          onSave={() => void state.commit()}
          onDiscard={state.discard}
          guard="this chatbot’s lead qualification"
        />
      </Stack>
    </Page>
  );
}

/**
 * Qualification — promoted out of the old "Advanced" tab, because it decides
 * which conversations a salesperson is told about and is therefore a revenue
 * surface, not a technical one.
 *
 * The page it replaces was one card inside a five-section technical page, with
 * the whole scoring model hidden behind a modal, and it answered none of the
 * three questions a customer actually has: what is the AI listening for, what
 * does a score have to reach, and who finds out when it does.
 *
 * **Two columns, because the evidence belongs beside the setting.** As eight
 * stacked cards it ran about 4,000px, with `FunnelSection` — the receipt for the
 * thresholds, and the file's own doc comment says so — roughly 2,500px below the
 * thresholds it grades. You cannot tune a threshold you cannot see the result
 * of.
 */
export function QualificationPage() {
  const { agent, loading, error, refresh } = useAgent();
  const { isFree, loading: entitlementsLoading, hasFeature, planName } = useEntitlements();

  // The plan resolves after first paint, and the Free fallback is restrictive,
  // so a paid workspace deep-linking here must not flash the locked card.
  if (entitlementsLoading || (loading && !agent)) return <QualificationSkeleton />;

  if (!agent) {
    return (
      <Page>
        <PageHeader title={TITLE} />
        <ErrorState
          framed
          title={error ? 'We could not load this chatbot' : 'Chatbot not found'}
          description={
            error
              ? error.message || 'Something went wrong while loading this workspace.'
              : 'This chatbot does not exist, or it belongs to a workspace you cannot see.'
          }
          onRetry={() => void refresh()}
        />
      </Page>
    );
  }

  if (isFree || !hasFeature('bant')) {
    return (
      <Page>
        <PageHeader title={TITLE} />
        {/* A reading measure. `LockedState size="page"` draws its own card and
            centres about 400px of copy in it, so at the page's full width the
            card was 1,128px of white around one paragraph — the emptiest surface
            in the console saying the least. */}
        <Measure width="reading">
          <LockedState
            title="Lead scoring is not included on your plan"
            description={`Your workspace is on ${planName || 'a plan'} without lead qualification. On Standard and above, the chatbot scores each visitor and emails you the ones worth calling.`}
            action={
              <Link to="/billing" className={buttonClass('primary', 'sm')}>
                See plans
              </Link>
            }
            preview={
              // A `PropertyGrid`, not three dimmed sentences: what is behind the
              // lock is three named things, and naming them left-to-right is
              // both shorter and closer to the shape of the page it previews.
              // `px-cell` matches the state's own body, so the two share a left
              // edge inside the one bordered box.
              <div className="px-cell pb-1 pt-5">
                <Eyebrow>What you would configure</Eyebrow>
                <PropertyGrid
                  className="mt-2"
                  items={[
                    { label: 'Dimensions', value: 'Four, each with the answers that earn points' },
                    { label: 'Thresholds', value: 'Where a lead turns marketing-, sales-accepted, or sales-qualified' },
                    { label: 'When one turns hot', value: 'Who is emailed, and which webhook fires' },
                  ]}
                />
              </div>
            }
          />
        </Measure>
      </Page>
    );
  }

  return (
    <QualificationContent
      // Keyed on the chatbot, so switching remounts rather than showing one
      // chatbot's rubric under another's name for a frame.
      key={agent.id}
      agentId={agent.id}
      planSlug={agent.plan_slug ?? ''}
    />
  );
}
