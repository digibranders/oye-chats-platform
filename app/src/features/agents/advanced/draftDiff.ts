/**
 * Structural comparison for the two settings drafts on this route pair.
 *
 * Both pages hold a plain-data draft beside the values they loaded, and the
 * Save bar exists only while the two differ. A plain `JSON.stringify` is not
 * enough to decide that: `bant_config` is an opaque server object whose key
 * order is not guaranteed, so a payload that re-serialises in a different order
 * would report a false "unsaved changes" and hold the user hostage to a Save
 * button that changes nothing.
 *
 * Sorting keys recursively makes the comparison depend on values alone.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** Order-independent structural equality for a plain-data draft. */
export function draftsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
