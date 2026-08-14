import type { ComponentType } from 'react';

/**
 * Type shim for `components/VerifyEmailBanner.jsx` - the dismissible
 * "verify your email" nudge. The `.jsx` stays the runtime source; this only
 * declares it for TypeScript consumers (it is mounted from `shell/AppShell`).
 * Takes no props and renders `null` for verified accounts, operator sessions,
 * and once dismissed in the current page view.
 */
declare const VerifyEmailBanner: ComponentType<Record<string, never>>;
export default VerifyEmailBanner;
