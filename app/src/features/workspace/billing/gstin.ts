/**
 * GSTIN validation - a faithful client mirror of the backend validator
 * (`api/app/core/gstin.py`): structure regex + place-of-supply state code +
 * mod-36 check character. Kept in lockstep so the form rejects a malformed
 * GSTIN inline instead of surfacing it as a 422 round-trip.
 *
 * Pure functions, no I/O. If these ever diverge from the backend, the backend
 * is authoritative and the save still fails safely there.
 */

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GST state codes 01–38 plus 97 (Other Territory) - matches VALID_STATE_CODES. */
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

/** Structure + state code + checksum - the exact contract of `is_valid_gstin`. */
export function isValidGstin(raw: string): boolean {
  const gstin = normalizeGstin(raw || '');
  if (!GSTIN_RE.test(gstin)) return false;
  if (!GST_STATE_CODES.has(gstin.slice(0, 2))) return false;
  return gstin[gstin.length - 1] === computeCheckChar(gstin.slice(0, -1));
}

/** GST state options for the State dropdown, in code order. */
export const GST_STATE_OPTIONS: { value: string; label: string; search: string }[] = Object.entries(
  GST_STATE_NAMES,
).map(([code, name]) => ({ value: code, label: name, search: `${name} ${code}` }));

// ── PIN → GST state autofill ─────────────────────────────────────────────────
// Indian PIN codes are allocated by postal circle; the first 2-3 digits map to
// a state closely enough for a FORM AUTOFILL (the dropdown stays editable and
// the server still validates). 3-digit overrides handle the enclaves whose
// prefix lives inside a bigger neighbour's range (Goa in 40x, Sikkim in 73x…).

const PIN3_TO_STATE: Readonly<Record<string, string>> = {
  '160': '04', // Chandigarh inside the Punjab range
  '194': '01', // Ladakh region PINs are administered under J&K allocation; see note
  '246': '05', '248': '05', '249': '05', '263': '05', // Uttarakhand inside UP range
  '403': '30', // Goa inside the Maharashtra range
  '605': '34', // Puducherry inside the TN range
  '737': '11', // Sikkim inside the WB range
  '744': '35', // Andaman & Nicobar inside the WB range
  '790': '12', '791': '12', '792': '12', // Arunachal Pradesh
  '793': '17', '794': '17', // Meghalaya
  '795': '14', // Manipur
  '796': '15', // Mizoram
  '797': '13', '798': '13', // Nagaland
  '799': '16', // Tripura
  '814': '20', '815': '20', '816': '20', '822': '20', '825': '20', '826': '20',
  '827': '20', '828': '20', '829': '20', '831': '20', '832': '20', '833': '20',
  '834': '20', '835': '20', // Jharkhand inside the Bihar range
};

const PIN2_TO_STATE: Readonly<Record<string, string>> = {
  '11': '07', // Delhi
  '12': '06', '13': '06', // Haryana
  '14': '03', '15': '03', '16': '03', // Punjab
  '17': '02', // Himachal Pradesh
  '18': '01', '19': '01', // Jammu & Kashmir
  '20': '09', '21': '09', '22': '09', '23': '09', '24': '09', '25': '09',
  '26': '09', '27': '09', '28': '09', // Uttar Pradesh
  '30': '08', '31': '08', '32': '08', '33': '08', '34': '08', // Rajasthan
  '36': '24', '37': '24', '38': '24', '39': '24', // Gujarat
  '40': '27', '41': '27', '42': '27', '43': '27', '44': '27', // Maharashtra
  '45': '23', '46': '23', '47': '23', '48': '23', // Madhya Pradesh
  '49': '22', // Chhattisgarh
  '50': '36', // Telangana
  '51': '37', '52': '37', '53': '37', // Andhra Pradesh
  '56': '29', '57': '29', '58': '29', '59': '29', // Karnataka
  '60': '33', '61': '33', '62': '33', '63': '33', '64': '33', // Tamil Nadu
  '67': '32', '68': '32', '69': '32', // Kerala
  '70': '19', '71': '19', '72': '19', '73': '19', '74': '19', // West Bengal
  '75': '21', '76': '21', '77': '21', // Odisha
  '78': '18', // Assam
  '80': '10', '81': '10', '82': '10', '83': '10', '84': '10', '85': '10', // Bihar
};

/**
 * Best-effort GST state for an Indian 6-digit PIN, or null when the PIN is
 * incomplete/unknown. Used to autofill (never overwrite) the State dropdown.
 */
export function gstStateFromPin(raw: string): string | null {
  const pin = (raw || '').replace(/\D/g, '');
  if (pin.length !== 6) return null;
  return PIN3_TO_STATE[pin.slice(0, 3)] ?? PIN2_TO_STATE[pin.slice(0, 2)] ?? null;
}

