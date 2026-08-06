import type { ReactElement } from 'react';
import { Sparkles } from 'lucide-react';
import { LockedFeatureCard, PageContainer, Skeleton } from '../../design-system';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { PageInfluence } from './PageInfluence';
import { UserJourneyFlow } from './UserJourneyFlow';

/**
 * Plan slugs allowed to view the Journey surface. Mirrors
 * ``JOURNEY_ANALYTICS_SLUGS`` in ``plan_entitlements_service.py`` so a
 * gated visitor sees the upgrade teaser BEFORE any endpoint fires and
 * responds 402 — one clean LockedFeatureCard instead of two stacked
 * ones (UserJourneyFlow and PageInfluence each have their own gated
 * fallback for defence in depth on lower-tier plans that somehow hit
 * this page directly).
 */
const JOURNEY_PLAN_SLUGS = new Set<string>(['standard', 'professional']);

/**
 * JourneyPage — the visitor-journey surface for one agent. Stacks the
 * source → chatbot → destination flow diagram on top and a ranked
 * "Page Influence" panel underneath; both are scoped to the current
 * agent from the shell BotSwitcher. When nothing is picked, each
 * section renders its own empty state.
 *
 * Free / Starter plans see a full-page LockedFeatureCard instead of
 * the sections — data collection still runs on those plans, so an
 * upgrade surfaces prior history immediately.
 */
export function JourneyPage(): ReactElement {
  const { selectedBot } = useBotContext();
  const { planSlug, loading: entitlementsLoading } = useEntitlements();
  const botId = selectedBot?.id ?? null;

  // Wait for entitlements before deciding. Rendering the components
  // before the plan is known would let a gated visitor briefly see the
  // sections while the /entitlements request is in flight.
  const gated = !entitlementsLoading && !JOURNEY_PLAN_SLUGS.has(planSlug);

  return (
    <PageContainer title="Journey" description="Visitor journey flow.">
      {entitlementsLoading ? (
        <Skeleton className="h-[540px]" />
      ) : gated ? (
        <LockedFeatureCard intent="view_journeys" icon={Sparkles} />
      ) : (
        <div className="flex flex-col gap-6">
          <UserJourneyFlow botId={botId} />
          <PageInfluence botId={botId} />
        </div>
      )}
    </PageContainer>
  );
}
