/**
 * GSTIN validation — a faithful client mirror of the backend validator
 * (`api/app/core/gstin.py`): structure regex + place-of-supply state code +
 * mod-36 check character. Kept in lockstep so the form rejects a malformed
 * GSTIN inline instead of surfacing it as a 422 round-trip.
 *
 * Pure functions, no I/O. If these ever diverge from the backend, the backend
 * is authoritative and the save still fails safely there.
 */

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GST state codes 01–38 plus 97 (Other Territory) — matches VALID_STATE_CODES. */
export const GST_STATE_CODES: ReadonlySet<string> = new Set([
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')),
  '97',
]);

/** GST state code → State name (place of supply printed on the tax invoice). */
const GST_STATE_NAMES: Readonly<Record<string, string>> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman & Diu',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/** Trim + uppercase, matching the backend's `normalize_gstin`. */
export function normalizeGstin(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Return the GST State name for a 2-digit code (`"27" → "Maharashtra"`). */
export function gstStateName(code: string | null | undefined): string | null {
  const key = (code || '').trim();
  return key ? (GST_STATE_NAMES[key] ?? null) : null;
}

/** Mod-36 check character over the first 14 GSTIN characters. */
function computeCheckChar(body14: string): string {
  let total = 0;
  for (let i = 0; i < body14.length; i += 1) {
    const value = CHARS.indexOf(body14[i]);
    const product = value * (i % 2 ? 2 : 1);
    total += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (total % 36)) % 36];
}

/** Structure + state code + checksum — the exact contract of `is_valid_gstin`. */
export function isValidGstin(raw: string): boolean {
  const gstin = normalizeGstin(raw || '');
  if (!GSTIN_RE.test(gstin)) return false;
  if (!GST_STATE_CODES.has(gstin.slice(0, 2))) return false;
  return gstin[gstin.length - 1] === computeCheckChar(gstin.slice(0, -1));
}
