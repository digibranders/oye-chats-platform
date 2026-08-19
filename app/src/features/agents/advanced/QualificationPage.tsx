import { useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  Field,
  LockedState,
  Page,
  PageHeader,
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
import { SaveBar } from './SaveBar';
import { DimensionsSection } from './DimensionsSection';
import { ThresholdsSection } from './ThresholdsSection';
import { TierOutcomesSection } from './TierOutcomesSection';
import { SignalsSection } from './SignalsSection';
import { LeadEnrichmentSection } from './LeadEnrichmentSection';
import { FunnelSection } from './FunnelSection';
import { FRAMEWORK_OPTIONS, frameworkLabel } from './qualification.config';
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
const DESCRIPTION =
  'How this chatbot scores the people it talks to, and what happens when one of them turns out to be worth calling.';

/** The draft plus the server's framework catalog, loaded together. */
interface QualificationLoad {
  draft: QualificationDraft;
  /** `GET /bots/{id}/framework-presets` — the catalog, keyed by framework. */
  presets: Record<string, unknown>;
}

function QualificationSkeleton() {
  return (
    <Page width="wide">
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <Stack>
        {[0, 1, 2].map((index) => (
          <Card key={index}>
            <CardBody className="space-y-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-full max-w-md" />
              <Skeleton className="h-16 w-full" />
            </CardBody>
          </Card>
        ))}
      </Stack>
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
      <Page width="wide">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <Card>
          <ErrorState
            title="We could not load this chatbot's qualification settings"
            description={state.loadError}
            onRetry={state.retry}
          />
        </Card>
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
    <Page width="wide">
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={
          <Link to="/leads" className={buttonClass('secondary', 'md')}>
            See scored leads
          </Link>
        }
      />

      <Stack>
        <Card>
          <CardHeader
            title="Lead scoring"
            titleAs="h2"
            description="While the chatbot answers questions it also listens for buying signals, and scores the conversation out of 100."
            actions={
              <Switch
                checked={draft.enabled}
                onCheckedChange={(next) => setDraft((previous) => ({ ...previous, enabled: next }))}
                label="Score leads on this chatbot"
                hideLabel
              />
            }
          />
          <CardBody className="space-y-4">
            {draft.enabled ? null : (
              <p className="max-w-2xl text-prose text-text-secondary">
                Scoring is off. Conversations are still saved and leads are still captured, but
                nothing is scored, no tier is assigned, and no qualified-lead email or webhook can
                fire.
              </p>
            )}
            <div>
              <Field
                disabled={configDisabled}
                label="Framework"
                hint={
                  FRAMEWORK_OPTIONS.find((option) => option.key === draft.framework)?.summary ??
                  'Choosing a framework replaces the dimensions below with its recommended starting point.'
                }
                className="max-w-md"
              >
                <Select
                  disabled={configDisabled}
                  value={draft.framework}
                  options={FRAMEWORK_OPTIONS.map((option) => ({
                    value: option.key,
                    label: option.label,
                  }))}
                  onChange={(event) => {
                    const key = event.target.value;
                    setDraft((previous) => {
                      const preset = isRecord(value.presets[key])
                        ? (value.presets[key] as Record<string, unknown>)
                        : null;
                      return {
                        ...previous,
                        framework: key,
                        // Switching framework adopts that framework's model. A
                        // MEDDIC bot keeping BANT's four dimensions would be
                        // scored against dimensions its own prompt never asks
                        // about.
                        model: parseModel(preset, key, preset),
                      };
                    });
                  }}
                />
              </Field>
              <p className="mt-3 text-xs text-text-secondary">
                Currently scoring on <Badge tone="neutral">{frameworkLabel(draft.framework)}</Badge>{' '}
                with <span className="figure">{draft.model.order.length}</span> dimensions.
              </p>
            </div>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
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

          <TierOutcomesSection
            state={outcomes}
            agentId={agentId}
            webhooksAllowed={hasFeature('webhooks')}
          />

          <SignalsSection
            model={draft.model}
            onDecayChange={setDecay}
            onBehavioralChange={setBehavioral}
            validation={validation}
            disabled={configDisabled}
          />
        </div>

        <LeadEnrichmentSection
          emailVerificationEnabled={draft.emailVerificationEnabled}
          onToggleEmailVerification={setEmailVerification}
          emailVerificationPlanAllows={planIncludesEmailVerification(planSlug)}
          companyLookupEnabled={draft.companyLookupEnabled}
          onToggleCompanyLookup={setCompanyLookup}
          companyLookupPlanAllows={planIncludesVisitorIntelligence(planSlug)}
        />

        <FunnelSection agentId={agentId} />

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
          surface="lead qualification"
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
 */
export function QualificationPage() {
  const { agent, loading, error, refresh } = useAgent();
  const { isFree, loading: entitlementsLoading, hasFeature, planName } = useEntitlements();

  // The plan resolves after first paint, and the Free fallback is restrictive,
  // so a paid workspace deep-linking here must not flash the locked card.
  if (entitlementsLoading || (loading && !agent)) return <QualificationSkeleton />;

  if (!agent) {
    return (
      <Page width="wide">
        <PageHeader title={TITLE} />
        <Card>
          <ErrorState
            title={error ? 'We could not load this chatbot' : 'Chatbot not found'}
            description={
              error
                ? error.message || 'Something went wrong while loading this workspace.'
                : 'This chatbot does not exist, or it belongs to a workspace you cannot see.'
            }
            onRetry={() => void refresh()}
          />
        </Card>
      </Page>
    );
  }

  if (isFree || !hasFeature('bant')) {
    return (
      <Page width="wide">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <LockedState
          title="Lead scoring is not included on your plan"
          description={`Your workspace is on ${planName || 'a plan'} without lead qualification, so conversations are saved but never scored. On Standard and above the chatbot works out how urgent a visitor's problem is, whether they can buy, and when — then emails you the ones worth calling.`}
          action={
            <Link to="/billing" className={buttonClass('primary', 'md')}>
              See plans
            </Link>
          }
          preview={
            <div className="px-5 py-4">
              <p className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
                What you would configure
              </p>
              <ul className="mt-2 space-y-1.5 text-prose text-text-secondary">
                <li>Four scoring dimensions, each with the answers that earn points.</li>
                <li>The score at which a lead becomes marketing-, sales-accepted, or sales-qualified.</li>
                <li>Who is emailed, and which webhook is called, the moment one turns hot.</li>
              </ul>
            </div>
          }
        />
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
