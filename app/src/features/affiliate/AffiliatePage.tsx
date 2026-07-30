/**
 * AffiliatePage - the Workspace ▸ Affiliate surface. One job: answer
 * "How are my referral codes performing, and how do I share them?".
 *
 * Rebuilt from the legacy `pages/AffiliateDashboard.jsx` in the new design
 * language. Shows the affiliate's commission pool, four headline counters, and a
 * table of their codes - each with a one-click "copy share link". A new code is
 * created through a focused modal; a code is activated/deactivated inline
 * (respecting the active-code cap). Referral detail + editing land in follow-up
 * modals.
 *
 * Backend reused verbatim (typed in services/api.d.ts): getAffiliateMe,
 * getAffiliateCodes, getAffiliateStats, updateAffiliateCode. Business rules
 * (pool cap, split validation, code format) mirror affiliate_service.py.
 */
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Gift, Loader2, Plus, Share2, X } from 'lucide-react';
import {
  Button,
  buttonVariants,
  Card,
  DataTable,
  EmptyState,
  MetricCard,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
  type Column,
} from '../../design-system';
import { updateAffiliateCode } from '../../services/api';
import { type AffiliateCodeView, formatPct, referralShareUrl } from './affiliateModel';
import { useAffiliateData } from './useAffiliateData';
import { CreateCodeModal } from './CreateCodeModal';
import { EditCodeModal } from './EditCodeModal';
import { ReferralsModal } from './ReferralsModal';

/**
 * Where a `?ref=CODE` visitor lands - the public marketing site captures the
 * click. Overridable per-environment; defaults to the production site.
 */
const REFERRAL_BASE_URL: string =
  (import.meta.env.VITE_MARKETING_URL as string | undefined) ?? 'https://oyechats.com';

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// ── Copy-to-clipboard button (self-resetting) ────────────────────────────────

