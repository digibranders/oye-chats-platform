import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';

export interface DisclosureProps {
  /** The always-visible line that toggles the panel. */
  summary: ReactNode;
  children: ReactNode;
  /** Open on first render. Off by default — a disclosure that starts open is a section. */
  defaultOpen?: boolean;
  /** Controlled mode. Supply both, or neither. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Names the revealed region for assistive tech, when the summary alone is not
   * enough — "Technical details", "Conversation". Defaults to the summary when
   * that is a plain string.
   */
  regionLabel?: string;
  /** Rendered at the end of the summary row: a badge, a count, a copy button. */
  trailing?: ReactNode;
  /**
   * Wrap the toggle in a heading, so a list of these is navigable by heading.
   *
   * A log of expandable rows is a list of *sections*, and a screen-reader user
   * moving through it by heading is the whole reason the rows are collapsed in
   * the first place. Omit it for a one-off disclosure inside prose, where an
   * extra heading would pollute the document outline.
   */
  headingLevel?: 2 | 3 | 4;
  className?: string;
  panelClassName?: string;
}

/**
 * Show more, on request.
 *
 * A button with `aria-expanded` over a labelled `region`, rather than a native
 * `<details>`. The native element is tempting and wrong for this system: its
 * open state cannot be controlled, its marker cannot be replaced without a
 * vendor pseudo-element, and Safari's `<summary>` is not announced as a button —
 * so a keyboard user gets no cue that it toggles anything.
 *
 * It exists because two surfaces built it two different ways within a week of
 * each other: a transcript row that expands to its exchange, and the error
 * screens' technical detail. That is the start of exactly the duplication this
 * directory exists to prevent.
 *
 * The panel is unmounted when closed, not hidden. A hidden subtree still holds
 * its focusable children in the tab order unless every one of them is disabled,
 * and the content here is often long.
 *
 * The one place a native `<details>` is still right is content that must stay
 * findable by the browser's own in-page search while collapsed — `ErrorDetails`
 * makes that case for a stack trace, deliberately, and says so.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  regionLabel,
  trailing,
  headingLevel,
  className,
  panelClassName,
}: DisclosureProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const id = useId();
  const panelId = `${id}-panel`;

  function toggle(): void {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const label = regionLabel ?? (typeof summary === 'string' ? summary : undefined);
  const buttonId = `${id}-button`;
  const Heading = headingLevel ? (`h${headingLevel}` as const) : null;

  const toggleButton = (
    <button
      id={buttonId}
      type="button"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={toggle}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left',
        'text-base text-text-primary transition-colors duration-[var(--dur-fast)]',
        'hover:bg-surface-hover',
      )}
    >
        <ChevronRight
          aria-hidden
          className={cn(
            'h-4 w-4 shrink-0 text-text-tertiary transition-transform duration-[var(--dur-fast)]',
            'motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
      <span className="min-w-0 flex-1">{summary}</span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </button>
  );

  return (
    <div className={cn('min-w-0', className)}>
      {Heading ? <Heading>{toggleButton}</Heading> : toggleButton}

      {open ? (
        <div
          id={panelId}
          role="region"
          // Labelled by the toggle when there is one to point at, so the region
          // and the control that opened it announce as the same thing.
          aria-labelledby={label ? undefined : buttonId}
          aria-label={label}
          className={cn('pl-7 pr-1 pt-1', panelClassName)}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
