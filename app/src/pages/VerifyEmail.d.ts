import type { ComponentType } from 'react';

/**
 * Type shim for `pages/VerifyEmail.jsx` - the 6-digit OTP screen. The `.jsx`
 * stays the runtime source; this only declares it for TypeScript consumers
 * (it is routed from `app/routes.tsx` and covered by `VerifyEmail.test.tsx`).
 * Takes no props; reads its email from `?email=`, `admin_pending_email`, or
 * `/auth/me`, in that order.
 */
declare const VerifyEmail: ComponentType<Record<string, never>>;
export default VerifyEmail;
