import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Handshake, MoreHorizontal, Pause, Pencil, Play, Plus, Users } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  CopyField,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  PageHeader,
  Stack,
  StatTile,
  buttonClass,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import { updateAffiliateCode } from '../../services/api';
import { formatPct, referralShareUrl, type AffiliateCodeView } from './affiliateModel';
import { useAffiliateData } from './useAffiliateData';
import { CodeDialog } from './CodeDialog';
import { ReferralsDrawer } from './ReferralsDrawer';

/**
 * Settings ▸ Affiliate — the referral codes an enrolled partner shares.
 *
 * Where a `?ref=CODE` click lands is the public marketing site, not the
 * console, so the share link is built from the marketing origin rather than
 * from `window.location`. Getting that wrong produces a link that works when
 * the affiliate tests it and attributes nothing.
 */
const REFERRAL_BASE_URL: string =
  (import.meta.env.VITE_MARKETING_URL as string | undefined) ?? 'https://www.oyechats.com';

export function AffiliatePage() {
  const { loading, notEnrolled, error, profile, codes, stats, reload } = useAffiliateData();
  const [editing, setEditing] = useState<AffiliateCodeView | null | 'new'>(null);
  const [inspecting, setInspecting] = useState<AffiliateCodeView | null>(null);
  const [pausing, setPausing] = useState<AffiliateCodeView | null>(null);

  const poolPct = profile?.commissionPct ?? 0;
  const activeCount = codes.filter((code) => code.active).length;
  const atCap = profile != null && activeCount >= profile.maxActiveCodes;

  const setActive = useMutation({
    mutationFn: ({ code, active }: { code: AffiliateCodeView; active: boolean }) =>
      updateAffiliateCode(code.id, { active }),
    onSuccess: (_data, { active }) => {
      toast.success(active ? 'Code reactivated' : 'Code paused');
      setPausing(null);
      reload();
    },
    onError: (mutationError) =>
      toast.error(
        mutationError instanceof Error ? mutationError.message : 'Could not update that code.',
      ),
  });

  const header = (
    <PageHeader
      title="Affiliate"
      description="Your referral codes, what each one has brought in, and the links to share."
      actions={
        !notEnrolled && !loading ? (
          <Button
            onClick={() => setEditing('new')}
            disabled={atCap}
            iconLeft={<Plus aria-hidden className="h-4 w-4" />}
          >
            New code
          </Button>
        ) : undefined
      }
    />
  );

  if (loading) {
    return (
      <>
        {header}
        <Card>
          <CardBody>
            <LoadingRows rows={4} />
          </CardBody>
        </Card>
      </>
    );
  }

  // Not an error: the programme is invite-only, so this is simply the answer.
  if (notEnrolled) {
    return (
      <>
        {header}
        <Card>
          <EmptyState
            icon={Handshake}
            title="You are not in the partner programme"
            description="OyeChats Partners is invite-only. If you refer customers to us and would like a share of what they pay, talk to your OyeChats contact and we will send you an invitation."
          />
        </Card>
      </>
    );
  }

  if (error) {
    return (
      <>
        {header}
        <Card>
          <ErrorState
            title="We could not load your affiliate dashboard"
            description={error}
            onRetry={reload}
          />
        </Card>
      </>
    );
  }

  const columns: Column<AffiliateCodeView>[] = [
    {
      key: 'code',
      header: 'Code',
      pinned: true,
      width: '14rem',
      sortable: (a, b) => a.code.localeCompare(b.code),
      render: (row) => (
        <div className="min-w-0">
          <p className="figure truncate text-sm font-medium text-text-primary">{row.code}</p>
          <p className="truncate text-xs text-text-secondary">{row.label ?? 'No label'}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge tone={row.active ? 'success' : 'neutral'} dot>
          {row.active ? 'Active' : 'Paused'}
        </Badge>
      ),
    },
    {
      key: 'split',
      header: 'Split',
      secondary: true,
      render: (row) => (
        <span className="text-xs text-text-secondary">
          <span className="figure text-text-primary">{formatPct(row.affiliateCommissionPct)}</span>{' '}
          you ·{' '}
          <span className="figure text-text-primary">{formatPct(row.customerDiscountPct)}</span>{' '}
          them
        </span>
      ),
    },
    {
      key: 'clicks',
      header: 'Clicks',
      align: 'right',
      sortable: (a, b) => a.clicks - b.clicks,
      render: (row) => <span className="figure">{formatNumber(row.clicks)}</span>,
    },
    {
      key: 'signups',
      header: 'Signups',
      align: 'right',
      sortable: (a, b) => a.signups - b.signups,
      render: (row) => <span className="figure">{formatNumber(row.signups)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '3rem',
      render: (row) => (
        <MenuRoot>
          <MenuTrigger aria-label={`Actions for ${row.code}`} className={buttonClass('ghost', 'icon-sm')}>
            <MoreHorizontal aria-hidden className="h-4 w-4" />
          </MenuTrigger>
          <MenuContent>
            <MenuItem
              icon={<Users aria-hidden className="h-3.5 w-3.5" />}
              onSelect={() => setInspecting(row)}
            >
              See referrals
            </MenuItem>
            <MenuItem
              icon={<Pencil aria-hidden className="h-3.5 w-3.5" />}
              onSelect={() => setEditing(row)}
            >
              Edit code
            </MenuItem>
            {row.active ? (
              <MenuItem
                icon={<Pause aria-hidden className="h-3.5 w-3.5" />}
                onSelect={() => setPausing(row)}
              >
                Pause code
              </MenuItem>
            ) : (
              <MenuItem
                icon={<Play aria-hidden className="h-3.5 w-3.5" />}
                disabled={atCap}
                onSelect={() => setActive.mutate({ code: row, active: true })}
              >
                Reactivate code
              </MenuItem>
            )}
          </MenuContent>
        </MenuRoot>
      ),
    },
  ];

  return (
    <>
      {header}
      <Stack>
        <Card>
          <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            <StatTile
              label="Clicks"
              value={formatNumber(stats?.totalClicks ?? 0)}
              period="All time"
            />
            <StatTile
              label="Signups"
              value={formatNumber(stats?.totalSignups ?? 0)}
              period="All time"
            />
            <StatTile
              label="Conversion"
              value={formatPct(stats?.conversionPct ?? 0)}
              period="Signups per click"
            />
            <StatTile
              label="Active codes"
              value={formatNumber(activeCount)}
              period={`of ${formatNumber(profile?.maxActiveCodes ?? 0)} allowed`}
              tone={atCap ? 'warning' : 'neutral'}
            />
          </CardBody>
        </Card>

        {atCap ? (
          <Alert tone="warning" title="You are using all your active codes">
            Pause one before creating or reactivating another. Pausing does not lose the signups it
            has already brought in.
          </Alert>
        ) : null}

        <Card>
          <DataTable
            caption="Your referral codes and how each one has performed"
            columns={columns}
            rows={codes}
            rowKey={(row) => String(row.id)}
            rowLabel={(row) => row.code}
            defaultSort={{ key: 'signups', direction: 'desc' }}
            empty={
              <EmptyState
                icon={Handshake}
                title="No codes yet"
                description={`Create one and share its link. You keep up to ${formatPct(poolPct)} of what everyone who signs up through it pays.`}
                action={
                  <Button size="sm" onClick={() => setEditing('new')}>
                    Create your first code
                  </Button>
                }
              />
            }
          />
        </Card>

        {codes.length > 0 ? (
          <Card>
            <CardBody className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">Links to share</h2>
                <p className="mt-1 text-xs text-text-secondary">
                  A click on one of these is what attributes a signup to you. Paused codes still
                  resolve, but no longer earn.
                </p>
              </div>
              <ul className="space-y-2">
                {codes.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2">
                    <span className="figure w-32 shrink-0 truncate text-xs text-text-secondary">
                      {row.code}
                    </span>
                    <CopyField
                      className="min-w-0 flex-1"
                      label={`share link for ${row.code}`}
                      value={referralShareUrl(row.code, REFERRAL_BASE_URL)}
                    />
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
      </Stack>

      <CodeDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        code={editing === 'new' ? null : editing}
        poolPct={poolPct}
        onSaved={reload}
      />

      <ReferralsDrawer code={inspecting} onOpenChange={() => setInspecting(null)} />

      <ConfirmDialog
        open={pausing !== null}
        onOpenChange={(open) => {
          if (!open) setPausing(null);
        }}
        title={`Pause ${pausing?.code ?? 'this code'}?`}
        description="The link keeps resolving, but a signup through it is no longer attributed to you and earns nothing. Signups already attributed keep earning. You can reactivate it at any time, as long as you are under your active-code limit."
        confirmLabel="Pause code"
        onConfirm={async () => {
          if (pausing) await setActive.mutateAsync({ code: pausing, active: false });
        }}
      />
    </>
  );
}
