/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { UpgradeModal } from '../design-system/components/UpgradeModal';
import { UPGRADE_INTENTS, type AddBotIntentParams, type UpgradeIntent, type UpgradeIntentKey } from './upgradeIntents';
import type { FeatureKey } from '../types/domain';

/**
 * Escape-hatch payload for callers that need bespoke one-off copy without a
 * registry entry. `feature` (when present) drives the generic fallback title
 * when `title`/`description` are omitted.
 */
export interface UpgradeModalReason {
  feature?: FeatureKey;
  title?: string;
  description?: string;
}

export type { UpgradeIntent, UpgradeIntentKey, AddBotIntentParams };

/**
 * UpgradeModalContext — the global trigger for the premium upsell dialog.
 *
 * Ported from the legacy `context/UpgradeModalContext.jsx` intent registry
 * (see `upgradeIntents.ts`) onto the new design system. Callers get a
 * one-line API:
 *
 *   const { openUpgradeModal } = useUpgradeModal();
 *   openUpgradeModal('add_bot', { current: bots.length, planName });
 *
 * A known `UpgradeIntentKey` resolves to its registry copy; anything else
 * (a plain `UpgradeModalReason` object) is the escape hatch for copy that
 * doesn't justify a registry entry. Unknown string keys fail open — dev
 * console warning plus a generic-but-honest fallback — rather than silently
 * dropping the click.
 *
 * The provider keeps a single piece of state (`content`) — non-null means the
 * modal is open. We deliberately do NOT queue: only one upsell is shown at a
 * time, the most recent request wins, so a user who trips two gates in the
 * same flow doesn't see a modal stack.
 */
export interface UpgradeModalContextValue {
  /** Open the upgrade modal with a known intent key (+ its params) or a raw reason. */
  openUpgradeModal: (intent: UpgradeIntentKey | UpgradeModalReason, params?: AddBotIntentParams) => void;
  close: () => void;
  isOpen: boolean;
}

const UpgradeModalContext = createContext<UpgradeModalContextValue | null>(null);

function humanizeFeature(key: FeatureKey): string {
  return key
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Normalize the escape-hatch `UpgradeModalReason` shape into the same
 * `UpgradeIntent` shape the registry produces, so the modal only ever
 * renders one kind of content. */
function reasonToIntent(reason: UpgradeModalReason): UpgradeIntent {
  const featureLabel = reason.feature ? humanizeFeature(reason.feature) : null;
  return {
    eyebrow: featureLabel ? `${featureLabel} is a paid feature` : 'Upgrade required',
    title: reason.title ?? (featureLabel ? `${featureLabel} is a paid feature` : 'Upgrade your plan'),
    description: reason.description ?? 'Upgrade your plan to unlock this for your workspace.',
    highlights: [],
    recommendedPlan: '',
  };
}

/** Fail-open fallback for an unrecognized intent key — still surfaces
 * something rather than silently dropping the click. */
function genericFallback(): UpgradeIntent {
  return {
    eyebrow: 'Upgrade required',
    title: 'Upgrade your plan',
    description: 'This feature is available on paid plans.',
    highlights: [],
    recommendedPlan: 'Starter',
  };
}

export function UpgradeModalProvider({ children }: { children: ReactNode }): ReactElement {
  const [content, setContent] = useState<UpgradeIntent | null>(null);

  const close = useCallback((): void => setContent(null), []);

  const openUpgradeModal = useCallback(
    (intent: UpgradeIntentKey | UpgradeModalReason, params?: AddBotIntentParams): void => {
      if (typeof intent === 'string') {
        const builder = (UPGRADE_INTENTS as Record<string, ((p?: AddBotIntentParams) => UpgradeIntent) | undefined>)[
          intent
        ];
        if (!builder) {
          if (import.meta.env.DEV) {
            console.warn(`[UpgradeModal] Unknown intent key: ${intent}`);
          }
          setContent(genericFallback());
          return;
        }
        setContent(builder(params));
        return;
      }
      setContent(reasonToIntent(intent));
    },
    [],
  );

  const value = useMemo<UpgradeModalContextValue>(
    () => ({ openUpgradeModal, close, isOpen: content !== null }),
    [openUpgradeModal, close, content],
  );

  return (
    <UpgradeModalContext.Provider value={value}>
      {children}
      <UpgradeModal open={content !== null} content={content} onClose={close} />
    </UpgradeModalContext.Provider>
  );
}

export function useUpgradeModal(): UpgradeModalContextValue {
  const ctx = useContext(UpgradeModalContext);
  if (!ctx) {
    throw new Error('useUpgradeModal must be used inside <UpgradeModalProvider>');
  }
  return ctx;
}
