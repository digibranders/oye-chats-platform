/**
 * The monthly operator ratings report: which months can be asked for, and the
 * CSV a manager takes away.
 *
 * Framework-free, so the parts that decide what lands in someone's appraisal
 * spreadsheet are tested without a DOM. The panel owns the button; this module
 * owns the file.
 */
import { csvField } from '../../lib/csvSafe';
import { csvFilename } from '../analytics/exportCsv';
import type { OperatorRating } from '../analytics/useAnalyticsData';

/** The month in progress plus a year back, enough for any appraisal cycle. */
const REPORT_MONTH_COUNT = 13;

export interface ReportMonth {
  /** `YYYY-MM`, the value the API takes. */
  value: string;
  label: string;
}

const MONTH_LABEL = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function monthValue(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The first of the month `back` months before `now`'s, in the reader's calendar. */
function monthStart(now: Date, back: number): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth() - back, 1));
}

/**
 * Selectable months, newest first, in the reader's own calendar.
 *
 * Includes the month in progress, labelled as such, because "how is this month
 * going" is a fair question; it is never the default, though (see
 * `defaultReportMonth`). Read from the reader's LOCAL date because the server
 * cuts the month in the reader's zone, and the two have to agree on which
 * month "this month" is.
 */
export function reportMonths(now: Date, count: number = REPORT_MONTH_COUNT): ReportMonth[] {
  return Array.from({ length: count }, (_, back) => {
    const start = monthStart(now, back);
    const label = MONTH_LABEL.format(start);
    return { value: monthValue(start), label: back === 0 ? `${label} (so far)` : label };
  });
}

/**
 * The last COMPLETE month. A report on the month in progress changes every
 * time it is downloaded, which is the wrong default for something people file.
 */
export function defaultReportMonth(now: Date): string {
  return monthValue(monthStart(now, 1));
}

export const OPERATOR_REPORT_HEADERS = [
  'Operator ID',
  'Operator',
  'Email',
  'Chats handled',
  'Chats rated',
  'Average rating',
  '5 star',
  '4 star',
  '3 star',
  '2 star',
  '1 star',
  'Unhappy (1-2 stars)',
] as const;

/**
 * The report as CSV text, one row per operator who handled a chat that month.
 *
 * `Operator ID` leads because neither of the next two columns identifies a
 * row: names repeat, and so can emails, when one person holds two seats. On
 * screen the list falls back to the seat id only for the rows that collide;
 * a spreadsheet gets sorted, filtered and looked up, so it gets the id always.
 *
 * `Average rating` is left blank, not zero, for an operator nobody rated: a 0
 * would sort them beneath someone who was actually rated one star. `Chats
 * rated` sits beside it, so the sample behind every average travels with it.
 * Every cell goes through `csvField`, because operator names are typed by
 * people and this file is opened in a spreadsheet.
 */
export function buildOperatorReportCsv(rows: readonly OperatorRating[]): string {
  const lines = rows.map((row) =>
    [
      row.operatorId,
      row.name,
      row.email ?? '',
      row.handled,
      row.total,
      row.average === null ? '' : row.average.toFixed(1),
      row.stars[5],
      row.stars[4],
      row.stars[3],
      row.stars[2],
      row.stars[1],
      row.unhappy,
    ]
      .map((value) => csvField(value))
      .join(','),
  );
  return [OPERATOR_REPORT_HEADERS.map((header) => csvField(header)).join(','), ...lines].join('\n');
}

/** `oyechats-operator-ratings-2026-08.csv`, so a downloads folder sorts by month. */
export function operatorReportFilename(month: string): string {
  return csvFilename('operator ratings', month);
}
