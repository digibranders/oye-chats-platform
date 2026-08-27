import type { ReactElement } from 'react';
import { ArrowRight, Lock, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { UPGRADE_INTENTS, type UpgradeIntentKey } from '../../context/upgradeIntents';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Every teaser-safe intent. `add_bot` is excluded because its copy needs
 * live `{ current, planName }` params this component can't supply - it's an
 * action-gate intent, not a teaser one.
 */
export type TeaserIntentKey = Exclude<UpgradeIntentKey, 'add_bot'>;

export interface LockedFeatureCardProps {
  /** Which `UPGRADE_INTENTS` registry entry supplies this card's copy. */
  intent: TeaserIntentKey;
  /** Icon for the accent tile. Defaults to a lock glyph. */
  icon?: LucideIcon;
  className?: string;
}

/**
 * LockedFeatureCard - a premium teaser for a plan-gated surface (mandate
 * shared component). Pulls its headline, description, and highlights
 * straight from the `UPGRADE_INTENTS` registry so every locked surface in
 * the app shows the SAME specific copy the upgrade modal shows for that
 * intent - a soft accent tile, a "plan feature" eyebrow, a headline, up to
 * three benefit bullets, and an upgrade CTA. Restrained by design: no
 * gradients, no glow, no crown - matches the DS upgrade modal's visual
 * language at teaser scale.
 *
 * The `intent` prop excludes `add_bot` at the type level - it needs live
 * `{ current, planName }` params this component doesn't collect. Every other
 * intent is param-less and renders correctly out of the box.
 */
export function LockedFeatureCard({ intent, icon: Icon = Lock, className }: LockedFeatureCardProps): ReactElement {
  const { t } = useTranslation();
  const { openUpgradeModal } = useUpgradeModal();
  const copy = UPGRADE_INTENTS[intent]();
  // Prefer the registry's own eyebrow so the teaser and the modal show the
  // same kicker for a given intent; derive one from the plan only when the
  // registry entry has no eyebrow.
  const eyebrow = copy.eyebrow || (copy.recommendedPlan ? `${copy.recommendedPlan} feature` : t('ds.locked.proFeature') || 'Pro feature');

  return (
    <div
      className={cn(
        'flex flex-col items-start gap-4 rounded-[var(--ds-radius-xl)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-5',
        className,
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-[var(--ds-radius-sm)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-muted)]">
        <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
      </span>

      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ds-accent-text)]">
          {eyebrow}
        </p>
        <h3 className="text-[15px] font-semibold leading-snug text-[var(--ds-text)]">{copy.title}</h3>
        <p className="text-[13px] leading-relaxed text-[var(--ds-text-muted)]">{copy.description}</p>
      </div>

      {copy.highlights.length > 0 && (
        <ul className="space-y-1.5">
          {copy.highlights.slice(0, 3).map((line) => (
            <li key={line} className="flex items-start gap-2 text-[12.5px] text-[var(--ds-text-muted)]">
              <span
                className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--ds-text-subtle)]"
                aria-hidden="true"
              />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => openUpgradeModal(intent)}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:text-[var(--ds-accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
      >
        {t('ds.locked.upgrade') || 'Upgrade to unlock'}
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
