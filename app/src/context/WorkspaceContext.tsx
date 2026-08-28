/* eslint-disable react-refresh/only-export-components */
/**
 * Workspace context - the single source of truth for "which workspace am I
 * acting in right now?"
 *
 * A Client identity can hold:
 *   • their own workspace (as owner) - one per Client, ``id === client.id``
 *   • zero or more linked-operator memberships in other workspaces (via
 *     accepted invites)
 *
 * The switcher pill in the top-left of the AppShell mutates state here; every
 * API call scoped by ``X-Workspace-Id`` reads the same state via the axios
 * interceptor (see ``services/api.js``).
 *
 * State persistence
 * -----------------
 * The three ``current_workspace_*`` keys go through the shared authStorage
 * helpers so they land in localStorage (Remember me on) or sessionStorage
 * (off) alongside the auth token. A reload restores the last-used workspace
 * without a round-trip.
 *
 * Switch semantics
 * ----------------
 * ``switchWorkspace(id)`` is atomic from the frontend's perspective:
 *   1. Aborts every in-flight request scoped to the previous workspace via
 *      ``rotateWorkspaceAbort`` - no cross-tenant data leak.
 *   2. Updates persistent state so subsequent reads see the new workspace.
 *   3. Broadcasts a ``oyechats:workspace-switched`` window event so ad-hoc
 *      consumers (WebSocket clients, feature-flag caches) can react without
 *      subscribing to this context.
 *   4. Optionally navigates to a landing route (``/inbox`` for operator
 *      roles, ``/`` for owner) - controlled by the caller.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getMyWorkspaces, rotateWorkspaceAbort } from '../services/api';
import { getAuthItem, setAuthBundle } from '../utils/authStorage';
import { isImpersonating } from '../utils/impersonation';
import type { Workspace } from '../types/domain';

/** Router navigate, structurally: the caller passes react-router's, but this
 *  context has no reason to depend on the router to describe it. */
type NavigateFn = (path: string, options?: { replace?: boolean }) => void;

