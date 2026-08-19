import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  DefinitionList,
  Field,
  Section,
  Select,
  Stack,
  formatNumber,
} from '../../ui';
import { platform } from '../client';
import { useUrlState } from '../usePlatform';
import { gstrFilename, gstrRowCount, monthLabel, recentMonths, toMonthKey } from './gstr';

/**
 * The GSTR-1 export.
 *
 * A compliance artefact, not a report: whatever comes out of here is what a
 * chartered accountant files, so three things are non-negotiable on this
 * screen.
 *
 * **The period is explicit.** GSTR-1 is filed per IST calendar month; the
 * server takes `YYYY-MM` and refuses anything else. So the month is picked from
 * real months spelled out in full, the current one is marked as still in
 * progress, and the month is repeated in the result and in the filename.
 *
 * **The download is honest.** The endpoint renders the CSV synchronously and
 * returns it in the response — nothing is queued, and there is no job to wait
 * for. The button says exactly that, and it reports how many document rows came
 * back, because a header-only file for a month with no invoices and a
 * header-only file from a misfired query look identical in a downloads folder.
 *
 * **Nothing is fabricated.** The rupee columns are the server's; the console
 * neither converts nor recomputes a single figure on the way through.
 */
export function GstrExportTab() {
  const url = useUrlState();
  const months = useMemo(() => recentMonths(), []);
  const currentMonth = months[0];
  const selected = months.includes(url.get('month')) ? url.get('month') : (months[1] ?? currentMonth);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ month: string; rows: number; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = months.map((month) => ({
    value: month,
    label: month === currentMonth ? `${monthLabel(month)} — still in progress` : monthLabel(month),
  }));

  async function download(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const csv = await platform.get<string>('/billing/gstr-export', { month: selected });
      const text = typeof csv === 'string' ? csv : String(csv);
      const rows = gstrRowCount(text);
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = gstrFilename(selected);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoked on the next tick rather than immediately: Safari cancels a
      // download whose object URL is released in the same frame as the click.
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
      setResult({ month: selected, rows, bytes: blob.size });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The export could not be generated.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      <Section
        title="GSTR-1 export"
        description="A document-level CSV for the accountant: B2B, B2CS, B2CL, EXP, CDNR and CDNUR sections, plus a per-section summary."
      >
        <Card>
          <CardHeader
            titleAs="h3"
            title="Choose the filing month"
            description="One IST calendar month per file. The server rejects anything that is not a whole month."
          />
          <CardBody className="max-w-md">
            <Field
              label="Filing month"
              hint={
                selected === currentMonth
                  ? 'This month is not over. The file will contain only what has been invoiced so far — useful as a draft, not for filing.'
                  : `Documents issued in ${monthLabel(selected)}, by their supply date.`
              }
            >
              <Select
                options={options}
                value={selected}
                onChange={(event) => {
                  url.set({ month: event.target.value });
                  setResult(null);
                  setError(null);
                }}
              />
            </Field>
          </CardBody>
          <CardBody className="border-t border-border">
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void download()}
              iconLeft={<Download aria-hidden className="h-4 w-4" />}
            >
              Generate and download {monthLabel(selected)}
            </Button>
            <p className="mt-2 text-xs text-text-secondary">
              The file is built when you press this and arrives in the response — nothing is queued,
              and there is nothing to come back for. Large months take a few seconds.
            </p>
          </CardBody>
        </Card>
      </Section>

      {error ? (
        <Alert tone="danger" live title="The export was not generated">
          {error} Nothing was downloaded.
        </Alert>
      ) : null}

      {result ? (
        <Alert
          tone={result.rows === 0 ? 'warning' : 'success'}
          live
          title={
            result.rows === 0
              ? `${monthLabel(result.month)} has no documents`
              : `${gstrFilename(result.month)} downloaded`
          }
        >
          {result.rows === 0 ? (
            <>
              The file downloaded, but it contains only the header and a summary of zeroes — no tax
              invoice, credit note or receipt was issued in {monthLabel(result.month)}. Do not file
              it as though it were a return with content until you have confirmed that is correct.
            </>
          ) : (
            <>
              {formatNumber(result.rows)} document row{result.rows === 1 ? '' : 's'}, plus the
              per-section summary. Check your browser&rsquo;s downloads for{' '}
              <span className="figure">{gstrFilename(result.month)}</span>.
            </>
          )}
        </Alert>
      ) : null}

      <Section title="What is in the file">
        <Card>
          <CardBody>
            <DefinitionList
              columns={2}
              items={[
                {
                  label: 'Denomination',
                  value:
                    'Rupees, to two decimals. The API works in minor units everywhere else; the return does not.',
                },
                {
                  label: 'Document currency',
                  value:
                    'Carried separately in doc_currency, doc_gross_value, doc_taxable_value and doc_total_tax — what the customer actually holds, alongside the rupee figures that go on the return.',
                },
                {
                  label: 'FX',
                  value:
                    'fx_rate is the Rule 34(2) rate at the time of supply, stored on the document. It is not recomputed at export time.',
                },
                {
                  label: 'Blank cells',
                  value:
                    'A blank money column means the figure could not be derived, not zero. A zero-value supply prints 0.00.',
                },
                {
                  label: 'Encoding',
                  value: 'UTF-8 with a byte-order mark, so Excel opens non-ASCII legal names correctly.',
                },
                {
                  label: 'Period basis',
                  value: `IST calendar month. Today is in ${monthLabel(toMonthKey(new Date()))}.`,
                },
              ]}
            />
          </CardBody>
        </Card>
      </Section>
    </Stack>
  );
}
