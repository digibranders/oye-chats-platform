import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * `form` is the measure at which a label and its control stay on one line and
 * the eye still binds them. `reading` is long-form help or a changelog. `full`
 * opts out, for a column that only exists to re-declare the container.
 */
export type MeasureWidth = 'form' | 'reading' | 'full';

const WIDTHS: Record<MeasureWidth, string> = {
  form: 'max-w-form',
  reading: 'max-w-reading',
  full: 'max-w-none',
};

export interface MeasureProps {
  children: ReactNode;
  width?: MeasureWidth;
  className?: string;
}

/**
 * A reading measure inside a full-width page.
 *
 * Named `Measure`, not `Column`: `Column` is already the `DataTable` column
 * descriptor, and in a console that is what the word means to anyone reading a
 * call site. `Measure` is the typographic term for it anyway.
 *
 * `Page width="default"` used to do this job by making the whole page 896px and
 * `mx-auto`, which meant the page box itself moved: navigating from a wide page
 * to a settings page slid the title, the tab row and every card 148px to the
 * right at 1440 and 388px at 1920. A narrow measure is a property of the
 * *content*, not of the page, so it lives here — and it is **never `mx-auto`**.
 * The page keeps one left edge at every route; the form gets its 672px.
 *
 * 896 was also the wrong number for a form. It is too wide to read a label
 * against its control and too narrow to hold data — it is precisely the width
 * that produces a magazine column, which is what the whole rebuild is escaping.
 *
 * It re-declares `@container/page`, so a `Grid` or a `PropertyGrid` inside a
 * 672px form measures 672 rather than the page it sits on.
 */
export function Measure({ children, width = 'form', className }: MeasureProps) {
  return (
    <div className={cn('@container/page w-full min-w-0', WIDTHS[width], className)}>{children}</div>
  );
}
