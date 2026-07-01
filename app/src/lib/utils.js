import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/**
 * Prepend "https://" if the URL has no protocol, then validate
 * that the result looks like a real URL (has at least one dot in the host).
 * Returns the normalised URL string, or empty string if input is blank/invalid.
 */
/**
 * `ChatSession.location` is stamped by the backend in two stages: the raw
 * visitor IP immediately (`"IP: <ip>"`), then overwritten in the background
 * once a geolocation lookup resolves to `"<city>, <country> | <ip>"`. If the
 * lookup hasn't finished yet — or the outbound geo API call failed — the
 * field is still the raw IP stamp. Render this instead of `location`
 * directly anywhere visitor-facing IP would otherwise leak into the UI.
 * Returns '' when there's nothing resolved to show yet.
 */
export function formatVisitorLocation(location) {
  const raw = (location || '').trim();
  if (!raw) return '';
  const resolved = raw.replace(/\s*\|.*$/, '').trim();
  if (!resolved || /^ip:/i.test(resolved)) return '';
  return resolved;
}

export function normalizeUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname.includes('.')) return '';
    return parsed.href;
  } catch {
    return '';
  }
}