function CopyLinkButton({ url, label }: { url: string; label: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable - no-op, the link is still visible on hover */
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={copied ? 'Link copied' : label}
      onClick={() => void copy()}
    >
      {copied ? (
        <Check size={14} aria-hidden="true" className="text-[var(--ds-success)]" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      {copied ? 'Copied' : 'Copy link'}
    </Button>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function AffiliatePage(): ReactElement {
  const { loading, notEnrolled, error, profile, codes, stats, reload } = useAffiliateData();
  const [createOpen, setCreateOpen] = useState(false);
  const [editCode, setEditCode] = useState<AffiliateCodeView | null>(null);
  const [referralsFor, setReferralsFor] = useState<AffiliateCodeView | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const poolPct = profile?.commissionPct ?? 0;
  const activeCount = useMemo(() => codes.filter((c) => c.active).length, [codes]);
  const atCap = profile != null && activeCount >= profile.maxActiveCodes;

  const toggleActive = useCallback(
    async (row: AffiliateCodeView): Promise<void> => {
      setActionError(null);
      setTogglingId(row.id);
      try {
        await updateAffiliateCode(row.id, { active: !row.active });
        reload();
      } catch (err) {
        setActionError(toMessage(err, 'Could not update the code.'));
      } finally {
        setTogglingId(null);
      }
    },
    [reload],
  );

  const columns: Column<AffiliateCodeView>[] = useMemo(
    () => [
      {
        key: 'code',
        header: 'Code',
        render: (row) => (
          <div className="flex items-center gap-2">
            <code className="rounded-md bg-[var(--ds-bg-sunken)] px-2 py-1 font-mono text-[13px] font-medium text-[var(--ds-text)]">
              {row.code}
            </code>
            {row.label && <span className="truncate text-[12px] text-[var(--ds-text-subtle)]">{row.label}</span>}
          </div>
        ),
      },
      {
        key: 'affiliateCommissionPct',
        header: 'You earn',
        align: 'right',
        render: (row) => <span className="tabular-nums">{formatPct(row.affiliateCommissionPct)}</span>,
      },
      {
        key: 'customerDiscountPct',
        header: 'Friend saves',
        align: 'right',
        render: (row) => <span className="tabular-nums">{formatPct(row.customerDiscountPct)}</span>,
      },
      {
        key: 'clicks',
        header: 'Clicks',
        align: 'right',
        render: (row) => <span className="tabular-nums">{row.clicks.toLocaleString()}</span>,
      },
      {
        key: 'signups',
        header: 'Signups',
        align: 'right',
        render: (row) => <span className="tabular-nums">{row.signups.toLocaleString()}</span>,
      },
      {
        key: 'conversionPct',
        header: 'Conv.',
        align: 'right',
        render: (row) => <span className="tabular-nums text-[var(--ds-text-muted)]">{formatPct(row.conversionPct)}</span>,
      },
      {
        key: 'status',
        header: 'Status',
        render: (row) =>
          row.active ? (
            <StatusBadge tone="success" dot>
              Active
            </StatusBadge>
          ) : (
            <StatusBadge tone="neutral" dot>
              Inactive
            </StatusBadge>
          ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        render: (row) => (
          <div className="flex items-center justify-end gap-1">
            <CopyLinkButton url={referralShareUrl(row.code, REFERRAL_BASE_URL)} label={`Copy share link for ${row.code}`} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setReferralsFor(row)}>
              View
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditCode(row)}>
              Edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              // Reactivating a code counts against the active cap; block it when full.
              disabled={togglingId === row.id || (!row.active && atCap)}
              title={!row.active && atCap ? 'You’ve reached your active-code limit' : undefined}
              onClick={() => void toggleActive(row)}
            >
              {togglingId === row.id ? (
                <Loader2 size={14} aria-hidden="true" className="animate-spin" />
              ) : row.active ? (
                'Deactivate'
              ) : (
                'Activate'
              )}
            </Button>
          </div>
        ),
      },
    ],
    [togglingId, atCap, toggleActive],
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <PageContainer title="Affiliate" description="Share OyeChats, earn commission on every referral.">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </PageContainer>
    );
  }

  // ── Not an affiliate ─────────────────────────────────────────────────────────
  if (notEnrolled) {
    return (
      <PageContainer title="Affiliate" description="Share OyeChats, earn commission on every referral.">
        <EmptyState
          icon={Gift}
          title="You’re not in the affiliate program yet"
          description="The OyeChats affiliate program is invite-only. If you’d like to partner with us and earn commission on referrals, reach out to our team."
          action={
            <a
              href="mailto:developer@oyechats.com?subject=OyeChats%20Affiliate%20Program"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Request an invite
            </a>
          }
        />
      </PageContainer>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <PageContainer title="Affiliate" description="Share OyeChats, earn commission on every referral.">
        <div className="rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-4 py-3">
          <p className="text-[13px] text-[var(--ds-text)]">{error}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={reload}>
            Try again
          </Button>
        </div>
      </PageContainer>
    );
  }

  // ── Ready ────────────────────────────────────────────────────────────────────
  return (
    <PageContainer
      title="Affiliate"
      description="Share OyeChats, earn commission on every referral."
      actions={
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={atCap}
          title={atCap ? 'You’ve reached your active-code limit - deactivate one to add another' : undefined}
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={15} aria-hidden="true" />
          New code
        </Button>
      }
    >
      {/* Commission pool + headline counters */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="accent" dot>
          {formatPct(poolPct)} commission pool
        </StatusBadge>
        <span className="text-[12px] text-[var(--ds-text-subtle)]">
          Split it between your cut and your friend’s discount, however you like.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard
          label="Active codes"
          value={`${stats?.activeCodes ?? activeCount} / ${profile?.maxActiveCodes ?? 0}`}
        />
        <MetricCard label="Total clicks" value={(stats?.totalClicks ?? 0).toLocaleString()} />
        <MetricCard label="Signups" value={(stats?.totalSignups ?? 0).toLocaleString()} />
        <MetricCard label="Conversion" value={formatPct(stats?.conversionPct ?? 0)} />
      </div>

      {/* Codes */}
      <div className="space-y-4">
        <SectionHeader title="Your referral codes" description="Copy a code’s share link and send it to your audience." />

        {actionError && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-4 py-3 text-[13px] text-[var(--ds-text)]">
            <span className="flex items-start gap-2">
              <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-danger)]" />
              {actionError}
            </span>
            <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss message" className="shrink-0 opacity-70 hover:opacity-100">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}

        {codes.length === 0 ? (
          <EmptyState
            icon={Share2}
            title="No referral codes yet"
            description="Create your first code, then share its link. You’ll earn commission whenever someone subscribes through it."
            action={
              <Button type="button" variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus size={15} aria-hidden="true" />
                Create a code
              </Button>
            }
          />
        ) : (
          <Card className="overflow-hidden">
            <DataTable columns={columns} rows={codes} rowKey={(row) => row.id} caption="Your referral codes" />
          </Card>
        )}
      </div>

      <CreateCodeModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        poolPct={poolPct}
        onCreated={() => {
          setCreateOpen(false);
          reload();
        }}
      />

      <EditCodeModal
        open={editCode !== null}
        onClose={() => setEditCode(null)}
        code={editCode}
        poolPct={poolPct}
        onSaved={() => {
          setEditCode(null);
          reload();
        }}
      />

      <ReferralsModal
        open={referralsFor !== null}
        onClose={() => setReferralsFor(null)}
        codeId={referralsFor?.id ?? null}
        codeName={referralsFor?.code ?? null}
      />
    </PageContainer>
  );
}
