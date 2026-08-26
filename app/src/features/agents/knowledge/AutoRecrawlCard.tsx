import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock,
  History,
  Lock,
  RefreshCw,
} from 'lucide-react';
import { Button, Card, IconTile, Skeleton, cn } from '../../../design-system';
import { fetchRecrawlStatus, setAutoRecrawl, type RecrawlStatus } from './recrawl-api';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';
import { formatNumber } from '../../../i18n/formatters';

export interface AutoRecrawlCardProps {
  /** The agent whose weekly auto-recrawl is configured. */
  botId: number;
  /** Bumped by the parent (e.g. after a crawl finishes) to force a reload. */
  reloadToken?: number;
  /** Invoked when a non-entitled user tries to enable auto-recrawl. */
  onUpgrade: () => void;
}

/**
 * AutoRecrawlCard - bot-scoped weekly auto-refresh of every crawled URL, plus
 * the re-crawl run history. Standard+ plans get a working toggle with the next
 * scheduled run and recent-run summaries; lower tiers see the same layout with
 * the toggle gated to the upgrade flow. The backend re-enforces the entitlement
 * on every write, so a stale client cache can't grant the feature.
 */
export function AutoRecrawlCard({ botId, reloadToken = 0, onUpgrade }: AutoRecrawlCardProps): ReactElement {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RecrawlStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  const activeBotRef = useRef<number>(botId);

  useEffect(() => {
    activeBotRef.current = botId;
    let cancelled = false;
    const load = async (): Promise<void> => {
      setStatus(null);
      setLoadError(null);
      try {
        const data = await fetchRecrawlStatus(botId);
        if (!cancelled && activeBotRef.current === botId) setStatus(data);
      } catch (err) {
        if (!cancelled && activeBotRef.current === botId) {
          setLoadError(err instanceof Error ? err.message : translateNow('agents.weCouldntLoadAutoRetrain') || 'We couldn\'t load auto-retrain.');
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [botId, reloadToken]);

  // Auto-dismiss the transient success flash so it doesn't linger as a banner.
  useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(timer);
  }, [flash]);

  const commit = useCallback(
    async (next: boolean): Promise<void> => {
      setSaving(true);
      setActionError(null);
      setConfirmingDisable(false);
      try {
        const updated = await setAutoRecrawl(botId, next);
        if (activeBotRef.current !== botId) return;
        setStatus(updated);
        setFlash(
          next
            ? translateNow('agents.autoRetrainOnWellCheck') || 'Auto-retrain on. We’ll check for changes every week.'
            : translateNow('agents.autoRetrainOffTurnIt') || 'Auto-retrain off. Turn it back on any time to resume the weekly refresh.',
        );
      } catch (err) {
        setActionError(err instanceof Error ? err.message : translateNow('agents.weCouldntUpdateAutoRetrain') || 'We couldn\'t update auto-retrain.');
      } finally {
        setSaving(false);
      }
    },
    [botId],
  );

  const locked = status?.featureAvailable === false;

  const handleToggle = useCallback((): void => {
    if (locked) {
      onUpgrade();
      return;
    }
    if (status?.enabled) {
      setConfirmingDisable(true);
      return;
    }
    void commit(true);
  }, [locked, status?.enabled, onUpgrade, commit]);

  if (status === null && loadError === null) {
    return (
      <Card className="p-5">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
      </Card>
    );
  }

  if (loadError !== null) {
    return (
      <Card className="p-5">
        <p className="flex items-center gap-2 text-[13px] text-[var(--ds-danger)]">
          <AlertCircle size={16} aria-hidden="true" />
          {loadError}
        </p>
      </Card>
    );
  }

  const data = status as RecrawlStatus;
  const toggleOn = !locked && data.enabled;

  return (
    <Card className="overflow-hidden">
      <div className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <IconTile icon={RefreshCw} tone="accent" size="md" />
            <div>
              <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">{t('agents.autoRetrain') || 'Auto-retrain'}</h3>
              <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
                {t('agents.weeklyRefreshHint') ||
                  'Refresh every trained website once a week. We only re-learn pages whose content actually changed.'}
              </p>
            </div>
          </div>

          <ToggleSwitch
            on={toggleOn}
            disabled={saving}
            label={
              locked
                ? t('agents.upgradeToStandardToEnable') || 'Upgrade to Standard to enable weekly auto-retrain'
                : t('agents.toggleWeeklyAutoRetrain') || 'Toggle weekly auto-retrain'
            }
            onToggle={handleToggle}
          />
        </div>

        {locked && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--ds-warning-soft)] bg-[var(--ds-warning-soft)] px-4 py-2.5 text-[12px] text-[var(--ds-warning)]">
            <Lock size={14} aria-hidden="true" />
            {t('agents.weeklyAutoRetrainIsA') || 'Weekly auto-retrain is a Standard plan feature.'}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <StatusTile
            icon={<CalendarClock size={14} aria-hidden="true" />}
            label={t('agents.cadence') || 'Cadence'}
            value={
              toggleOn
                ? translateNow('agents.everyNDays', { count: formatNumber(data.cadenceDays) }) ||
                  `Every ${formatNumber(data.cadenceDays)} days`
                : translateNow('agents.off') || 'Off'
            }
          />
          <StatusTile
            icon={<Clock size={14} aria-hidden="true" />}
            label={t('agents.lastChecked') || 'Last checked'}
            value={data.lastRecrawlAt ? formatRelative(data.lastRecrawlAt) : '-'}
            sub={data.lastRecrawlStatus ? capitalize(data.lastRecrawlStatus) : null}
          />
          <StatusTile
            icon={<CalendarClock size={14} aria-hidden="true" />}
            label={t('agents.nextCheck') || 'Next check'}
            value={toggleOn && data.nextRecrawlAt ? formatRelative(data.nextRecrawlAt) : '-'}
            sub={toggleOn && data.nextRecrawlAt ? formatDate(data.nextRecrawlAt) : null}
          />
        </div>

        <p className="text-[12px] text-[var(--ds-text-subtle)]">
          {data.sourcesCount === 0
            ? t('agents.noTrainedWebsitesYetAdd') || 'No trained websites yet. Add a website above to build the retrain set.'
            : `${data.sourcesCount} website${data.sourcesCount === 1 ? '' : 's'} in the retrain set.`}
        </p>

        {confirmingDisable && (
          <div
            role="group"
            aria-label={t('agents.confirmTurningOffAutoRetrain') || 'Confirm turning off auto-retrain'}
            className="space-y-3 rounded-lg border border-[var(--ds-warning-soft)] bg-[var(--ds-warning-soft)] px-4 py-3"
          >
            <div className="text-[13px] text-[var(--ds-text)]">
              <p className="font-medium">{t('agents.turnOffAutoRetrain') || 'Turn off auto-retrain?'}</p>
              <p className="mt-0.5 text-[var(--ds-text-muted)]">
                {t('agents.turnOffAutoRetrainConsequence') ||
                  'Your chatbot stops refreshing crawled pages automatically. Turning it back on later starts a fresh 7-day countdown.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="danger" size="sm" onClick={() => void commit(false)} disabled={saving}>
                {saving ? t('agents.turningOff') || 'Turning off…' : t('agents.turnOff') || 'Turn off'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDisable(false)}>
                {t('agents.keepItOn') || 'Keep it on'}
              </Button>
            </div>
          </div>
        )}

        {flash && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-[var(--ds-success-soft)] bg-[var(--ds-success-soft)] px-4 py-2.5 text-[13px] text-[var(--ds-success)]"
          >
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {flash}
          </p>
        )}

        {actionError && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-4 py-2.5 text-[13px] text-[var(--ds-danger)]"
          >
            <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {actionError}
          </p>
        )}

        {data.history.length > 0 && (
          <div className="space-y-2 border-t border-[var(--ds-border)] pt-4">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
              <History size={13} aria-hidden="true" />
              {t('agents.recentRetrains') || 'Recent retrains'}
            </div>
            <ul className="space-y-1">
              {data.history.map((entry, i) => (
                <li
                  key={`${entry.ranAt ?? 'run'}-${i}`}
                  className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] tabular-nums text-[var(--ds-text-muted)]"
                >
                  <span className="min-w-[7rem] text-[var(--ds-text-subtle)]">
                    {entry.ranAt ? formatDate(entry.ranAt) : '-'}
                  </span>
                  <span>
                    <span className="text-[var(--ds-text-subtle)]">{t('agents.unchanged') || 'unchanged'}</span>{' '}
                    <span className="font-medium text-[var(--ds-text)]">{entry.unchanged}</span>
                  </span>
                  <span>
                    <span className="text-[var(--ds-text-subtle)]">{t('agents.updated') || 'updated'}</span>{' '}
                    <span className="font-medium text-[var(--ds-accent)]">{entry.changed}</span>
                  </span>
                  <span>
                    <span className="text-[var(--ds-text-subtle)]">{t('agents.failed') || 'failed'}</span>{' '}
                    <span
                      className={cn(
                        'font-medium',
                        entry.failed > 0 ? 'text-[var(--ds-danger)]' : 'text-[var(--ds-text-subtle)]',
                      )}
                    >
                      {entry.failed}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Local presentational helpers ────────────────────────────────────────────

function ToggleSwitch({
  on,
  disabled,
  label,
  onToggle,
}: {
  on: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ds-ring)]',
        on ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-border-strong)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-sm)] transition-transform',
          on ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

function StatusTile({
  icon,
  label,
  value,
  sub,
}: {
  icon: ReactElement;
  label: string;
  value: string;
  sub?: string | null;
}): ReactElement {
  return (
    <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-[13px] font-medium text-[var(--ds-text)]">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-[var(--ds-text-subtle)]">{sub}</div>}
    </div>
  );
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function capitalize(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function formatDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '-';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const diffMs = then - Date.now();
  const absSeconds = Math.abs(diffMs) / 1000;
  const isFuture = diffMs > 0;
  const units: { limit: number; label: string; divisor: number }[] = [
    { limit: 60, label: 'sec', divisor: 1 },
    { limit: 3600, label: 'min', divisor: 60 },
    { limit: 86_400, label: 'hour', divisor: 3600 },
    { limit: 604_800, label: 'day', divisor: 86_400 },
    { limit: 2_629_800, label: 'week', divisor: 604_800 },
    { limit: Infinity, label: 'month', divisor: 2_629_800 },
  ];
  const unit = units.find((u) => absSeconds < u.limit) ?? units[units.length - 1];
  const value = Math.round(absSeconds / unit.divisor);
  const label = value === 1 ? unit.label : `${unit.label}s`;
  return isFuture ? `in ${value} ${label}` : `${value} ${label} ago`;
}
