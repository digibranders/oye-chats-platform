import { type ReactNode } from 'react';
import { ErrorState, LockedState, Page, PageHeader, cn } from '../ui';

export interface PlatformPageProps {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  /** Renders the forbidden state instead of the body. */
  forbidden?: boolean;
  /** Renders the error state instead of the body. */
  error?: string | null;
  onRetry?: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * A platform section.
 *
 * Every screen in this console owes the same four states as every screen in the
 * product, and "forbidden" is not theoretical here: a super-admin's own
 * permissions are checked per route on the server, so a section can genuinely
 * come back 403 for someone who is otherwise inside the console. It says so
 * rather than rendering an empty table, which is what the customer-facing app
 * used to do for plan-gated data.
 */
export function PlatformPage({
  title,
  description,
  eyebrow,
  actions,
  toolbar,
  forbidden = false,
  error = null,
  onRetry,
  children,
  className,
}: PlatformPageProps) {
  return (
    <Page width="full" className={cn(className)}>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={actions}
        toolbar={forbidden ? undefined : toolbar}
      />
      {forbidden ? (
        <LockedState
          title="You do not have access to this"
          description="Your super-admin account is not permitted to read these records. Nothing was loaded."
        />
      ) : error ? (
        <ErrorState description={error} onRetry={onRetry} />
      ) : (
        children
      )}
    </Page>
  );
}
