/**
 * Type shim for the legacy JS auth-storage helper (`utils/authStorage.js`).
 * The `.js` remains the runtime source; this only supplies types to new TS code.
 */
export function getAuthItem(key: string): string | null;
export function setAuthItem(key: string, value: string | null): void;
export function setAuthBundle(items: Record<string, string>, persistent?: boolean): void;
export function removeAuthItem(key: string): void;
export function clearAuthStorage(): void;
export function isSessionExpired(): boolean;
export const SESSION_EXPIRY_KEY: string;
export const AUTH_STORAGE_KEYS: string[];
