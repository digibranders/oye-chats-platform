import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, RefreshCw, RotateCw, Sparkles } from 'lucide-react';

/**
 * Two-mode recrawl action for an ingested URL source.
 *
 * Renders the same subtle icon-button + hover-tooltip the KnowledgeBase row
 * uses today, but clicking now opens a small popover with two options:
 *
 *   1. Full recrawl        — Re-scrape every page, charge per page.
 *                            Available to every tier.
 *   2. Updated pages only  — Skip pages whose content hasn't changed since
 *                            the last crawl. Standard+ only; Free / Starter
 *                            see the option dimmed with an inline upgrade CTA.
 *
 * The upgrade CTA is intentionally shown to non-entitled users (not hidden)
 * so the feature is discoverable — this is a load-bearing upsell surface, not
 * a hidden capability.
 *
 * Plan gating on the backend (`enforce_delta_recrawl` in `plan_service.py`)
 * is the security boundary. This component is a UX affordance only.
 *
 * @param {object} props
 * @param {string} props.planSlug — Entitlements plan slug ('free' | 'starter' | 'standard' | 'enterprise').
 * @param {() => void} props.onFullRecrawl — Called when the user picks "Full recrawl".
 * @param {() => void} props.onDeltaRecrawl — Called when the user picks "Updated pages only" AND is entitled.
 * @param {() => void} [props.onUpgradeClick] — Called when a non-entitled user clicks the upgrade CTA.
 * @param {boolean} [props.loading] — Show a spinner instead of the RefreshCw icon; disables the trigger.
 * @param {boolean} [props.disabled] — Hard-disable the trigger (e.g. crawl already running).
 */
// Popover width in px — must match the Tailwind class below (w-72 = 18rem).
const POPOVER_WIDTH = 288;
// Gap between the trigger's bottom edge and the popover's top edge.
const POPOVER_GAP = 6;

