import { type ReactElement } from 'react';
import { FileText, Globe, Mail, MessageSquare, type LucideIcon } from 'lucide-react';
import { formatCredits, type CreditBalance } from '../usage-model';

interface BreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly creditsUsed: number;
  readonly eventCount: number;
}

export interface CreditBreakdownProps {
  balance: CreditBalance;
}

/**
 * CreditBreakdown — where this period's credits went, as ranked horizontal
 * bars (magnitude of a single measure across categories). One accent hue,
 * length-encoded, sorted high→low, with the raw credits + event count direct-
 * labeled. Lightweight by design — no chart library, no pie. Skips rendering
 * when nothing has been consumed yet.
 */
export function CreditBreakdown({ balance }: CreditBreakdownProps): ReactElement | null {
  const rows: BreakdownRow[] = [
    { key: 'crawler', label: 'Crawler', icon: Globe, creditsUsed: balance.urlScan.creditsUsed, eventCount: balance.urlScan.eventCount },
    { key: 'documents', label: 'Documents', icon: FileText, creditsUsed: balance.documentUpload.creditsUsed, eventCount: balance.documentUpload.eventCount },
    { key: 'chat', label: 'AI chat', icon: MessageSquare, creditsUsed: balance.aiChat.creditsUsed, eventCount: balance.aiChat.eventCount },
    { key: 'emails', label: 'Emails', icon: Mail, creditsUsed: balance.emailSend.creditsUsed, eventCount: balance.emailSend.eventCount },
  ].sort((a, b) => b.creditsUsed - a.creditsUsed);

  const total = rows.reduce((sum, row) => sum + row.creditsUsed, 0);
  if (total === 0) return null;

  const max = Math.max(...rows.map((row) => row.creditsUsed), 1);

  return (
    <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-[var(--ds-text-muted)]">Where credits go</span>
        <span className="text-[12px] tabular-nums text-[var(--ds-text-subtle)]">this period</span>
      </div>
      <ul className="space-y-3.5">
        {rows.map((row) => {
          const Icon = row.icon;
          const pct = Math.round((row.creditsUsed / max) * 100);
          const share = total > 0 ? Math.round((row.creditsUsed / total) * 100) : 0;
          return (
            <li key={row.key}>
              <div className="mb-1.5 flex items-center justify-between gap-3 text-[13px]">
                <span className="flex items-center gap-2 text-[var(--ds-text)]">
                  <Icon size={15} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
                  {row.label}
                </span>
                <span className="tabular-nums text-[var(--ds-text-muted)]">
                  <span className="font-semibold text-[var(--ds-text)]">{formatCredits(row.creditsUsed)}</span>
                  <span className="text-[var(--ds-text-subtle)]"> · {share}%</span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
                <div
                  className="h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-500"
                  style={{ width: `${Math.max(pct, row.creditsUsed > 0 ? 3 : 0)}%` }}
                  role="img"
                  aria-label={`${row.label}: ${formatCredits(row.creditsUsed)} credits, ${share}% of this period`}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
