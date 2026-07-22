import type { ReactElement, ReactNode } from 'react';
import { Lock, Sparkles } from 'lucide-react';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { Button } from '../primitives/Button';
import { PlanBadge } from './PlanBadge';
import type { FeatureKey } from '../../types/domain';

export interface FeatureGateProps {
  /** The flag on `entitlements.features` this gate checks, e.g. "live_chat". */
  feature: FeatureKey;
  children: ReactNode;
  /**
   * Rendered when locked. Defaults to a built-in upgrade card. Pass `null`
   * to render nothing at all — good for sidebar items that should simply
   * disappear rather than show a locked affordance.
   */
  fallback?: ReactNode;
  /**
   * Rendered while entitlements are loading. Defaults to `children`
   * (optimistic) so the page doesn't flicker on every render — the backend
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

interface LockedFeatureCardProps {
  feature: FeatureKey;
  requiredPlan?: string;
  planName: string;
  onUpgrade: () => void;
}

/** Default upgrade card. Designed to fit inside content areas — for sidebar
 * items, pass `fallback={null}` to the gate instead of relying on this. */
function LockedFeatureCard({ feature, requiredPlan, planName, onUpgrade }: LockedFeatureCardProps): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-[var(--ds-radius-xl)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-6 py-10 text-center">
      <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
        <Lock size={20} aria-hidden="true" />
        <Sparkles size={12} className="absolute -right-1 -top-1" aria-hidden="true" />
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
 * FeatureGate — wraps children behind a plan feature check (mandate shared
 * component). Renders the children unchanged when the workspace's plan
 * includes `feature`; otherwise renders `fallback` (or the built-in locked
 * card) and, on interaction with its CTA, opens the upgrade modal.
 *
 * Ported from the legacy `components/FeatureGate.jsx`, restyled to the new
 * design system and driven by `useEntitlements()` / `useUpgradeModal()`
 * instead of the legacy module-scope hook + intent registry.
 *
 * Usage:
 *   <FeatureGate feature="webhooks"><WebhookManager /></FeatureGate>
 *   <FeatureGate feature="bant" fallback={null}><SidebarItem /></FeatureGate>
 */
export function FeatureGate({ feature, children, fallback, loadingFallback, requiredPlan }: FeatureGateProps): ReactNode {
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

  return (
    <LockedFeatureCard
      feature={feature}
      requiredPlan={requiredPlan}
      planName={planName}
      onUpgrade={() => openUpgradeModal({ feature })}
    />
  );
}
