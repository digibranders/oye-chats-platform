import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Lock } from 'lucide-react';
import { Modal } from './Modal';
import { PlanBadge } from './PlanBadge';
import { StatusBadge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { useEntitlements } from '../../hooks/useEntitlements';
import { getSubscriptionPlans } from '../../services/api';
import { renderPriceLabel, type PlanRow } from '../../features/workspace/billing/planPricing';
import type { UpgradeIntent } from '../../context/upgradeIntents';
import { useTranslation } from '../../i18n/useTranslation';

/** Re-exported so existing imports of `UpgradeModalReason` from the barrel
 * keep resolving - the shape now lives in the context module (the single
 * source of truth for both the escape hatch and the intent registry). */
export type { UpgradeModalReason } from '../../context/UpgradeModalContext';

export interface UpgradeModalProps {
  open: boolean;
  /** Resolved copy - either a registry intent or the normalized escape-hatch reason. `null` while closed. */
  content: UpgradeIntent | null;
  onClose: () => void;
}

// Module-scoped so every modal instance across the app shares one fetch
// instead of re-requesting `/subscriptions/plans` on every open.
let plansPromise: Promise<PlanRow[]> | null = null;

function loadPlans(): Promise<PlanRow[]> {
  if (!plansPromise) {
    plansPromise = getSubscriptionPlans()
      .then((rows) => rows as unknown as PlanRow[])
      .catch(() => {
        // Transient failure: clear the cache so a later modal open retries
        // instead of being stuck name-only forever. This render still
        // degrades gracefully to the plain plan name.
        plansPromise = null;
        return [];
      });
  }
  return plansPromise;
}

/**
 * UpgradeModal - the single premium upsell surface used by every gate
 * (mandate shared component, built on the DS `Modal` shell).
 *
 * Restrained by design: a small lock glyph in a soft accent tile, an
 * uppercase eyebrow, title, description, a benefit checklist, and a
 * current → target plan chip. No crown, no sparkles, no gradient glow - the
 * legacy modal's "moment" theatrics are deliberately NOT ported; the
 * substance (per-feature copy from the intent registry) is.
 */
export function UpgradeModal({ open, content, onClose }: UpgradeModalProps): ReactElement | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { planName } = useEntitlements();
  const [plans, setPlans] = useState<PlanRow[] | null>(null);

  // Resolve the target plan's real name/price once a plan list is available -
  // best-effort only. If it never loads (or no plan matches), the chip simply
  // falls back to the plain `recommendedPlan` name from the intent copy.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    loadPlans().then((rows) => {
      if (!cancelled) setPlans(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const targetPlan = useMemo(() => {
    if (!plans || !content?.recommendedPlan) return null;
    return plans.find((plan) => plan.name?.toLowerCase() === content.recommendedPlan.toLowerCase()) ?? null;
  }, [plans, content]);

  if (!open || !content) return null;

  const targetLabel = targetPlan
    ? `${targetPlan.name} · ${renderPriceLabel(targetPlan, 'monthly', null, true)}/mo`
    : content.recommendedPlan;

  const handleUpgrade = (): void => {
    onClose();
    navigate('/workspace/billing');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={content.title}
      hideHeader
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('ds.upgrade.later') || 'Maybe later'}
          </Button>
          <Button onClick={handleUpgrade}>
            {t('ds.upgrade.seePlans') || 'See plans & upgrade'}
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-col gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--ds-radius-md)] bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
            <Lock size={18} aria-hidden="true" />
          </span>

          <div className="space-y-1.5">
            {content.eyebrow && (
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ds-accent-text)]">
                {content.eyebrow}
              </p>
            )}
            <h2 className="text-[16px] font-semibold leading-snug text-[var(--ds-text)]">{content.title}</h2>
            <p className="text-[13px] leading-relaxed text-[var(--ds-text-muted)]">{content.description}</p>
          </div>
        </div>

        {content.highlights.length > 0 && (
          <ul className="space-y-2">
            {content.highlights.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-[13px] text-[var(--ds-text)]">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--ds-success-soft)] text-[var(--ds-success)]">
                  <Check size={10} strokeWidth={3} aria-hidden="true" />
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}

        {content.recommendedPlan && (
          <div className="flex items-center gap-2.5 rounded-[var(--ds-radius-md)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3 py-2.5">
            <PlanBadge planName={planName} />
            <ArrowRight size={13} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
            <StatusBadge tone="accent">{targetLabel}</StatusBadge>
          </div>
        )}
      </div>
    </Modal>
  );
}
