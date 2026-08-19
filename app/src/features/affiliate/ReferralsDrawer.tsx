import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import {
  DefinitionList,
  Drawer,
  EmptyState,
  ErrorState,
  FigureRow,
  LoadingRows,
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
            <DefinitionList
              columns={2}
              items={[
                {
                  label: 'You earn',
                  value: <span className="figure">{formatPct(detail.breakdown.affiliatePct)}</span>,
                },
                {
                  label: 'They save',
                  value: (
                    <span className="figure">{formatPct(detail.breakdown.customerDiscountPct)}</span>
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
                <span className="ml-1.5 text-xs font-normal text-text-tertiary">
                  {formatNumber(paying)} paying {paying === 1 ? 'referral' : 'referrals'}
                </span>
              </h3>
              {/* A real `dl`: `FigureRow` emits `dt`/`dd`, and a screen reader
                  only pairs them with each other inside a description list. */}
              <dl className="rounded-md border border-border px-3 py-1">
                <FigureRow label="Total billed" value={formatInrMinor(distribution.monthlyTotalMinor)} />
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
              </dl>
              <p className="mt-2 text-xs text-text-secondary">
                Estimated at today's plan prices. Annual plans are shown as their monthly
                equivalent, so this is a run rate rather than an amount already earned.
              </p>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-base font-semibold text-text-primary">
              Signed up
              <span className="ml-1.5 text-xs font-normal text-text-tertiary">
                {formatNumber(detail.referrals.length)}
              </span>
            </h3>
            {detail.referrals.length === 0 ? (
              <EmptyState
                compact
                icon={Users}
                title="Nobody yet"
                description="Share this code's link. Anyone who subscribes after clicking it appears here."
              />
            ) : (
              <>
                <ul className="overflow-hidden rounded-md border border-border">
                  {detail.referrals.map((customer) => (
                    <li
                      key={customer.clientId}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2.5 first:border-t-0"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {customer.name ?? 'A customer'}
                        </p>
                        <p className="figure truncate text-xs text-text-secondary">
                          {customer.email ?? '—'}
                        </p>
                      </div>
                      <span className="text-xs text-text-tertiary">
                        {customer.planSlug || 'No plan'} · {formatDate(customer.attributedAt)}
                      </span>
                      <span className="figure w-24 text-right text-sm text-success">
                        {formatInrMinor(customer.affiliateEarnsMinor)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-text-secondary">
                  Email addresses are partly hidden on purpose — we tell you who converted without
                  handing over their contact details.
                </p>
              </>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
