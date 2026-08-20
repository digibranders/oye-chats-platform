import { type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Eyebrow } from '../primitives/Misc';

export interface PaneHeaderProps {
  /** The pane's name, or the thing it is showing. */
  title: ReactNode;
  /** Mono uppercase label above the title. Rarely needed at this size. */
  eyebrow?: string;
  /**
   * The heading level.
   *
   * A pane is a division of a page, so its header is a real heading — three
   * panes side by side with no headings gives a screen-reader user no way to
   * move between them.
   */
  titleAs?: 'h2' | 'h3';
  /** Controls for the pane. Never allowed to shrink; the title shrinks. */
  actions?: ReactNode;
  /**
   * A second band under the header: a search field, a filter row.
   *
   * One pane may have it and the others not — one exception in a row of three
   * headers is legible, three different heights are not.
   */
  children?: ReactNode;
  className?: string;
}

/**
 * One header contract for every pane.
 *
 * The inbox shipped three panes with three different top edges: a 92px two-row
 * block at `px-3`, a 58px single row at `px-4`, and a third pane with no header
 * at all whose content simply started at `p-4`. Three panes side by side, three
 * header heights, three left insets — the single most visible "this does not
 * look like a SaaS app" defect on the surface. Intercom, Front and Zendesk all
 * give every pane one identical band.
 *
 * So: 56px, which is `--spacing-topbar`, so a pane header stands on the same
 * line as the shell's top bar; and `px-cell`, which is the one horizontal gutter
 * in the system — the pane's *body* must use it too, or the header is aligned
 * with nothing again.
 *
 * The title is the only thing allowed to shrink. The chat pane used to let the
 * button group compress the visitor's name to zero width at 1280, so the header
 * showed an avatar and a row of buttons and no idea who was talking.
 */
export function PaneHeader({
  title,
  eyebrow,
  titleAs: Title = 'h2',
  actions,
  children,
  className,
}: PaneHeaderProps) {
  return (
    <div className={cn('shrink-0', className)}>
      <div className="flex h-topbar items-center gap-2 border-b border-border bg-surface px-cell">
        <div className="min-w-0 flex-1">
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
          <Title className="min-w-0 truncate text-base font-semibold text-text-primary">
            {title}
          </Title>
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {children ? (
        <div className="flex h-row shrink-0 items-center gap-2 border-b border-border bg-surface px-cell">
          {children}
        </div>
      ) : null}
    </div>
  );
}
