import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Card,
  CardBody,
  Columns,
  ErrorState,
  Page,
  PageHeader,
  SaveBar,
  SettingGroup,
  Skeleton,
  Stack,
  buttonClass,
} from '../../../ui';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { getClientSettings, updateBot } from '../../../services/api';
import { useSettingsDraft } from './useSettingsDraft';
import { ScopeSection } from './ScopeSection';
import { WidgetBehaviourSection } from './WidgetBehaviourSection';
import { OperatorResponseSection } from './OperatorResponseSection';
import { TimingSection } from './TimingSection';
import { FollowUpSection } from './FollowUpSection';
import {
  type BehaviourDraft,
  operatorTimeoutError,
  parseBehaviour,
  toBehaviourPayload,
} from './behaviour.config';

const TITLE = 'Behaviour';

/** One block per real group, so the page does not grow when the data lands. */
function BehaviourSkeleton() {
  return (
    <Page>
      <PageHeader title={TITLE} />
      <Stack>
        {[0, 1, 2, 3].map((index) => (
          <Card key={index}>
            <CardBody className="space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-row w-full" />
              <Skeleton className="h-row w-full" />
            </CardBody>
          </Card>
        ))}
      </Stack>
    </Page>
  );
}

function BehaviourContent({
  agentId,
  agentName,
  liveChatAllowed,
}: {
  agentId: number;
  agentName: string;
  liveChatAllowed: boolean;
}) {
  const { isFree } = useEntitlements();

  const load = useCallback(async (id: number): Promise<BehaviourDraft> => {
    return parseBehaviour(await getClientSettings(id));
  }, []);

  // One PATCH. This page used to send a second for the access slice; those three
  // columns are edited on Deploy ▸ Access now, under that page's own draft.
  const save = useCallback(
    async (id: number, draft: BehaviourDraft) => {
      await updateBot(id, toBehaviourPayload(draft));
    },
    [],
  );

  const state = useSettingsDraft<BehaviourDraft>({ agentId, load, save });
  const draft = state.draft;
  const initial = state.initial;

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
      <Page>
        <PageHeader title={TITLE} />
        <ErrorState
          framed
          title="We could not load this chatbot's behaviour settings"
          description={state.loadError}
          onRetry={state.retry}
        />
      </Page>
    );
  }

  if (!draft || !initial) return <BehaviourSkeleton />;

  // The one field the server will reject outright. Everything else is clamped as
  // it is typed, so it cannot reach an invalid state at all.
  const timeoutError = operatorTimeoutError(draft.operatorTimeoutSeconds);

  return (
    <Page>
      <PageHeader title={TITLE} eyebrow={agentName} />

      {/* Two tracks, like every other tab in this shell.

          This page used to wrap everything in `Measure width="form"`, and it
          was the only tab that did: measured at 1440, Overview, Knowledge,
          Experience, Deploy and Qualification all fill 1,152px of the 1,216
          available and this one filled 672, leaving 512px — 42% of the content
          area — empty beside a column that then ran a screen and a half tall.
          Tabbing between Experience and Behaviour visibly changed the width of
          the page, which reads as a broken shell rather than as a choice.

          The form itself is not what was wrong: `main` still lands at ~740px,
          which is the form measure, near enough. What changed is that the
          timing knobs — a collapsed disclosure nobody opens on most visits —
          stop taking a full-width turn in the primary column and move to the
          aside, where `Columns` already had room. The save bar sits outside the
          grid for the reason `ExperiencePage` states at its own: it spans the
          form it saves. */}
      <Columns
        asideWidth="md"
        stickyAside
        asideLabel="Timing"
        main={
          <Stack>
          <SettingGroup title="Answering">
            <ScopeSection value={draft.relevanceThreshold} onChange={setThreshold} />
            <OperatorResponseSection
              value={draft.operatorTimeoutSeconds}
              liveChatAllowed={liveChatAllowed}
              onChange={setOperatorTimeout}
            />
          </SettingGroup>

          <SettingGroup
            title="What the widget offers"
            description={
              isFree
                ? 'These are switched off for visitors on the Free plan. They are saved, but ignored by the widget until you upgrade.'
                : undefined
            }
            actions={
              isFree ? (
                <>
                  <Badge tone="plan">Off on Free</Badge>
                  <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                    See plans
                  </Link>
                </>
              ) : undefined
            }
          >
            <WidgetBehaviourSection
              agentId={agentId}
              flags={draft.featureFlags}
              liveChatAllowed={liveChatAllowed}
              onToggle={setFlag}
              locked={isFree}
            />
            {/* Its own read and its own write, deliberately outside the draft: a
                kill switch takes effect when it is pressed, not when a save bar at
                the bottom of a long page is eventually noticed. */}
            <FollowUpSection agentId={agentId} />
          </SettingGroup>

          </Stack>
        }
        aside={<TimingSection config={draft.widgetConfig} onChange={setConfigField} />}
      />

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
 * **It is rows, not cards.** Six full-width cards, each with a title and a
 * description, carried ten controls between them: roughly 900px of chrome to
 * reach six switches, three numbers and a segmented control. A settings page is
 * one card per *group* and one row per *setting*.
 *
 * **Access is not here.** The origin allow-list and the session-continuity
 * parent spent a release on this page and are on Deploy ▸ Access now, beside the
 * install status that sends people looking for them. They kept the single-draft,
 * single-save-bar contract they were given here; what they left behind was the
 * per-card Save button, which was the actual defect.
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

  return (
    <BehaviourContent
      key={agent.id}
      agentId={agent.id}
      agentName={agent.name}
      liveChatAllowed={hasFeature('live_chat')}
    />
  );
}
