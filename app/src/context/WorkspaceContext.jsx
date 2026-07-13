/* eslint-disable react-refresh/only-export-components */
/**
 * Workspace context — the single source of truth for "which workspace am I
 * acting in right now?"
 *
 * A Client identity can hold:
 *   • their own workspace (as owner) — one per Client, ``id === client.id``
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
 *      ``rotateWorkspaceAbort`` — no cross-tenant data leak.
 *   2. Updates persistent state so subsequent reads see the new workspace.
 *   3. Broadcasts a ``oyechats:workspace-switched`` window event so ad-hoc
 *      consumers (WebSocket clients, feature-flag caches) can react without
 *      subscribing to this context.
 *   4. Optionally navigates to a landing route (``/support`` for operator
 *      roles, ``/`` for owner) — controlled by the caller.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getMyWorkspaces, rotateWorkspaceAbort } from '../services/api';
import { getAuthItem, setAuthBundle } from '../utils/authStorage';

const WorkspaceContext = createContext(null);

/** Event name broadcast on every workspace switch. */
export const WORKSPACE_SWITCHED_EVENT = 'oyechats:workspace-switched';

/** Event name broadcast when the backend reports the current workspace is inaccessible. */
export const WORKSPACE_ACCESS_DENIED_EVENT = 'oyechats:workspace-access-denied';

function _restoreFromStorage() {
    const id = Number(getAuthItem('current_workspace_id') || 0) || null;
    const name = getAuthItem('current_workspace_name') || null;
    const role = getAuthItem('current_workspace_role') || null;
    return { id, name, role };
}

function _clientOwnedWorkspace(workspaces) {
    // First-time users have no persisted workspace — pick their owned one
    // (there's always exactly one owned entry per Client identity).
    return workspaces.find((w) => w.role === 'owner') || null;
}

export function WorkspaceProvider({ children }) {
    const [workspaces, setWorkspaces] = useState([]);
    const [currentWorkspaceId, setCurrentWorkspaceId] = useState(() => _restoreFromStorage().id);
    const [currentWorkspaceName, setCurrentWorkspaceName] = useState(() => _restoreFromStorage().name);
    const [currentRole, setCurrentRole] = useState(() => _restoreFromStorage().role);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [accessDeniedForWorkspaceId, setAccessDeniedForWorkspaceId] = useState(null);
    // Guard so ``persistWorkspace`` doesn't clobber a fresh switch with a
    // stale ``getMyWorkspaces`` response for the previous context.
    const currentIdRef = useRef(currentWorkspaceId);
    currentIdRef.current = currentWorkspaceId;

    const persistWorkspace = useCallback((workspace, { persistent = true } = {}) => {
        if (!workspace) return;
        setAuthBundle(
            {
                current_workspace_id: String(workspace.id),
                current_workspace_name: workspace.name || '',
                current_workspace_role: workspace.role || '',
            },
            persistent,
        );
        setCurrentWorkspaceId(workspace.id);
        setCurrentWorkspaceName(workspace.name);
        setCurrentRole(workspace.role);
    }, []);

    const refresh = useCallback(async () => {
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
                if (next.name !== currentWorkspaceName || next.role !== currentRole) {
                    persistWorkspace(next);
                }
            }
            return list;
        } catch (err) {
            // Don't clobber state on transient failures — the UI can show a
            // "reconnecting" chip if this repeats. Legacy operator sessions
            // don't hit /me/workspaces at all (they use X-Operator-Key).
            setError(err);
            return [];
        } finally {
            setIsLoading(false);
        }
    }, [currentRole, currentWorkspaceName, persistWorkspace]);

    const switchWorkspace = useCallback(async (workspaceId, { navigate } = {}) => {
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
            const landingPath = next.role === 'operator' ? '/support' : '/';
            navigate(landingPath, { replace: true });
        }
        return next;
    }, [persistWorkspace, workspaces]);

    // Wire the response interceptor's `workspace_access_denied` event to a
    // context-level reaction: drop the offending workspace and re-fetch. The
    // AccessDeniedScreen component consumes ``accessDeniedForWorkspaceId``
    // and gives the user a way to switch to a still-valid workspace.
    useEffect(() => {
        function onAccessDenied(event) {
            const denied = Number(event?.detail?.workspaceId || 0);
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

    // Initial load — fire once after mount. Skips for legacy operator sessions
    // (they use X-Operator-Key which doesn't play with workspace switching).
    useEffect(() => {
        const authType = getAuthItem('auth_type');
        const token = getAuthItem('admin_token');
        if (!token) {
            setIsLoading(false);
            return;
        }
        if (authType === 'operator') {
            // Legacy operator — no workspace switcher, single implicit workspace.
            setIsLoading(false);
            return;
        }
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const value = useMemo(() => ({
        workspaces,
        currentWorkspaceId,
        currentWorkspaceName,
        currentRole,
        isLoading,
        error,
        accessDeniedForWorkspaceId,
        clearAccessDenied: () => setAccessDeniedForWorkspaceId(null),
        refresh,
        switchWorkspace,
        // True when the caller belongs to more than one workspace — drives the
        // switcher-vs-static-label decision in the AppShell.
        hasMultipleWorkspaces: workspaces.length > 1,
        // True when the caller is an invited-only operator (no owned workspace
        // with bots) — used by the sidebar to hide the "Create workspace" CTA
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
 * Hook — subscribe to workspace context.
 *
 * Callers outside the provider get sensible defaults so components mounted
 * before the provider (e.g. login screen) don't need to guard.
 */
export function useWorkspace() {
    const ctx = useContext(WorkspaceContext);
    if (!ctx) {
        return {
            workspaces: [],
            currentWorkspaceId: null,
            currentWorkspaceName: null,
            currentRole: null,
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
