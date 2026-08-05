import type { ComponentType } from 'react';

/**
 * Type shim for `components/ImpersonationBanner.jsx` - the persistent
 * super-admin impersonation bar. The `.jsx` stays the runtime source; this only
 * declares it for TypeScript consumers (it is mounted from `ProtectedLayout`).
 * Takes no props and renders `null` when the tab holds no impersonation session.
 */
declare const ImpersonationBanner: ComponentType<Record<string, never>>;
export default ImpersonationBanner;
