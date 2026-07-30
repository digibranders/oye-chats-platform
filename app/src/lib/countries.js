/**
 * ISO 3166-1 alpha-2 country options for searchable selects.
 *
 * Only the code list is hardcoded (the 249 officially assigned alpha-2
 * codes); display names come from the browser's own `Intl.DisplayNames`
 * so we don't ship a 250-entry name table, and flags are derived from the
 * code's regional-indicator pair. The option `value` is always the bare
 * 2-letter code - exactly what the backend's `billing_country` column
 * stores.
 */

// prettier-ignore
const ISO_3166_ALPHA2 = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW',
  'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT',
  'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS',
  'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA',
  'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
  'WF', 'WS',
  'YE', 'YT',
  'ZA', 'ZM', 'ZW',
];

// Codes kept in the canonical ISO list above (so it stays a faithful
// reference) but hidden from the billing-country selector. British Indian
// Ocean Territory (IO) has no resident civilian/customer population and only
// surfaces as noise when searching "india"; exclude it from the picker.
const EXCLUDED_CODES = new Set(['IO']);

function flagEmoji(code) {
  // Regional indicator symbols: 'A' (65) → U+1F1E6.
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function countryName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

/** `[{ value: 'IN', label: '🇮🇳 India', search: 'india in' }, …]` sorted by name. */
export const COUNTRY_OPTIONS = ISO_3166_ALPHA2.filter((code) => !EXCLUDED_CODES.has(code))
  .map((code) => {
    const name = countryName(code);
    return { value: code, label: `${flagEmoji(code)} ${name}`, search: `${name} ${code}`.toLowerCase() };
  })
  .sort((a, b) => a.search.localeCompare(b.search));

const LABEL_BY_CODE = Object.fromEntries(COUNTRY_OPTIONS.map((opt) => [opt.value, opt.label]));

/** Display label for a stored code - falls back to the raw code for anything unknown. */
export function countryLabel(code) {
  const normalized = (code || '').trim().toUpperCase();
  return LABEL_BY_CODE[normalized] || normalized;
}
