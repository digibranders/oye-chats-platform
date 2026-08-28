import {
  ABSENT,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Tooltip,
  formatNumber,
  type Column,
} from '../../../ui';
import {
  CREDIT_ACTIONS,
  formatCost,
  formatPeriod,
  type CreditAction,
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
 * spend. The distinction is a `Tooltip` on the cell, not a legend under the
 * card explaining the system's own documented absent value.
 *
 * This was a hand-built `<table>` at `px-5 py-2` heads and `px-5 py-2.5` cells
 * against `DataTable`'s `px-cell`, so the ledger table on the same screen
 * started its first column 4px further left than this one. It exists as
 * `DataTable` now that the table owns `Column.rowHeader` and a real `footer` —
 * the only two things this markup had that the system's table did not.
 */
export function CreditCosts({ costs, pool }: { costs: CreditCostsMap; pool: PoolCredit }) {
  const period = formatPeriod(pool.periodStart, pool.resetsAt);

  const columns: readonly Column<CreditAction>[] = [
    {
      key: 'action',
      header: 'Action',
      rowHeader: true,
      width: '13rem',
      render: (action) => <span className="font-medium text-text-primary">{action.label}</span>,
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      render: (action) => {
        const cost = formatCost(costs[action.key]);
        // The document row's floor is only half its price: uploads also charge
        // one credit per N words, so showing the floor alone tells a customer a
        // 10,000-word file costs three credits when it costs forty-three. The
        // rate comes from the same pricing key the deduction reads.
        const perWord =
          action.key === 'document_upload' && costs.documentUploadWordsPerCredit !== null
            ? costs.documentUploadWordsPerCredit
            : null;
        if (cost === null) {
          return (
            <Tooltip content="Your workspace's pricing does not declare this cost. That is not the same as free.">
              <span className="text-text-tertiary">{ABSENT}</span>
            </Tooltip>
          );
        }
        return (
          <span className="text-text-secondary">
            <span className="figure">{cost}</span>
            {perWord !== null ? (
              <span className="block text-2xs text-text-tertiary">
                plus <span className="figure">1</span> per{' '}
                <span className="figure">{formatNumber(perWord)}</span> words
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'used',
      header: 'Used',
      align: 'right',
      render: (action) => {
        const entry = pool.activity[action.bucket];
        return entry.eventCount > 0
          ? `${formatNumber(entry.eventCount)} ${action.unit}${entry.eventCount === 1 ? '' : 's'}`
          : ABSENT;
      },
    },
    {
      key: 'spent',
      header: 'Credits spent',
      type: 'number',
      render: (action) => {
        const entry = pool.activity[action.bucket];
        return entry.creditsUsed > 0 ? formatNumber(entry.creditsUsed) : ABSENT;
      },
    },
  ];

  return (
    <Card>
      <CardHeader eyebrow="Rates" title="What a credit buys" titleAs="h2" description={period} />
      <CardBody flush>
        <DataTable
          seated
          stickyHeader={false}
          // The row count is a fixed fact of the schema here, not a measurement:
          // this table lists the actions a credit can be spent on, and it has
          // exactly as many rows as `CREDIT_ACTIONS` has entries. "6 rows" under
          // a table that can never have a seventh is a number to read and then
          // discard.
          countSummary={false}
          caption={`Credit cost per action, and credits spent on each in ${period}`}
          columns={columns}
          rows={CREDIT_ACTIONS}
          rowKey={(action) => action.key}
          footer={
            <tr>
              <th scope="row" className="font-semibold">
                Total
              </th>
              <td />
              <td />
              <td className="figure text-right font-semibold">
                {formatNumber(pool.periodCreditsUsed)}
              </td>
            </tr>
          }
        />
      </CardBody>
    </Card>
  );
}
