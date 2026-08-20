import { ABSENT, Card, CardBody, CardHeader, formatNumber } from '../../../ui';
import {
  CREDIT_ACTIONS,
  formatCost,
  formatPeriod,
  type CreditCosts as CreditCostsMap,
  type PoolCredit,
} from '../usage-model';

/**
 * What a credit buys, and what this period actually spent on each thing.
 *
 * The costs are read from `GET /credits/balance`, which serves them out of
 * `pricing_config`. They used to be hard-coded in the UI - "1 AI chat = 1
 * credit" written into a component - while a super-admin could retune any of
 * them from the platform console. A customer reading a stale cost is being
 * told something untrue about money, so the numbers now come from the same
 * place the deduction does.
 *
 * A cost the payload does not carry renders as an em dash. It is not zero: an
 * action can charge and still be missing from the map, and "free" is the one
 * wrong answer that would cost the customer credits they did not expect to
 * spend.
 */
export function CreditCosts({ costs, pool }: { costs: CreditCostsMap; pool: PoolCredit }) {
  const period = formatPeriod(pool.periodStart, pool.resetsAt);

  return (
    <Card>
      <CardHeader
        eyebrow="Rates"
        title="What a credit buys"
        titleAs="h2"
        description="Live rates from your workspace's pricing, not a printed price list. Usage covers the current allowance period."
      />
      <CardBody flush>
        <table className="w-full">
          <caption className="sr-only">
            Credit cost per action, and credits spent on each in {period}
          </caption>
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th scope="col" className="px-5 py-2 text-left font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
                Action
              </th>
              <th scope="col" className="px-5 py-2 text-right font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
                Cost
              </th>
              <th scope="col" className="px-5 py-2 text-right font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
                Used
              </th>
              <th scope="col" className="px-5 py-2 text-right font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
                Credits spent
              </th>
            </tr>
          </thead>
          <tbody>
            {CREDIT_ACTIONS.map((action) => {
              const entry = pool.activity[action.bucket];
              const cost = formatCost(costs[action.key]);
              // The document row's floor is only half its price: uploads also
              // charge one credit per N words, so showing the floor alone tells
              // a customer a 10,000-word file costs three credits when it costs
              // forty-three. The rate comes from the same pricing key the
              // deduction reads.
              const perWord =
                action.key === 'document_upload' && costs.documentUploadWordsPerCredit !== null
                  ? costs.documentUploadWordsPerCredit
                  : null;
              return (
                <tr key={action.key} className="border-b border-border last:border-b-0">
                  <th scope="row" className="px-5 py-2.5 text-left text-sm font-medium text-text-primary">
                    {action.label}
                  </th>
                  <td className="px-5 py-2.5 text-right text-sm text-text-secondary">
                    <span className="figure">{cost ?? ABSENT}</span>
                    {perWord !== null ? (
                      <span className="block text-2xs text-text-tertiary">
                        plus <span className="figure">1</span> credit per{' '}
                        <span className="figure">{formatNumber(perWord)}</span> words
                      </span>
                    ) : null}
                  </td>
                  <td className="figure px-5 py-2.5 text-right text-sm text-text-secondary">
                    {entry.eventCount > 0
                      ? `${formatNumber(entry.eventCount)} ${action.unit}${entry.eventCount === 1 ? '' : 's'}`
                      : ABSENT}
                  </td>
                  <td className="figure px-5 py-2.5 text-right text-sm font-medium text-text-primary">
                    {entry.creditsUsed > 0 ? formatNumber(entry.creditsUsed) : ABSENT}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-surface-sunken">
              <th scope="row" className="px-5 py-2.5 text-left text-sm font-semibold text-text-primary">
                Total
              </th>
              <td />
              <td />
              <td className="figure px-5 py-2.5 text-right text-sm font-semibold text-text-primary">
                {formatNumber(pool.periodCreditsUsed)}
              </td>
            </tr>
          </tfoot>
        </table>
      </CardBody>
      <div className="border-t border-border px-5 py-3 text-xs text-text-secondary">
        {period}. A cost shown as {ABSENT} is one your workspace's pricing does not currently
        declare, which is not the same as free.
      </div>
    </Card>
  );
}
