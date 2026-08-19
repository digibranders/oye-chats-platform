import { Navigate, useLocation, useParams } from 'react-router-dom';
import type { ReactElement } from 'react';

/**
 * Carry a legacy URL onto its new home, preserving the query string and hash.
 *
 * Old links live in delivered emails, push-notification payloads and bookmarks,
 * and they outlive any rename. The previous rename dropped several of them onto
 * the in-shell 404, and one alias silently discarded the `?session=` parameter
 * that was the whole reason an operator had clicked the link.
 */
export function Moved({ to }: { to: string }): ReactElement {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

/** `/agents/7/channels` → `/chatbots/7/deploy`, with the tab renames applied. */
export function MovedAgent({ segment = 'overview' }: { segment?: string }): ReactElement {
  const { agentId } = useParams<{ agentId: string }>();
  const { search, hash } = useLocation();
  return <Navigate to={`/chatbots/${agentId}/${segment}${search}${hash}`} replace />;
}
