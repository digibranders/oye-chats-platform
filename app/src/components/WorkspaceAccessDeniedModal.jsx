/**
 * Workspace access-denied dialog.
 *
 * Renders when the backend returns 403 ``workspace_access_denied`` for the
 * workspace the caller has active in ``X-Workspace-Id`` - usually because
 * the workspace owner revoked their linked-operator role, or their identity
 * was pruned during a workspace deletion, or the workspace itself is gone.
 *
 * The dialog:
 *   1. Tells them what happened, plainly.
 *   2. Lists the workspaces they still can access, so they can hop.
 *   3. Falls back to sign-out if they've lost ALL workspaces.
 *
 * The interceptor in ``services/api.js`` fires ``oyechats:workspace-access-denied``
 * on any such 403; ``WorkspaceContext`` catches that event, drops the offending
 * workspace from storage, and populates ``accessDeniedForWorkspaceId`` - which
 * is what this dialog reads to decide whether to show itself.
 */

import { useNavigate } from 'react-router-dom';
import { Building2, Headphones, LogOut, ShieldOff } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { clearAuthStorage } from '../utils/authStorage';
import { cn } from '../lib/utils';

export default function WorkspaceAccessDeniedModal() {
    const navigate = useNavigate();
    const {
        accessDeniedForWorkspaceId,
        workspaces,
        clearAccessDenied,
        switchWorkspace,
    } = useWorkspace();

    if (!accessDeniedForWorkspaceId) return null;

    async function handleSwitchTo(workspaceId) {
        clearAccessDenied();
        try {
            await switchWorkspace(workspaceId, { navigate });
        } catch (err) {
            console.error('Fallback switch failed', err);
        }
    }

    function handleSignOut() {
        clearAuthStorage();
        clearAccessDenied();
        navigate('/login', { replace: true });
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center px-4">
            <div className={cn(
                'w-full max-w-md rounded-2xl border shadow-xl p-6',
                'bg-white dark:bg-surface-900',
                'border-surface-200 dark:border-surface-800',
            )}>
                <div className="mb-4 w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/40 flex items-center justify-center">
                    <ShieldOff size={20} className="text-amber-600 dark:text-amber-400" />
                </div>
                <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100 mb-2">
                    You&rsquo;ve lost access to this workspace
                </h2>
                <p className="text-sm text-surface-600 dark:text-surface-400 mb-5">
                    Your operator role was revoked, or the workspace is no longer available. Pick another
                    workspace to continue, or sign out.
                </p>

                {workspaces.length > 0 ? (
                    <div className="space-y-2 mb-4 max-h-60 overflow-y-auto">
                        {workspaces.map((w) => (
                            <button
                                key={w.id}
                                type="button"
                                onClick={() => handleSwitchTo(w.id)}
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-surface-200 dark:border-surface-800 hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors text-left"
                            >
                                <div className={cn(
                                    'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                                    w.role === 'owner'
                                        ? 'bg-brand-50 dark:bg-brand-950/40 text-brand-600 dark:text-brand-400'
                                        : 'bg-surface-100 dark:bg-surface-800 text-surface-500',
                                )}>
                                    {w.role === 'owner' ? <Building2 size={14} /> : <Headphones size={14} />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
                                        {w.name}
                                    </div>
                                    <div className="text-[11px] text-surface-500 capitalize">
                                        {w.role === 'owner' ? 'Owner' : (w.operator_role || 'Operator')}
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-surface-500 mb-4">
                        You don&rsquo;t belong to any other workspace right now. Sign out and back in, or ask
                        someone to invite you.
                    </p>
                )}

                <button
                    type="button"
                    onClick={handleSignOut}
                    className="w-full flex items-center justify-center gap-2 rounded-xl border border-surface-200 dark:border-surface-800 px-4 py-2.5 text-sm font-medium text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors"
                >
                    <LogOut size={14} />
                    Sign out
                </button>
            </div>
        </div>
    );
}
