import { Toaster as SonnerToaster } from 'sonner';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';

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
 */
export function Toaster() {
  return (
    <SonnerToaster
      // Not bottom-right: this app embeds the OyeChats widget on itself, and
      // its launcher lives in that corner. Bottom-centre clears both the
      // launcher and the navigation rail.
      position="bottom-center"
      // Sonner's own theming is bypassed entirely: `unstyled` plus our classes
      // means a toast is built from the same tokens as everything else instead
      // of from a second, parallel palette.
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 shadow-md',
          title: 'text-base font-medium text-text-primary',
          description: 'mt-0.5 text-xs leading-relaxed text-text-secondary',
          actionButton:
            'ml-auto shrink-0 rounded-sm border border-border-strong bg-surface px-2 py-1 text-xs font-medium text-text-primary hover:bg-surface-hover',
          cancelButton:
            'shrink-0 rounded-sm px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary',
          closeButton: 'text-text-tertiary hover:text-text-primary',
        },
      }}
      icons={{
        success: <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-success" />,
        error: <AlertCircle aria-hidden className="h-4 w-4 shrink-0 text-danger" />,
        warning: <TriangleAlert aria-hidden className="h-4 w-4 shrink-0 text-warning" />,
        info: <Info aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />,
      }}
      // Long enough to read a sentence, short enough not to stack up during a
      // burst of live-chat events.
      duration={5000}
      gap={8}
      visibleToasts={4}
    />
  );
}
