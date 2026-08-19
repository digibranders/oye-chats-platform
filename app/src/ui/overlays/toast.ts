import { toast as sonnerToast } from 'sonner';

/**
 * Fire a toast.
 *
 * Re-exported from one place so every call site goes through the `Toaster`
 * mounted at the app root, and so a future change of library touches one file.
 *
 * Use it to CONFIRM, never to explain. If the user must read a message in order
 * to proceed, it is an inline `Alert` next to the control that produced it, or a
 * dialog — a notice that disappears after five seconds is the wrong home for
 * "your card was declined".
 */
export const toast = sonnerToast;