export default function RecrawlMenu({
  planSlug,
  onFullRecrawl,
  onDeltaRecrawl,
  onUpgradeClick,
  loading = false,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  // {top, left} viewport coords for the fixed-position popover. Null until the
  // trigger rect has been measured — first paint of the popover is skipped
  // until we have real coordinates so it never flashes in at (0,0).
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);

  const canUseDelta =
    planSlug === 'standard' || planSlug === 'enterprise';

  // Right-align the popover to the trigger's right edge, drop it below with
  // a small gap. Clamped to the viewport so it never renders offscreen on a
  // narrow window (e.g. a mobile Chrome DevTools resize).
  const measureCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.right - POPOVER_WIDTH),
      window.innerWidth - POPOVER_WIDTH - 8,
    );
    return { top: rect.bottom + POPOVER_GAP, left };
  }, []);

  // Reposition the portal when the window (or any scrollable ancestor such
  // as the containing table) scrolls or the viewport resizes. ``capture:
  // true`` on scroll catches events from ancestor overflow containers that
  // never bubble to window. Only setState fires here — the initial coords
  // are set inside the toggle handler, which side-steps React's "setState
  // synchronously in an effect" warning by moving the first measure out of
  // the effect body entirely.
  useEffect(() => {
    if (!open) return undefined;
    const onScroll = () => {
      const next = measureCoords();
      if (next) setCoords(next);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, measureCoords]);

  // Close on outside click. Escape key also closes so keyboard users don't
  // get stuck inside the menu. Now that the popover lives in a portal,
  // ``containerRef.current.contains(...)`` misses clicks inside the popover
  // itself — the target is portalled out of the container's subtree. So
  // check both the trigger and the popover explicitly.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      const inTrigger = triggerRef.current?.contains(e.target);
      const inPopover = popoverRef.current?.contains(e.target);
      if (!inTrigger && !inPopover) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleFull = () => {
    setOpen(false);
    onFullRecrawl?.();
  };

  const handleDelta = () => {
    if (!canUseDelta) {
      // Non-entitled users still get a click affordance — route them to
      // the upgrade flow rather than silently doing nothing.
      onUpgradeClick?.();
      return;
    }
    setOpen(false);
    onDeltaRecrawl?.();
  };

  const popover = (
    <AnimatePresence>
      {open && coords && (
        <motion.div
          ref={popoverRef}
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.12 }}
          role="menu"
          aria-label="Re-crawl options"
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            width: POPOVER_WIDTH,
          }}
          className="z-[9999] rounded-xl border border-surface-200 dark:border-surface-700 bg-[var(--bg-card)] dark:bg-surface-900 shadow-xl overflow-hidden"
        >
            <button
              type="button"
              role="menuitem"
              onClick={handleFull}
              className="w-full text-left px-3.5 py-3 hover:bg-surface-50 dark:hover:bg-surface-800/60 transition-colors flex gap-3 items-start"
            >
              <div className="shrink-0 mt-0.5 w-8 h-8 rounded-lg bg-primary-500/10 text-primary-500 flex items-center justify-center">
                <RotateCw size={14} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-surface-900 dark:text-white">
                  Full recrawl
                </div>
                <div className="text-[11px] text-surface-500 dark:text-surface-400 mt-0.5">
                  Re-scrape every page. Charged for all pages.
                </div>
              </div>
            </button>

            <div className="h-px bg-surface-200 dark:bg-surface-700/60" />

            <button
              type="button"
              role="menuitem"
              onClick={handleDelta}
              className={`w-full text-left px-3.5 py-3 transition-colors flex gap-3 items-start ${
                canUseDelta
                  ? 'hover:bg-surface-50 dark:hover:bg-surface-800/60'
                  : 'hover:bg-amber-50/60 dark:hover:bg-amber-500/5'
              }`}
            >
              <div
                className={`shrink-0 mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center ${
                  canUseDelta
                    ? 'bg-emerald-500/10 text-emerald-500'
                    : 'bg-amber-500/10 text-amber-500'
                }`}
              >
                <Sparkles size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div
                    className={`text-sm font-medium ${
                      canUseDelta
                        ? 'text-surface-900 dark:text-white'
                        : 'text-surface-500 dark:text-surface-400'
                    }`}
                  >
                    Updated pages only
                  </div>
                  {/* The badge is a plan-tier hint for users who don't have
                      the feature yet. Standard / Enterprise callers already
                      have delta — showing "STANDARD" to them is redundant
                      and reads as a "coming soon" badge on a feature they
                      can use right now. Hide it for entitled tiers. */}
                  {!canUseDelta && (
                    <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                      Standard
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-surface-500 dark:text-surface-400 mt-0.5">
                  {canUseDelta
                    ? 'Only re-scrape pages whose content changed since the last crawl.'
                    : 'Upgrade to Standard to re-crawl only pages that changed.'}
                </div>
              </div>
            </button>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className="relative group inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (disabled || loading) return;
          if (!open) {
            // Measure right here so the very first paint of the portal
            // already has real coords — avoids a one-frame flash at (0,0)
            // and keeps setState out of a useLayoutEffect body (which the
            // React Compiler flags as a cascading-render smell).
            const next = measureCoords();
            if (next) setCoords(next);
          } else {
            setCoords(null);
          }
          setOpen((v) => !v);
        }}
        disabled={disabled || loading}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Re-crawl options"
        className="p-1.5 rounded-lg text-surface-400 hover:text-primary-500 hover:bg-primary-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <Loader2 size={14} className="animate-spin text-primary-500" />
        ) : (
          <RefreshCw size={14} />
        )}
      </button>

      {/* Hover tooltip — matches the sibling delete/preview buttons.
          Hidden while the popover is open so the two chrome elements
          don't stack awkwardly. */}
      {!open && (
        <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded-md bg-surface-900 text-white text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
          Re-crawl
        </span>
      )}

      {typeof document !== 'undefined' ? createPortal(popover, document.body) : null}
    </div>
  );
}
