import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';
import { Modal } from './Modal';
import { PlanBadge } from './PlanBadge';
import { Button } from '../primitives/Button';
import { useEntitlements } from '../../hooks/useEntitlements';
import type { FeatureKey } from '../../types/domain';

/** What triggered the modal — drives its copy. All fields optional so a bare
 * limit-reached gate (no specific feature) still renders sensible defaults. */
export interface UpgradeModalReason {
  /** The locked feature flag, if this was a `FeatureGate`. Omit for limit gates. */
  feature?: FeatureKey;
  /** Overrides the default title. */
  title?: string;
  /** Overrides the default description. */
  description?: string;
}

export interface UpgradeModalProps {
  open: boolean;
  reason: UpgradeModalReason | null;
  onClose: () => void;
}

function humanizeFeature(key: FeatureKey | undefined): string | null {
  if (!key) return null;
  return key
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * UpgradeModal — the single premium upsell surface used by every gate
 * (mandate shared component, built on the `Modal` primitive). Ported from
 * the legacy `components/UpgradeModal.jsx`, restyled to the new design
 * system: shows the current plan, the locked capability, and a primary CTA
 * that closes the modal and routes to Workspace → Billing.
 */
export function UpgradeModal({ open, reason, onClose }: UpgradeModalProps): ReactElement | null {
  const navigate = useNavigate();
  const { planName } = useEntitlements();

  if (!open) return null;

  const featureLabel = humanizeFeature(reason?.feature);
  const title = reason?.title ?? (featureLabel ? `${featureLabel} is a paid feature` : 'Upgrade your plan');
  const description =
    reason?.description ?? 'Upgrade your plan to unlock this for your workspace.';

  const handleUpgrade = (): void => {
    onClose();
    navigate('/workspace/billing');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Maybe later
          </Button>
          <Button onClick={handleUpgrade}>
            See plans &amp; upgrade
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
          <Lock size={20} aria-hidden="true" />
        </span>
        <p className="flex items-center gap-1.5 text-[13px] text-[var(--ds-text-muted)]">
          You&rsquo;re currently on the <PlanBadge planName={planName} />
        </p>
      </div>
    </Modal>
  );
}
