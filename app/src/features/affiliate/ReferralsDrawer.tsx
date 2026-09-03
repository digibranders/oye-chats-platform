import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import {
  ABSENT,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  FigureList,
  FigureRow,
  LoadingRows,
  PropertyGrid,
  formatDate,
  formatNumber,
} from '../../ui';
import { getAffiliateCodeReferrals } from '../../services/api';
import { keys } from '../../query/keys';
import {
  formatInrMinor,
  formatPct,
  toReferralDetail,
  type AffiliateCodeView,
} from './affiliateModel';

export interface ReferralsDrawerProps {
  code: AffiliateCodeView | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Who signed up through one code, and what each of them is worth.
 *
 * A drawer rather than a modal: it is a record list you read against the codes
 * table, and closing it should put the reader back on the row they came from
 * rather than at the top of a re-laid-out page.
 *
 * Emails are masked by the server on the affiliate route. That is deliberate —
 * an affiliate is told they referred someone without being handed that person's
 * contact details — and the drawer says so, so a masked address does not read
 * as a bug.
 */
export function ReferralsDrawer({ code, onOpenChange }: ReferralsDrawerProps) {
  const referrals = useQuery({
    queryKey: keys.affiliate.referrals(code?.id ?? 0),
    queryFn: async () => toReferralDetail(await getAffiliateCodeReferrals(code!.id)),
    enabled: code !== null,
    staleTime: 60_000,
  });

  const detail = referrals.data ?? null;
  const distribution = detail?.distribution;
  const paying = distribution?.payingReferrals ?? 0;

  return (
    <Drawer
      open={code !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
      width="lg"
      title={code ? `Referrals for ${code.code}` : 'Referrals'}
      description="Who signed up through this code, and what each one earns you."
    >
      {referrals.isPending ? (
        <LoadingRows rows={5} />
      ) : referrals.isError ? (
        <ErrorState
          title="We could not load these referrals"
          description={referrals.error instanceof Error ? referrals.error.message : undefined}
          onRetry={() => void referrals.refetch()}
        />
      ) : detail ? (
        <div className="space-y-6">
          <section>
            <h3 className="mb-2 text-base font-semibold text-text-primary">How each bill splits</h3>
            {/* One geometry for the drawer's three lists. This was a stacked
                `DefinitionList`, a bordered `dl` and a bordered `ul` — three
                paddings and two `--color-border` container boxes inside a
                480px pane. */}
            <PropertyGrid
              columns={2}
              label="How each bill splits"
              items={[
                {
                  label: 'You earn',
                  value: <span className="figure">{formatPct(detail.breakdown.affiliatePct)}</span>,
                },
                {
                  label: 'They save',
                  value: (
                    <span className="figure">
                      {formatPct(detail.breakdown.customerDiscountPct)}
                    </span>
                  ),
                },
                {
                  label: 'Your pool',
                  value: <span className="figure">{formatPct(detail.breakdown.poolPct)}</span>,
                },
                {
                  label: 'Unused',
                  value: (
                    <span className="figure">{formatPct(detail.breakdown.codeUnusedPoolPct)}</span>
                  ),
                },
              ]}
            />
          </section>

          {paying > 0 && distribution ? (
            <section>
              <h3 className="mb-2 text-base font-semibold text-text-primary">
                Monthly run rate
                <span className="ms-1.5 text-xs font-normal text-text-tertiary">
                  {formatNumber(paying)} paying {paying === 1 ? 'referral' : 'referrals'}
                </span>
              </h3>
              {/* A real `dl`: `FigureRow` emits `dt`/`dd`, and a screen reader
                  only pairs them with each other inside a description list. */}
              <FigureList>
                <FigureRow
                  label="Total billed"
                  value={formatInrMinor(distribution.monthlyTotalMinor)}
                />
                <FigureRow
                  label="You earn"
                  value={formatInrMinor(distribution.monthlyAffiliateMinor)}
                  emphasis
                  tone="success"
                />
                <FigureRow
                  label="They save"
                  value={formatInrMinor(distribution.monthlyCustomerSavedMinor)}
                />
              </FigureList>
              <p className="mt-2 text-xs text-text-secondary">A run rate at today's prices.</p>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-base font-semibold text-text-primary">
              Signed up
              <span className="ms-1.5 text-xs font-normal text-text-tertiary">
                {formatNumber(detail.referrals.length)}
              </span>
            </h3>
            {detail.referrals.length === 0 ? (
              <EmptyState
                size="panel"
                icon={Users}
                title="Nobody yet"
                description="Anyone who subscribes after clicking this code's link appears here."
              />
            ) : (
              <>
                <DataTable
                  caption={`Customers who signed up through ${code?.code ?? 'this code'}`}
                  rows={detail.referrals}
                  rowKey={(customer) => String(customer.clientId)}
                  rowNoun="referral"
                  stickyHeader={false}
                  defaultSort={{ key: 'earns', direction: 'desc' }}
                  columns={[
                    {
                      key: 'customer',
                      header: 'Customer',
                      rowHeader: true,
                      width: '12rem',
                      sortable: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
                      render: (customer) => (
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium text-text-primary">
                            {customer.name ?? 'A customer'}
                          </span>
                          <span className="figure truncate text-xs text-text-secondary">
                            {customer.email ?? ABSENT}
                          </span>
                        </span>
                      ),
                    },
                    {
                      key: 'plan',
                      header: 'Plan',
                      secondary: true,
                      render: (customer) => (
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-text-secondary">
                            {customer.planSlug || ABSENT}
                          </span>
                          <span className="figure truncate text-xs text-text-tertiary">
                            {formatDate(customer.attributedAt)}
                          </span>
                        </span>
                      ),
                    },
                    {
                      key: 'earns',
                      header: 'You earn',
                      type: 'number',
                      sortable: (a, b) => a.affiliateEarnsMinor - b.affiliateEarnsMinor,
                      render: (customer) => (
                        <span className="text-success">
                          {formatInrMinor(customer.affiliateEarnsMinor)}
                        </span>
                      ),
                    },
                  ]}
                />
                <p className="mt-2 text-xs text-text-secondary">
                  Addresses are partly hidden on purpose.
                </p>
              </>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
