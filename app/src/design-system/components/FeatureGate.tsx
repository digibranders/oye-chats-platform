import type { ReactElement, ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { Button } from '../primitives/Button';
import { PlanBadge } from './PlanBadge';
import { LockedFeatureCard as RichLockedFeatureCard, type TeaserIntentKey } from './LockedFeatureCard';
import type { FeatureKey } from '../../types/domain';

export interface FeatureGateProps {
  /** The flag on `entitlements.features` this gate checks, e.g. "live_chat". */
  feature: FeatureKey;
  children: ReactNode;
  /**
   * The upgrade-intent registry key for this gate's copy (see
   * `context/upgradeIntents.ts`). When set, the default locked fallback
   * renders the richer `LockedFeatureCard` (eyebrow, headline, highlights)
   * and the upgrade modal opens with this intent's specific copy instead of
   * the generic `{ feature }` reason. Excludes `add_bot` (an action-limit
   * intent that needs live params) - a feature gate never gates on it.
   */
  intent?: TeaserIntentKey;
  /**
   * Rendered when locked. Defaults to a built-in upgrade card. Pass `null`
   * to render nothing at all - good for sidebar items that should simply
   * disappear rather than show a locked affordance.
   */
  fallback?: ReactNode;
  /**
   * Rendered while entitlements are loading. Defaults to `children`
   * (optimistic) so the page doesn't flicker on every render - the backend
   * still enforces the gate, so a brief over-render just means a friendly
   * 402 on action instead of silent breakage.
   */
  loadingFallback?: ReactNode;
  /** Display-only plan name shown in the default locked card, e.g. "Starter". */
  requiredPlan?: string;
}

function humanize(key: FeatureKey): string {
  return key
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface DefaultLockedCardProps {
  feature: FeatureKey;
  requiredPlan?: string;
  planName: string;
  onUpgrade: () => void;
}

/** Fallback upgrade card used when the gate has no `intent` (so there's no
 * registry copy to pull a richer teaser from). Designed to fit inside
 * content areas - for sidebar items, pass `fallback={null}` to the gate
 * instead of relying on this. */
function DefaultLockedCard({ feature, requiredPlan, planName, onUpgrade }: DefaultLockedCardProps): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-[var(--ds-radius-xl)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
        <Lock size={20} aria-hidden="true" />
      </span>

      <div className="max-w-md space-y-1.5">
        <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">{humanize(feature)} is locked</h3>
        <p className="flex flex-wrap items-center justify-center gap-x-1 text-[13px] text-[var(--ds-text-muted)]">
          <span>
            {requiredPlan
              ? `Available on ${requiredPlan}. Upgrade to unlock for your workspace.`
              : 'Upgrade your plan to unlock this for your workspace.'}{' '}
            You&rsquo;re on the
          </span>
          <PlanBadge planName={planName} />
        </p>
      </div>

      <Button onClick={onUpgrade}>See plans</Button>
    </div>
  );
}

/**
 * FeatureGate - wraps children behind a plan feature check (mandate shared
 * component). Renders the children unchanged when the workspace's plan
 * includes `feature`; otherwise renders `fallback` (or a locked card) and,
 * on interaction with its CTA, opens the upgrade modal.
 *
 * When `intent` is set, the locked fallback is the richer, registry-backed
 * `LockedFeatureCard` (eyebrow, headline, highlights, all pulled from
 * `UPGRADE_INTENTS`) and the modal opens with that intent's specific copy.
 * Without `intent`, it falls back to the plainer generic locked card.
 *
 * Ported from the legacy `components/FeatureGate.jsx`, restyled to the new
 * design system and driven by `useEntitlements()` / `useUpgradeModal()`
 * instead of the legacy module-scope hook + intent registry.
 *
 * Usage:
 *   <FeatureGate feature="webhooks" intent="webhooks_integration"><WebhookManager /></FeatureGate>
 *   <FeatureGate feature="bant" fallback={null}><SidebarItem /></FeatureGate>
 */
export function FeatureGate({
  feature,
  intent,
  children,
  fallback,
  loadingFallback,
  requiredPlan,
}: FeatureGateProps): ReactNode {
  const { hasFeature, loading, planName } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();

  if (loading) {
    return loadingFallback !== undefined ? loadingFallback : children;
  }

  if (hasFeature(feature)) {
    return children;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  if (intent) {
    return <RichLockedFeatureCard intent={intent} />;
  }

  return (
    <DefaultLockedCard
      feature={feature}
      requiredPlan={requiredPlan}
      planName={planName}
      onUpgrade={() => openUpgradeModal({ feature })}
    />
  );
}
