/**
 * Every word in the query has to appear somewhere in the item, in any order.
 *
 * Base UI's own default `contains` is a single whole-query substring scan
 * (read directly from `@base-ui/react/internals/filter.mjs`): one slice of
 * the query, tested once against one slice of the item's searchable text.
 * That means "hours business" would never match an item whose text reads
 * "...Business Hours...", only "business hours" would — and a command
 * palette is exactly the surface where a reader types the words in whatever
 * order they come to mind.
 *
 * This wraps the SAME `Intl.Collator`-backed `contains` Base UI already
 * computes (`Combobox.useFilter()`), so case-insensitivity and accent-folding
 * are unchanged, and applies it once per query word instead of once per
 * query. No typo tolerance: every word still has to be a real substring
 * somewhere. That is a deliberate, stated scope limit — see
 * docs/superpowers/specs/2026-09-10-command-palette-settings-search-design.md.
 */
export function makePaletteFilter<Item>(
  contains: (item: Item, query: string, itemToString?: (item: Item) => string) => boolean,
) {
  return function paletteFilter(
    itemValue: Item,
    query: string,
    itemToString?: (item: Item) => string,
  ): boolean {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    return words.every((word) => contains(itemValue, word, itemToString));
  };
}
