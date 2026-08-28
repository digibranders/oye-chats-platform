export interface FunnelStage {
  key: string;
  label: string;
  count: number;
}

/**
 * The stages `GET /analytics/qualification-funnel` returns, in order.
 *
 * Ordered here rather than trusted from the payload: the server builds the list
 * top-down and each stage's conversion rate is relative to the one before it, so
 * a reordering would silently turn the chart into nonsense.
 */
export const FUNNEL_STAGES: readonly { key: string; label: string }[] = [
  { key: 'total_visitors', label: 'Conversations' },
  { key: 'engaged', label: 'Engaged' },
  { key: 'mql', label: 'Marketing qualified' },
  { key: 'sal', label: 'Sales accepted' },
  { key: 'sql', label: 'Sales qualified' },
  { key: 'meetings_booked', label: 'Meetings booked' },
];

/** Narrow the loosely-typed funnel payload into the ordered stages. */
export function parseFunnel(payload: unknown): FunnelStage[] {
  const rows =
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as { funnel?: unknown }).funnel)
      ? (payload as { funnel: unknown[] }).funnel
      : [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.stage === 'string' && typeof record.count === 'number') {
      counts.set(record.stage, record.count);
    }
  }
  return FUNNEL_STAGES.map((stage) => ({
    key: stage.key,
    label: stage.label,
    count: counts.get(stage.key) ?? 0,
  }));
}