export interface WorkspaceContextValue {
  workspaces: Workspace[];
  currentWorkspaceId: number | null;
  currentWorkspaceName: string | null;
  /**
   * Persisted effective seat role. Left as a plain string rather than an
   * `owner | admin | operator` union: it is read back from browser storage,
   * and `Workspace.operator_role` upstream is itself `string | null`, so a
   * union here would be an assertion rather than a guarantee.
   */
  currentRole: string | null;
  /** Effective seat role in the active workspace. Same caveat as `currentRole`. */
  effectiveRole: string | null;
  /** True when acting as a plain operator (drives operator-scoped nav + route gating). */
  isOperator: boolean;
  isLoading: boolean;
  /** The raw rejection from `/me/workspaces`, stored unexamined. */
  error: unknown;
  accessDeniedForWorkspaceId: number | null;
  clearAccessDenied: () => void;
  refresh: () => Promise<Workspace[]>;
  /**
   * Resolves the workspace switched to, or `null` from the outside-provider
   * fallback below. Throws when `id` is not in the membership list.
   */
  switchWorkspace: (id: number, opts?: { navigate?: NavigateFn }) => Promise<Workspace | null>;
  hasMultipleWorkspaces: boolean;
  isInvitedOnly: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Event name broadcast on every workspace switch. */
export const WORKSPACE_SWITCHED_EVENT = 'oyechats:workspace-switched';

/** Event name broadcast when the backend reports the current workspace is inaccessible. */
export const WORKSPACE_ACCESS_DENIED_EVENT = 'oyechats:workspace-access-denied';

function _restoreFromStorage(): { id: number | null; name: string | null; role: string | null } {
    // An impersonated tab must NOT inherit the persisted workspace from the
    // shared localStorage bundle - that entry belongs to the super-admin's own
    // identity, not to the Account being supported. Start empty and let
    // /me/workspaces (resolved from the impersonation token) seed the truth.
    if (isImpersonating()) return { id: null, name: null, role: null };
    const id = Number(getAuthItem('current_workspace_id') || 0) || null;
    const name = getAuthItem('current_workspace_name') || null;
    const role = getAuthItem('current_workspace_role') || null;
    return { id, name, role };
}

function _clientOwnedWorkspace(workspaces: Workspace[]): Workspace | null {
    // First-time users have no persisted workspace - pick their owned one
    // (there's always exactly one owned entry per Client identity).
    return workspaces.find((w) => w.role === 'owner') || null;
}

/**
 * Collapse a workspace entry to the effective seat role the UI gates on:
 * ``owner | admin | operator``. Owned workspaces are always ``owner``; a
 * linked membership uses its granular ``operator_role`` (an admin invited into
 * another workspace keeps admin-level access), defaulting to ``operator``.
 */
function _effectiveRole(workspace: Workspace | null | undefined): string | null {
    if (!workspace) return null;
    if (workspace.role === 'owner') return 'owner';
    return workspace.operator_role || 'operator';
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [currentWorkspaceId, setCurrentWorkspaceId] = useState(() => _restoreFromStorage().id);
    const [currentWorkspaceName, setCurrentWorkspaceName] = useState(() => _restoreFromStorage().name);
    const [currentRole, setCurrentRole] = useState(() => _restoreFromStorage().role);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<unknown>(null);
    const [accessDeniedForWorkspaceId, setAccessDeniedForWorkspaceId] = useState<number | null>(null);
    // Guard so ``persistWorkspace`` doesn't clobber a fresh switch with a
    // stale ``getMyWorkspaces`` response for the previous context.
    const currentIdRef = useRef(currentWorkspaceId);
    currentIdRef.current = currentWorkspaceId;

    const persistWorkspace = useCallback((
        workspace: Workspace | null | undefined,
        { persistent = true }: { persistent?: boolean } = {},
    ): void => {
        if (!workspace) return;
        // A super-admin impersonation session is tab-scoped by design, and
        // ``setAuthBundle`` writes to the localStorage bundle SHARED by every
        // tab - persisting here would silently retarget the super-admin's own
        // workspace selection everywhere else. React state only for that path;
        // the impersonation credential is server-resolved anyway (the request
        // interceptor suppresses ``X-Workspace-Id`` entirely).
        if (!isImpersonating()) {
            setAuthBundle(
                {
                    current_workspace_id: String(workspace.id),
                    current_workspace_name: workspace.name || '',
                    // The EFFECTIVE role, not the coarse membership role. A
                    // linked admin's ``workspace.role`` is not 'owner', so
                    // persisting it meant that on the next reload — before
                    // /me/workspaces resolves — the app read them back as a
                    // plain operator and the route guard bounced them to
                    // /inbox, destroying whatever they had deep-linked to.
                    current_workspace_role: _effectiveRole(workspace) || '',
                },
                persistent,
            );
        }
        setCurrentWorkspaceId(workspace.id);
        setCurrentWorkspaceName(workspace.name);
        setCurrentRole(_effectiveRole(workspace));
    }, []);

    const refresh = useCallback(async (): Promise<Workspace[]> => {
        setIsLoading(true);
        setError(null);
        try {
            const response = await getMyWorkspaces();
            const list = response?.workspaces || [];
            setWorkspaces(list);
            if (list.length === 0) {
                return list;
            }

            // If persisted workspace is still accessible, keep it. Otherwise
            // fall back to the owned workspace (or the first entry).
            const persisted = currentIdRef.current;
            let next = persisted ? list.find((w) => w.id === persisted) : null;
            if (!next) {
                next = _clientOwnedWorkspace(list) || list[0];
                persistWorkspace(next);
            } else {
                // Ensure name / role stay in sync if backend metadata changed.
                if (next.name !== currentWorkspaceName || _effectiveRole(next) !== currentRole) {
                    persistWorkspace(next);
                }
            }
            return list;
        } catch (err) {
            // Don't clobber state on transient failures - the UI can show a
            // "reconnecting" chip if this repeats. Legacy operator sessions
            // don't hit /me/workspaces at all (they use X-Operator-Key).
            setError(err);
            return [];
        } finally {
            setIsLoading(false);
        }
    }, [currentRole, currentWorkspaceName, persistWorkspace]);

    const switchWorkspace = useCallback(async (
        workspaceId: number,
        { navigate }: { navigate?: NavigateFn } = {},
    ): Promise<Workspace> => {
        const next = workspaces.find((w) => w.id === workspaceId);
        if (!next) {
            throw new Error(`Workspace ${workspaceId} is not in the current membership list.`);
        }
        if (next.id === currentIdRef.current) {
            return next;
        }
        // Atomic: cancel every scoped in-flight request FIRST so late responses
        // for the previous workspace can't land after this state flips.
        rotateWorkspaceAbort();
        persistWorkspace(next);

        // Broadcast so WebSocket clients + other side channels can reconnect
        // under the new workspace context.
        window.dispatchEvent(new CustomEvent(WORKSPACE_SWITCHED_EVENT, {
            detail: { workspaceId: next.id, role: next.role, name: next.name },
        }));

        if (navigate) {
            // Operators land on the live-chat console; owners/admins on the
            // dashboard. (`/inbox` is the real route - the old `/support`
            // alias never existed under Admin 2.0 and 404'd.)
            const landingPath = next.role === 'operator' ? '/inbox' : '/';
            navigate(landingPath, { replace: true });
        }
        return next;
    }, [persistWorkspace, workspaces]);

    // Wire the response interceptor's `workspace_access_denied` event to a
    // context-level reaction: drop the offending workspace and re-fetch. The
    // AccessDeniedScreen component consumes ``accessDeniedForWorkspaceId``
    // and gives the user a way to switch to a still-valid workspace.
    useEffect(() => {
        function onAccessDenied(event: Event) {
            const detail = (event as CustomEvent<{ workspaceId?: number }>).detail;
            const denied = Number(detail?.workspaceId || 0);
            if (!denied) return;
            setAccessDeniedForWorkspaceId(denied);
            // Drop the persisted workspace so the next refresh picks a valid one.
            setAuthBundle(
                {
                    current_workspace_id: '',
                    current_workspace_name: '',
                    current_workspace_role: '',
                },
                true,
            );
            setCurrentWorkspaceId(null);
            setCurrentWorkspaceName(null);
            setCurrentRole(null);
            refresh();
        }
        window.addEventListener(WORKSPACE_ACCESS_DENIED_EVENT, onAccessDenied);
        return () => window.removeEventListener(WORKSPACE_ACCESS_DENIED_EVENT, onAccessDenied);
    }, [refresh]);

    // Initial load - fire once after mount. Skips for legacy operator sessions
    // (they use X-Operator-Key which doesn't play with workspace switching).
    useEffect(() => {
        // An impersonation token authenticates on its own and always resolves
        // to a Client (Account), never an Operator - so it skips BOTH gates
        // below, including a stale ``auth_type`` left in this browser's shared
        // localStorage by the super-admin's own session.
        if (!isImpersonating()) {
            const authType = getAuthItem('auth_type');
            const token = getAuthItem('admin_token');
            if (!token) {
                setIsLoading(false);
                return;
            }
            if (authType === 'operator') {
                // Legacy operator - no workspace switcher, single implicit workspace.
                setIsLoading(false);
                return;
            }
        }
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The workspace the caller is currently acting in, resolved against the
    // freshly-loaded membership list. Falls back to `null` until the first
    // `/me/workspaces` response lands.
    const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId) || null;
    // Effective seat role for gating. Prefer the loaded membership entry;
    // before the list loads, fall back to the persisted role so an operator is
    // gated immediately on reload (no flash of the full owner dashboard).
    const effectiveRole = currentWorkspace ? _effectiveRole(currentWorkspace) : (currentRole || null);
    const isOperator = effectiveRole === 'operator';

    const value = useMemo<WorkspaceContextValue>(() => ({
        workspaces,
        currentWorkspaceId,
        currentWorkspaceName,
        currentRole,
        // Gating-facing derivations (see above).
        effectiveRole,
        isOperator,
        isLoading,
        error,
        accessDeniedForWorkspaceId,
        clearAccessDenied: () => setAccessDeniedForWorkspaceId(null),
        refresh,
        switchWorkspace,
        // True when the caller belongs to more than one workspace - drives the
        // switcher-vs-static-label decision in the AppShell.
        hasMultipleWorkspaces: workspaces.length > 1,
        // True when the caller is an invited-only operator (no owned workspace
        // with bots) - used by the sidebar to hide the "Create workspace" CTA
        // and other owner-side affordances.
        isInvitedOnly: (() => {
            const owned = _clientOwnedWorkspace(workspaces);
            return !owned || (owned.bot_count || 0) === 0;
        })(),
    }), [
        workspaces,
        currentWorkspaceId,
        currentWorkspaceName,
        currentRole,
        effectiveRole,
        isOperator,
        isLoading,
        error,
        accessDeniedForWorkspaceId,
        refresh,
        switchWorkspace,
    ]);

    return (
        <WorkspaceContext.Provider value={value}>
            {children}
        </WorkspaceContext.Provider>
    );
}

/**
 * Hook - subscribe to workspace context.
 *
 * Callers outside the provider get sensible defaults so components mounted
 * before the provider (e.g. login screen) don't need to guard.
 */
export function useWorkspace(): WorkspaceContextValue {
    const ctx = useContext(WorkspaceContext);
    if (!ctx) {
        return {
            workspaces: [],
            currentWorkspaceId: null,
            currentWorkspaceName: null,
            currentRole: null,
            effectiveRole: null,
            isOperator: false,
            isLoading: false,
            error: null,
            accessDeniedForWorkspaceId: null,
            clearAccessDenied: () => { },
            refresh: async () => [],
            switchWorkspace: async () => null,
            hasMultipleWorkspaces: false,
            isInvitedOnly: false,
        };
    }
    return ctx;
}
