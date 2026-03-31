/**
 * Auth state helpers.
 *
 * Single source of truth for reading role/permission state from localStorage.
 * All components should use these helpers instead of reading localStorage directly.
 *
 * Account types:
 *   - "client"   = workspace owner (company account). Full platform access.
 *   - "operator" = employee account. Live-chat only; sees owner's bots automatically.
 *
 * Operator roles (only relevant when auth_type === "operator"):
 *   - "owner" / "admin" — can manage bots, operators, departments, quick replies
 *   - "operator"        — read-only on management; can only handle live chat
 */

/**
 * Returns the current user's auth state derived from localStorage.
 *
 * @returns {{
 *   isOperator: boolean,
 *   operatorRole: string,
 *   isBotManager: boolean,
 *   operatorId: string | null,
 *   clientId: string | null,
 * }}
 */
export function getAuthState() {
    const isOperator = localStorage.getItem('auth_type') === 'operator';
    const operatorRole = localStorage.getItem('operator_role') || '';
    return {
        isOperator,
        operatorRole,
        /** True for clients (owners) and for operators with role "owner" or "admin". */
        isBotManager: !isOperator || ['owner', 'admin'].includes(operatorRole),
        operatorId: localStorage.getItem('operator_id'),
        clientId: localStorage.getItem('admin_client_id'),
        companyWebsite: localStorage.getItem('company_website'),
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
    'operator_role',
    'operator_id',
    'is_superadmin',
    'company_name',
    'company_website',
    'onboarding_complete',
    'selected_bot_id',
];
