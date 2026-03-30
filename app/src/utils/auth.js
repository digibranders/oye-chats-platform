/**
 * Auth state helpers.
 *
 * Single source of truth for reading role/permission state from localStorage.
 * All components should use these helpers instead of reading localStorage directly.
 *
 * Account types:
 *   - "client"  = workspace owner (company account). Full platform access.
 *   - "agent"   = employee account. Live-chat only; sees owner's bots automatically.
 *
 * Agent roles (only relevant when auth_type === "agent"):
 *   - "owner" / "admin" — can manage bots, agents, departments, quick replies
 *   - "agent"           — read-only on management; can only handle live chat
 */

/**
 * Returns the current user's auth state derived from localStorage.
 *
 * @returns {{
 *   isAgent: boolean,
 *   agentRole: string,
 *   isBotManager: boolean,
 *   agentId: string | null,
 *   clientId: string | null,
 * }}
 */
export function getAuthState() {
    const isAgent = localStorage.getItem('auth_type') === 'agent';
    const agentRole = localStorage.getItem('agent_role') || '';
    return {
        isAgent,
        agentRole,
        /** True for clients (owners) and for agents with role "owner" or "admin". */
        isBotManager: !isAgent || ['owner', 'admin'].includes(agentRole),
        agentId: localStorage.getItem('agent_id'),
        clientId: localStorage.getItem('admin_client_id'),
    };
}

/**
 * Returns the set of localStorage keys that must be cleared on logout.
 * Keeps the logout logic and the key list in one place.
 */
export const AUTH_STORAGE_KEYS = [
    'admin_token',
    'admin_name',
    'admin_client_id',
    'auth_type',
    'agent_role',
    'agent_id',
    'is_superadmin',
    'onboarding_complete',
    'selected_bot_id',
];
