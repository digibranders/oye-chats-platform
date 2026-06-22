import { Link } from 'react-router-dom';
import { Lock, ArrowRight, Sparkles } from 'lucide-react';
import useEntitlements from '../hooks/useEntitlements';
import { cn } from '../lib/utils';

/**
 * FeatureGate — wraps children behind a plan feature check.
 *
 * Renders the children unchanged when the workspace's plan includes the
 * named feature. Otherwise replaces them with an upgrade card (or
 * `fallback` if supplied) that links to /billing.
 *
 * Usage:
 *
 *   <FeatureGate feature="webhooks">
 *     <WebhookManager />
 *   </FeatureGate>
 *
 *   <FeatureGate feature="bant" fallback={null}>
 *     <Sidebar.Item to="/qualification" label="Qualification" />
 *   </FeatureGate>
 *
 * Behavior summary:
 *  - `feature`        — the name on `plan.features` (e.g. "live_chat", "webhooks").
 *  - `fallback`       — optional ReactNode to render when locked. Defaults to the
 *                       built-in upgrade card. Pass `null` to render nothing at all
 *                       (good for sidebar items that should simply disappear).
 *  - `loadingFallback`— optional ReactNode while entitlements are loading.
 *                       Defaults to rendering children (optimistic) so the page
 *                       doesn't flicker on every render.
 *  - `requiredPlan`   — display-only string shown in the upgrade card
 *                       ("Available on Standard"). If omitted, the card just
 *                       says "Upgrade to unlock".
 */
export default function FeatureGate({
    feature,
    children,
    fallback,
    loadingFallback,
    requiredPlan,
}) {
    const { entitlements, loading } = useEntitlements();

    if (loading) {
        // Optimistic: render children. The risk of briefly showing a paid
        // feature to a Free user is acceptable — backend still enforces the
        // gate, so they get a friendly 403 on action, not silent breakage.
        return loadingFallback !== undefined ? loadingFallback : children;
    }

    if (entitlements.hasFeature(feature)) {
        return children;
    }

    // Caller wants the gated children to simply vanish (sidebar items, menu
    // entries). Returning `null` is intentional — no upgrade card here.
    if (fallback !== undefined) {
        return fallback;
    }

    return (
        <LockedFeatureCard featureName={feature} requiredPlan={requiredPlan} currentPlan={entitlements.planSlug} />
    );
}


/**
 * Default upgrade card. Designed to fit inside content areas (cards,
 * sections, page bodies). For sidebar items, pass `fallback={null}` to
 * the gate instead of relying on this.
 */
function LockedFeatureCard({ featureName, requiredPlan, currentPlan }) {
    return (
        <div
            className={cn(
                'flex flex-col items-center justify-center gap-4 px-6 py-10 rounded-2xl',
                'bg-gradient-to-br from-primary-50 to-surface-50 dark:from-primary-900/20 dark:to-surface-900',
                'border border-primary-100 dark:border-primary-800/40 text-center',
            )}
        >
            <div className="relative">
                <div className="w-12 h-12 rounded-full bg-primary-100 dark:bg-primary-900/40 flex items-center justify-center">
                    <Lock size={20} className="text-primary-600 dark:text-primary-400" />
                </div>
                <Sparkles
                    size={14}
                    className="absolute -top-1 -right-1 text-primary-500 dark:text-primary-300"
                />
            </div>

            <div className="max-w-md">
                <h3 className="text-base font-semibold text-surface-900 dark:text-surface-50">
                    {humanize(featureName)} is locked
                </h3>
                <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
                    {requiredPlan
                        ? `Available on ${requiredPlan}. Upgrade to unlock for your team.`
                        : "Upgrade your plan to unlock this feature."}{' '}
                    You're on the <strong className="text-surface-700 dark:text-surface-300">{capitalize(currentPlan)}</strong> plan.
                </p>
            </div>

            <Link
                to="/billing"
                className={cn(
                    'inline-flex items-center gap-1.5 px-4 py-2 rounded-xl',
                    'bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium',
                    'transition-colors shadow-sm shadow-primary-500/20',
                )}
            >
                See plans
                <ArrowRight size={14} />
            </Link>
        </div>
    );
}

function humanize(name) {
    if (!name) return 'This feature';
    return name
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function capitalize(slug) {
    if (!slug) return 'Free';
    return slug.charAt(0).toUpperCase() + slug.slice(1);
}
