import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { FullPageState, Measure, Page, PageHeader, buttonClass } from '../../ui';

export interface ForbiddenPageProps {
  /** What was refused, in the reader's terms. */
  title?: string;
  /** Who can grant it. Never "contact your administrator" with no name. */
  description?: string;
  /** Where the current role can actually go. */
  to?: string;
  toLabel?: string;
  /**
   * Render as the whole window rather than inside the shell.
   *
   * The platform console refuses above its own rail, so there is nothing to
   * render into; the operator guard refuses inside the customer shell, where
   * the rail is the reader's way out and must stay.
   */
  full?: boolean;
}

const DEFAULT_TITLE = 'You do not have access to this page';
const DEFAULT_DESCRIPTION =
  'Your seat in this workspace does not include it. An owner or an admin can open it for you.';

/**
 * You are signed in, and this is not yours.
 *
 * `DESIGN.md` §5 and `CLAUDE.md` non-negotiable 3 both ask every surface for
 * four states including forbidden, and `LockedState` covers the in-page case —
 * but a **route-level** 403 had no surface at all. An operator deep-linking to
 * `/settings`, and a non-super-admin opening `/platform`, were both answered
 * with a silent `<Navigate replace />`: the URL they asked for was discarded
 * with no explanation, which is precisely the defect `NotFoundPage` documents
 * redirects causing.
 *
 * It is a 403 and not a plan lock, so it is not a `LockedState`: there is
 * nothing to buy here, and offering an upgrade to somebody whose workspace
 * already pays for the feature is worse than saying nothing.
 */
export function ForbiddenPage({
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  to = '/',
  toLabel = 'Go to Home',
  full = false,
}: ForbiddenPageProps) {
  const action = (
    <Link to={to} className={buttonClass('primary', 'md')}>
      {toLabel}
    </Link>
  );

  if (full) {
    return (
      <FullPageState
        icon={Lock}
        tone="neutral"
        title={title}
        description={description}
        actions={action}
      />
    );
  }

  return (
    <Page>
      <Measure width="reading">
        <PageHeader eyebrow="Error 403" title={title} description={description} actions={action} />
      </Measure>
    </Page>
  );
}
