import { Toaster as SonnerToaster } from 'sonner';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { buttonClass } from '../primitives/buttonStyles';

/**
 * Transient confirmation of something the user just did.
 *
 * The app previously had `sonner` installed and a complete toast implementation
 * written — and never mounted the provider, so for the whole of Admin 2.0 there
 * was no way to confirm an action that completed after the user had navigated
 * away. Every page grew its own inline banner instead.
 *
 * Rules for using it:
 * - A toast confirms; it never explains. If the user must read it to proceed,
 *   it is an inline `Alert` or a dialog, not a toast.
 * - Errors that the user can act on stay on the page, next to the control that
 *   produced them. A toast that disappears after four seconds is the wrong home
 *   for "your card was declined".
 * - Anything destructive that succeeded offers `Undo` where the backend can
 *   support it, because a toast is the only moment the user is still looking.
 *
 * Three things it now does that it did not.
 *
 * **Its buttons are the system's buttons.** `actionButton` and `cancelButton`
 * restated the `secondary` and `ghost` variants by hand — a fourth hand-rolled
 * button style, and a second source of truth for the Undo control. Sonner takes
 * class strings, so `buttonClass` works directly.
 *
 * **Its tones are visible.** Every toast was a white card with a coloured 16px
 * glyph, so a failure passing in the corner of the eye was indistinguishable
 * from a success. "Colour is never the only signal" is not "there should be no
 * signal": the tint carries the tone and the icon and the words carry it too.
 *
 * **It sits on the documented z-ladder.** Sonner injects its own very large
 * z-index, which happened to work and meant `--z-banner` could never be above a
 * toast as `tokens.css` claims. The ladder is enforced, not aspirational.
 */
export function Toaster() {
  return (
    <SonnerToaster
      /*
       * Top-right, and every other corner is taken.
       *
       * - Bottom-right is the OyeChats widget's launcher. This app embeds its
       *   own widget, so that corner is never ours.
       * - Bottom-centre was the previous answer, and it landed square on the
       *   inbox composer: the live-chat toasts ("You are now talking to X",
       *   an accepted invitation, a transfer) fire at exactly the moment an
       *   operator is typing a reply, and covered the box they were typing in.
       * - Bottom-left and the left edge generally are the navigation rail.
       *
       * The offset clears the top bar (`--spacing-topbar`) so a toast sits in
       * the content area rather than over the breadcrumb and the search field,
       * and it stays above the feedback tab, which is pinned to the right edge
       * at the vertical centre.
       */
      position="top-right"
      // Only the top is pushed down; the side gap stays the ordinary one. A
      // single scalar offset would apply to every edge and float the toast an
      // odd 68px in from the right.
      offset={{ top: 'calc(var(--spacing-topbar) + 0.75rem)', right: '1rem' }}
      mobileOffset={{ top: 'calc(var(--spacing-topbar) + 0.5rem)', right: '0.75rem', left: '0.75rem' }}
      style={{ zIndex: 'var(--z-toast)' }}
      // Sonner's own theming is bypassed entirely: `unstyled` plus our classes
      // means a toast is built from the same tokens as everything else instead
      // of from a second, parallel palette.
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-start gap-2.5 rounded-lg border border-border bg-surface px-4 py-3 shadow-md',
          success: 'border-success bg-success-tint',
          error: 'border-danger bg-danger-tint',
          warning: 'border-warning bg-warning-tint',
          title: 'text-base font-medium text-text-primary',
          description: 'mt-0.5 text-xs text-text-secondary',
          actionButton: buttonClass('secondary', 'sm', 'ms-auto shrink-0'),
          cancelButton: buttonClass('ghost', 'sm', 'shrink-0'),
          // `unstyled` strips sonner's own close-button box, so what was left
          // was an unsized glyph with no target and no focus ring.
          closeButton:
            'absolute -start-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface text-text-tertiary shadow-xs hover:text-text-primary',
        },
      }}
      icons={{
        success: <CheckCircle2 aria-hidden className="h-icon-md w-icon-md shrink-0 text-success" />,
        error: <AlertCircle aria-hidden className="h-icon-md w-icon-md shrink-0 text-danger" />,
        warning: <TriangleAlert aria-hidden className="h-icon-md w-icon-md shrink-0 text-warning" />,
        info: <Info aria-hidden className="h-icon-md w-icon-md shrink-0 text-text-tertiary" />,
      }}
      // Long enough to read a sentence, short enough not to stack up during a
      // burst of live-chat events.
      duration={5000}
      gap={8}
      visibleToasts={4}
    />
  );
}
