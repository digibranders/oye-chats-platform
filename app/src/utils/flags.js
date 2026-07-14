// Build-time feature flags (Vite env). Default OFF — set the env var to the
// string "true" to enable.
//
// VITE_STUDIO_ENABLED gates the guided Build Studio onboarding: when on, new
// (botless, not-yet-onboarded) accounts are routed into /build after signup
// instead of the legacy Dashboard SetupChecklist. Rolled out gradually.
export const STUDIO_ENABLED = import.meta.env.VITE_STUDIO_ENABLED === 'true';
