import { useCallback } from 'react';
import { Card, CardBody, ErrorState, Page, PageHeader, SaveBar, Skeleton, Stack } from '../../../ui';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getClientSettings, updateBot } from '../../../services/api';
import { useSettingsDraft } from './useSettingsDraft';
import { ScopeSection } from './ScopeSection';
import { WidgetBehaviourSection } from './WidgetBehaviourSection';
import { OperatorResponseSection } from './OperatorResponseSection';
import { TimingSection } from './TimingSection';
import { BlockedCapabilitiesSection } from './BlockedCapabilitiesSection';
import {
  type BehaviourDraft,
  operatorTimeoutError,
  parseBehaviour,
  toBehaviourPayload,
} from './behaviour.config';

const TITLE = 'Behaviour';
const DESCRIPTION =
  'How strictly this chatbot answers, what the widget offers, and how it holds up when the connection does not.';

function BehaviourSkeleton() {
  return (
    <Page width="wide">
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <Stack>
        {[0, 1, 2].map((index) => (
          <Card key={index}>
            <CardBody className="space-y-3">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-3 w-full max-w-md" />
              <Skeleton className="h-16 w-full" />
            </CardBody>
          </Card>
        ))}
      </Stack>
    </Page>
  );
}

function BehaviourContent({ agentId, liveChatAllowed }: { agentId: number; liveChatAllowed: boolean }) {
  const { isFree } = useEntitlements();

  const load = useCallback(async (id: number): Promise<BehaviourDraft> => {
    return parseBehaviour(await getClientSettings(id));
  }, []);

  const save = useCallback(async (id: number, draft: BehaviourDraft) => {
    await updateBot(id, toBehaviourPayload(draft));
  }, []);

  const state = useSettingsDraft<BehaviourDraft>({ agentId, load, save });
  const draft = state.draft;

  // `update` is stable where `state` is not, so the memoised sections below
  // actually stay memoised instead of taking a fresh callback every render.
  const { update } = state;
  const setThreshold = useCallback(
    (relevanceThreshold: number | null) =>
      update((previous) => ({ ...previous, relevanceThreshold })),
    [update],
  );
  const setFlag = useCallback(
    (key: string, next: boolean) =>
      update((previous) => ({
        ...previous,
        featureFlags: { ...previous.featureFlags, [key]: next },
      })),
    [update],
  );
  const setOperatorTimeout = useCallback(
    (operatorTimeoutSeconds: number) =>
      update((previous) => ({ ...previous, operatorTimeoutSeconds })),
    [update],
  );
  const setConfigField = useCallback(
    (key: string, storedValue: number) =>
      update((previous) => ({
        ...previous,
        widgetConfig: { ...previous.widgetConfig, [key]: storedValue },
      })),
    [update],
  );

  if (state.loadError) {
    return (
      <Page width="wide">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <Card>
          <ErrorState
            title="We could not load this chatbot's behaviour settings"
            description={state.loadError}
            onRetry={state.retry}
          />
        </Card>
      </Page>
    );
  }

  if (!draft) return <BehaviourSkeleton />;

  // The one field on this page the server will reject outright. Everything else
  // is clamped as it is typed, so it cannot reach an invalid state at all.
  const timeoutError = operatorTimeoutError(draft.operatorTimeoutSeconds);

  return (
    <Page width="wide">
      <PageHeader title={TITLE} description={DESCRIPTION} />

      <Stack>
        <ScopeSection value={draft.relevanceThreshold} onChange={setThreshold} />

        <WidgetBehaviourSection
          agentId={agentId}
          flags={draft.featureFlags}
          isFree={isFree}
          liveChatAllowed={liveChatAllowed}
          onToggle={setFlag}
        />

        <OperatorResponseSection
          value={draft.operatorTimeoutSeconds}
          liveChatAllowed={liveChatAllowed}
          onChange={setOperatorTimeout}
        />

        <TimingSection
          config={draft.widgetConfig}
          onChange={setConfigField}
        />

        <BlockedCapabilitiesSection />

        <SaveBar
          dirty={state.dirty}
          saving={state.saving}
          saved={state.saved}
          saveError={state.saveError}
          blockedReason={
            timeoutError
              ? `The operator response window must be between 5 and 3600 seconds. ${draft.operatorTimeoutSeconds} would be rejected.`
              : null
          }
          onSave={() => void state.commit()}
          onDiscard={state.discard}
          guard="this chatbot’s behaviour settings"
        />
      </Stack>
    </Page>
  );
}

/**
 * Behaviour — the technical corner of a chatbot, and deliberately only that.
 *
 * It replaces the "Advanced" tab, which read as here-be-dragons and was a
 * hard-locked dead end on the Free plan: the whole page rendered one upgrade
 * card, including the answering-scope control that works on every plan. Nothing
 * on this page is plan-gated as a whole any more. What a plan *does* change —
 * the Free plan overriding every widget flag, live chat gating the operator
 * window — is stated on the control it affects.
 *
 * Qualification is no longer here. It decides which conversations a salesperson
 * hears about, which makes it a revenue surface, and it has its own page.
 */
export function BehaviourPage() {
  const { agent, loading, error, refresh } = useAgent();
  const { hasFeature, loading: entitlementsLoading } = useEntitlements();

  if (entitlementsLoading || (loading && !agent)) return <BehaviourSkeleton />;

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

  return (
    <BehaviourContent
      key={agent.id}
      agentId={agent.id}
      liveChatAllowed={hasFeature('live_chat')}
    />
  );
}
