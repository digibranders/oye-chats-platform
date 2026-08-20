import { Button, cn, useClipboard } from '../../ui';

export interface ErrorDetailsProps {
  /** The technical detail — message and stack. Absent for a plain 404. */
  detail?: string;
  className?: string;
}

/**
 * The diagnostic, folded away.
 *
 * A stack trace is not an explanation, so it never speaks first: the surfaces
 * around this one say what happened in the user's terms, and this stays shut
 * until somebody deliberately opens it. What it is *for* is the support
 * conversation — "send us what it says under Technical details" is a far
 * shorter path than asking a customer to open a developer console — so it is
 * labelled as a diagnostic, and it carries a copy button, which is the only
 * thing anyone actually wants to do with a stack.
 *
 * A native `<details>` rather than a `useState` disclosure: it is closed by
 * default with no JavaScript, it is keyboard-operable and announced as a
 * disclosure without any ARIA of ours, and it stays findable by the browser's
 * own in-page search when collapsed.
 */
export function ErrorDetails({ detail, className }: ErrorDetailsProps) {
  const { state, copy } = useClipboard();

  if (!detail) return null;

  return (
    <details className={cn('group', className)}>
      <summary className="cursor-pointer text-xs text-text-secondary hover:text-text-primary">
        Technical details — for support, not an explanation
      </summary>
      <div className="mt-2">
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface-sunken p-3 font-mono text-2xs leading-relaxed text-text-secondary">
          {detail}
        </pre>
        <div className="mt-2 flex items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => void copy(detail)}>
            {state === 'copied' ? 'Copied' : 'Copy details'}
          </Button>
          <span aria-live="polite" className="text-xs text-text-secondary">
            {state === 'failed'
              ? 'Your browser blocked the clipboard. Select the text above and copy it.'
              : null}
          </span>
        </div>
      </div>
    </details>
  );
}
