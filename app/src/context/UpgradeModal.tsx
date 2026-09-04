import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { Badge, Button, Dialog } from '../ui';
import { useEntitlements } from '../hooks/useEntitlements';
import { getSubscriptionPlans } from '../services/api';
import { renderPriceLabel, type PlanRow } from '../features/workspace/billing/planPricing';
import type { UpgradeIntent } from './upgradeIntents';
import { t as translateNow } from '../i18n/i18n';

export interface UpgradeModalProps {
  open: boolean;
  /** Resolved copy — a registry intent or the normalized escape-hatch reason. `null` while closed. */
  content: UpgradeIntent | null;
  onClose: () => void;
}

// Module-scoped so every gate in the app shares one fetch instead of
// re-requesting `/subscriptions/plans` on each open.
let plansPromise: Promise<PlanRow[]> | null = null;

function loadPlans(): Promise<PlanRow[]> {
  if (!plansPromise) {
    plansPromise = getSubscriptionPlans()
      .then((rows) => rows as unknown as PlanRow[])
      .catch(() => {
        // Transient failure: clear the cache so a later open retries rather
        // than being stuck name-only forever. This render still degrades to
        // the plain plan name.
        plansPromise = null;
        return [];
      });
  }
  return plansPromise;
}

/**
 * The one upsell surface, shown by every plan gate.
 *
 * Rebuilt on `src/ui`'s `Dialog`, which brings the focus trap, the Escape
 * contract and the one modal shape the console has. It keeps the substance of
 * the version it replaces — per-feature copy from the intent registry, and the
 * real target plan name and price resolved from `/subscriptions/plans` when
 * that list is available — and drops nothing else, because there was nothing
 * else: no crown, no sparkles, no gradient.
 *
 * Brass, not blue. `plan` is the console's one reserved tone for plan,
 * entitlement and upgrade surfaces, and spending the interactive accent on an
 * upsell would make "this costs money" and "this is a link" the same colour.
 */
export function UpgradeModal({ open, content, onClose }: UpgradeModalProps) {
  const navigate = useNavigate();
  const { planName } = useEntitlements();
  const [plans, setPlans] = useState<PlanRow[] | null>(null);

  // Best-effort only: if the list never loads, or no plan matches, the chip
  // falls back to the plain `recommendedPlan` name from the intent copy.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    void loadPlans().then((rows) => {
      if (!cancelled) setPlans(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const targetPlan = useMemo(() => {
    if (!plans || !content?.recommendedPlan) return null;
    return (
      plans.find((plan) => plan.name?.toLowerCase() === content.recommendedPlan.toLowerCase()) ??
      null
    );
  }, [plans, content]);

  if (!content) return null;

  const targetLabel = targetPlan
    ? `${targetPlan.name} · ${renderPriceLabel(targetPlan, 'monthly', null, true)}/mo`
    : content.recommendedPlan;

  function seePlans() {
    onClose();
    navigate('/billing');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={content.title}
      description={content.description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {translateNow('app.notNow') || 'Not now'}
          </Button>
          <Button
            onClick={seePlans}
            iconRight={<ArrowRight aria-hidden className="h-3.5 w-3.5 rtl:-scale-x-100" />}
          >
            {translateNow('app.seePlans') || 'See plans'}
          </Button>
        </>
      }
    >
      {/* A sentence, not an `Eyebrow`: the registry's eyebrows are statements
          about the workspace ("You already have 1 AI Chatbot on Free"), and
          11px uppercase mono is a label style that mangles a sentence. */}
      {content.eyebrow ? <p className="text-base text-text-secondary">{content.eyebrow}</p> : null}

      {content.highlights.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {content.highlights.map((line) => (
            <li key={line} className="flex items-start gap-2.5 text-base text-text-primary">
              <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {content.recommendedPlan ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
          <Badge tone="neutral">{planName}</Badge>
          <ArrowRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary rtl:-scale-x-100" />
          <Badge tone="plan">{targetLabel}</Badge>
        </div>
      ) : null}
    </Dialog>
  );
}
