/** Every entry pushed to the GTM dataLayer under one event name, in push order. */
export function dataLayerEvents(name: string): Record<string, unknown>[] {
  return (window.dataLayer ?? []).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && (entry as { event?: unknown }).event === name,
  );
}
