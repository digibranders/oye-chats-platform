import { type ReactNode } from 'react';

/**
 * One division of the lead record.
 *
 * A heading and a hairline, and no box. The panel this replaces invented "a
 * bordered box" inline eleven times across four files — `rounded-lg` with
 * `px-4 py-3.5` in one place and `rounded-md` with `px-3.5 py-3` in the other
 * ten, where 14px is not on the base-4 scale at all. Every one of them was an
 * 8px-radius panel sitting 20px inside a drawer that has no radius, which is the
 * "card corners against their container edges" defect, twelve times down one
 * scroll.
 *
 * Inside a drawer a section does not need a surface: the drawer *is* the
 * surface. So this draws the two things a section actually owes the reader — a
 * name, and a rule separating it from the one above.
 *
 * The heading is `text-base`, not the `text-lg` these all used. `text-lg` is the
 * rung `Drawer.Title` sits on, so seven sections and the record's own name were
 * all set at one size and weight: seven peers, one of which happened to be the
 * thing the panel was about.
 *
 * It is a layout helper for one feature's record panel, not a visual primitive:
 * it declares no colour, no radius, no padding and no surface of its own. A
 * genuinely boxed sub-panel would be `Panel` in `src/ui/layout/`, and there is
 * not one.
 */
export function LeadSection({
  title,
  actions,
  children,
}: {
  title: string;
  /** A badge or a control belonging to the section, on the heading's baseline. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-text-primary">{title}</h3>
        {actions}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}
