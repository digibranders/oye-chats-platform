import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Handshake, MoreHorizontal, Pause, Pencil, Play, Plus, Users } from 'lucide-react';
import {
  ABSENT,
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
  Meter,
  Tooltip,
  Stack,
  Toolbar,
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
  // `maxActiveCodes > 0` guards the zero case: with no cap on record, `0 >= 0`
  // put "You are using all your active codes" above an empty table.
  const atCap =
    profile != null && profile.maxActiveCodes > 0 && activeCount >= profile.maxActiveCodes;

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

  if (loading) {
    return (
      <Card>
        <CardBody>
          <LoadingRows rows={4} />
        </CardBody>
      </Card>
    );
  }

  // Not an error: the programme is invite-only, so this is simply the answer.
  if (notEnrolled) {
    return (
      <Card>
        <EmptyState
          icon={Handshake}
          title="You are not in the partner programme"
          description="Partners is invite-only. Ask your OyeChats contact for an invitation."
        />
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <ErrorState
          title="We could not load your affiliate dashboard"
          description={error}
          onRetry={reload}
        />
      </Card>
    );
  }

  const columns: Column<AffiliateCodeView>[] = [
    {
      key: 'code',
      header: 'Code',
      width: '11rem',
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
      width: '7rem',
      render: (row) =>
        row.active ? (
          <Badge tone="success" dot>
            Active
          </Badge>
        ) : (
          <Tooltip content="The link still resolves, but a signup through it no longer earns.">
            <Badge tone="neutral" dot>
              Paused
            </Badge>
          </Tooltip>
        ),
    },
    {
      key: 'split',
      header: 'Split',
      secondary: true,
      width: '9.5rem',
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
      type: 'number',
      width: '5.5rem',
      sortable: (a, b) => a.clicks - b.clicks,
      render: (row) => formatNumber(row.clicks),
    },
    {
      key: 'signups',
      header: 'Signups',
      type: 'number',
      width: '6rem',
      sortable: (a, b) => a.signups - b.signups,
      render: (row) => formatNumber(row.signups),
    },
    {
      // The comparison the affiliate is actually making. It was on the stat row
      // as an all-time aggregate and nowhere per row, which is the only place
      // it answers a question.
      key: 'conversion',
      header: 'Conversion',
      type: 'number',
      width: '7rem',
      // Unknown sorts below every real rate rather than tying with 0%, so a
      // batch of untouched codes does not sit among the worst performers.
      sortable: (a, b) => (a.conversionPct ?? -1) - (b.conversionPct ?? -1),
      render: (row) =>
        row.conversionPct === null ? (
          <span>
            <span aria-hidden>{ABSENT}</span>
            <span className="sr-only">No data yet</span>
          </span>
        ) : (
          formatPct(row.conversionPct)
        ),
    },
    {
      // The list used to be printed twice on this page: once as this table and
      // again 400px below as a "Links to share" list, so eight codes appeared
      // sixteen times.
      key: 'link',
      header: 'Share link',
      render: (row) => (
        <CopyField
          compact
          label={`share link for ${row.code}`}
          value={referralShareUrl(row.code, REFERRAL_BASE_URL)}
        />
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '3rem',
      render: (row) => (
        <MenuRoot>
          <MenuTrigger
            aria-label={`Actions for ${row.code}`}
            className={buttonClass('ghost', 'icon-sm')}
          >
            <MoreHorizontal aria-hidden />
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={<Users aria-hidden />} onSelect={() => setInspecting(row)}>
              See referrals
            </MenuItem>
            <MenuItem icon={<Pencil aria-hidden />} onSelect={() => setEditing(row)}>
              Edit code
            </MenuItem>
            {row.active ? (
              <MenuItem icon={<Pause aria-hidden />} onSelect={() => setPausing(row)}>
                Pause code
              </MenuItem>
            ) : (
              <MenuItem
                icon={<Play aria-hidden />}
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
      <Stack>
        {/* Active codes is the constraint the New-code button runs into, so it
            stands beside it. Clicks, Signups and Conversion were three stat
            tiles summing three columns of the table below; they are the
            table's `tfoot` now. */}
        <Toolbar className="justify-between gap-4 border-y border-border py-3">
          <Meter
            className="w-64"
            label="Active codes"
            used={activeCount}
            limit={profile?.maxActiveCodes ?? 0}
            unit="codes"
          />
          <Button
            size="sm"
            onClick={() => setEditing('new')}
            disabled={atCap}
            iconLeft={<Plus aria-hidden />}
          >
            New code
          </Button>
        </Toolbar>

        {atCap ? (
          <Alert tone="warning" title="You are using all your active codes">
            Pause one before creating or reactivating another. Pausing keeps the signups it has
            already brought in.
          </Alert>
        ) : null}

        <DataTable
          // `fit`. Eight columns at their natural widths came to 1,033px inside
          // the settings content column, which is 902 — so the share link was
          // sliced through mid-URL at the card's right edge and the row menu,
          // the only way to edit or pause a code, was off the card entirely,
          // behind a scrollbar the card never drew. Every column but the link
          // declares the width it must not give up; the link is the one that
          // gives, and it truncates its own URL and keeps its copy button,
          // which is the part of it anybody uses.
          fit
          caption="Your referral codes and how each one has performed"
          columns={columns}
          rows={codes}
          rowKey={(row) => String(row.id)}
          rowLabel={(row) => row.code}
          rowNoun="code"
          defaultSort={{ key: 'signups', direction: 'desc' }}
          footer={
            codes.length > 0 ? (
              <tr>
                <th scope="row" className="font-semibold">
                  All codes
                </th>
                <td />
                <td />
                <td className="figure text-right font-semibold">
                  {formatNumber(stats?.totalClicks ?? 0)}
                </td>
                <td className="figure text-right font-semibold">
                  {formatNumber(stats?.totalSignups ?? 0)}
                </td>
                {/* The all-codes rate is `null` until something is clicked.
                    `?? 0` printed "0% conversion" for an affiliate who had not
                    started yet, which reads as a result rather than as silence. */}
                <td className="figure text-right font-semibold">
                  {stats?.conversionPct == null ? (
                    <>
                      <span aria-hidden>{ABSENT}</span>
                      <span className="sr-only">No data yet</span>
                    </>
                  ) : (
                    formatPct(stats.conversionPct)
                  )}
                </td>
                <td />
                <td />
              </tr>
            ) : undefined
          }
          empty={
            <EmptyState
              size="inline"
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
        description="The link keeps working but new signups stop earning. Existing referrals are unaffected. You can reactivate it while under your limit."
        confirmLabel="Pause code"
        onConfirm={async () => {
          if (pausing) await setActive.mutateAsync({ code: pausing, active: false });
        }}
      />
    </>
  );
}
