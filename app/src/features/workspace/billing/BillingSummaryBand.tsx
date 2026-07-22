import { type ReactElement, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Button, Card, CardContent, StatusBadge } from '../../../design-system';
import { humanizeStatus, statusTone } from '../billingModel';

interface Stat {
  label: string;
  value: ReactNode;
}

export interface BillingSummaryBandProps {
  planName: string;
  /** Raw subscription status — the band derives the badge tone + label. */
  status: string;
  costLabel: string;
  seats: number;
  renewalCaption: string;
  renewalLabel: string;
  paymentLabel: string;
  isPaid: boolean;
  onChangePlan: () => void;
}

/**
 * BillingSummaryBand — the single account-wide "what am I paying" summary that
 * replaces the old four MetricCards *and* the three stat cards below them (the
 * same facts were rendered up to three times). Every fact now appears exactly
 * once, in one horizontal band, with the primary plan action on the trailing
 * edge.
 */
export function BillingSummaryBand({
  planName,
  status,
  costLabel,
  seats,
  renewalCaption,
  renewalLabel,
  paymentLabel,
  isPaid,
  onChangePlan,
}: BillingSummaryBandProps): ReactElement {
  const stats: Stat[] = [
    {
      label: 'Current plan',
      value: (
        <span className="flex items-center gap-2">
          <span className="text-[17px] font-bold tracking-tight text-[var(--ds-text)]">{planName}</span>
          <StatusBadge tone={statusTone(status)}>{humanizeStatus(status)}</StatusBadge>
        </span>
      ),
    },
    { label: 'Cost', value: costLabel },
    { label: 'Operator seats', value: seats },
    { label: renewalCaption, value: renewalLabel },
    { label: 'Payment method', value: paymentLabel },
  ];

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-5 lg:flex-row lg:items-center lg:justify-between">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3 lg:flex lg:flex-wrap lg:items-center lg:gap-x-10">
          {stats.map((stat) => (
            <div key={stat.label} className="min-w-0">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
                {stat.label}
              </dt>
              <dd className="mt-1 text-[15px] font-semibold text-[var(--ds-text)]">{stat.value}</dd>
            </div>
          ))}
        </dl>
        <div className="shrink-0">
          <Button onClick={onChangePlan}>
            <ArrowUpRight size={16} aria-hidden="true" />
            {isPaid ? 'Change plan' : 'Choose a plan'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
