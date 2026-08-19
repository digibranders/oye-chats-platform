/**
 * Client-side validators.
 *
 * Deliberately permissive: the server is the authority on whether a value is
 * acceptable. These exist to catch a typo at the moment it is made, not to
 * reimplement the backend's rules — a client check stricter than the server's
 * rejects addresses that would have worked.
 */

/** Returns the reason it failed, or `null` when the value is acceptable. */
export function validateEmail(value: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
    ? null
    : `${value} is not a valid email address.`;
}

/** Accepts a bare host as well as a full URL; the caller normalises the scheme. */
export function validateUrl(value: string): string | null {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return url.hostname.includes('.') ? null : `${value} is not a valid web address.`;
  } catch {
    return `${value} is not a valid web address.`;
  }
}

/** Prefix a bare host so a pasted `example.com` still resolves. */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
