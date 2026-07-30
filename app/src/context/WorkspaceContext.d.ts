import type { ReactElement, ReactNode } from 'react';
import type { Workspace } from '../types/domain';

/** Type shim for the legacy JS `context/WorkspaceContext.jsx`. */

export interface WorkspaceContextValue {
  workspaces: Workspace[];
  currentWorkspaceId: number | null;
  currentWorkspaceName: string | null;
  currentRole: string | null;
  /** Effective seat role in the active workspace: `owner` | `admin` | `operator`. */
  effectiveRole: string | null;
  /** True when acting as a plain operator (drives operator-scoped nav + route gating). */
  isOperator: boolean;
  isLoading: boolean;
  error: unknown;
  accessDeniedForWorkspaceId: number | null;
  clearAccessDenied: () => void;
  refresh: () => Promise<Workspace[]>;
  switchWorkspace: (
    id: number,
    opts?: { navigate?: (path: string, options?: { replace?: boolean }) => void },
  ) => Promise<Workspace>;
  hasMultipleWorkspaces: boolean;
  isInvitedOnly: boolean;
}

export const WorkspaceProvider: (props: { children: ReactNode }) => ReactElement;
export function useWorkspace(): WorkspaceContextValue;
export const WORKSPACE_SWITCHED_EVENT: string;
export const WORKSPACE_ACCESS_DENIED_EVENT: string;
