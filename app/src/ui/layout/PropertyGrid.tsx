import { type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../lib/cn';
import { ABSENT } from '../lib/formatters';
import { Tooltip } from '../overlays/Tooltip';

export interface PropertyItem {
  /** The fact's name. One or two words. Never a sentence, never a question. */
  label: string;
  /** `undefined`, `null` and `''` all render as `—`. Never a blank cell. */
  value?: ReactNode;
  /** A copy control, an edit link, a badge. Sits at the row's right edge. */
  action?: ReactNode;
  /** A tooltip on the label. Never a second line of prose under it. */
  note?: string;
}

export interface PropertyGridProps {
  items: readonly PropertyItem[];
  /**
   * `rows` is label-left / value-right with a hairline between — the default,
   * and the shape this component exists for. `stacked` puts the label above its
   * value, which is right only in a column too narrow to hold both.
   */
  layout?: 'rows' | 'stacked';
  /** Two columns of facts, when the container is wide enough to hold them. */
  columns?: 1 | 2;
  /**
   * `default` follows the page's density. `compact` is 32px rows regardless —
   * for a drawer or an inspector pane, where the facts are the whole content.
   */
  density?: 'default' | 'compact';
  /**
   * Names the block of facts, e.g. "Invoice details".
   *
   * It lands on a wrapping `role="group"`, not on the `dl`. `aria-label` on a
   * bare `dl` is ignored — the element has no role that supports a name — so
   * naming it there looks right in the diff and does nothing in the browser.
   * Omit it when a `CardHeader` or `PaneHeader` above already says what these
   * facts are about.
   */
  label?: string;
  className?: string;
}

/**
 * A record, as facts.
 *
 * The densest fact display in the system, and the one five separate reviewers
 * asked for by name. Roughly twenty-two surfaces were describing a record in
 * prose or stacking each label above its own value — eleven visitor fields cost
 * about 600px that way, in a 320px pane, with the URLs `break-all`-ed into six
 * shredded lines. Stripe's payment details and Linear's issue properties are
 * both exactly this shape, and neither ever stacks a label above its value.
 *
 * Three contracts it keeps:
 *
 * **Every absent value is `—`** (DESIGN.md rule 11), never `0`, never a blank
 * cell. A blank cell is indistinguishable from a rendering failure, and `0` is a
 * measurement that was taken.
 *
 * **It re-declares `@container/page` on its own root**, so `columns={2}` — and
 * the label column itself — ask about the width of *this grid*, not the page,
 * and not a card that happened to opt into a container. The two-column form of
 * its predecessor broke at the `sm` viewport breakpoint, which is why an inbox
 * pane 320px wide went two-up on a 1920px screen.
 *
 * **`rows` falls back to stacked below 24rem of container.** The label column
 * was `minmax(7rem,10rem)` at every width, so in an 18rem aside — about 248px
 * of usable grid — a 112px label left 120px for the value, and "First seen /
 * 2 Jun 2026, 10:00" wrapped onto three lines while "https://acme.com" broke
 * mid-word. Stacking is what `layout="stacked"` was already documented as: the
 * shape that is right "only in a column too narrow to hold both". Which columns
 * those are is a fact about the container, so it is a container query rather
 * than a prop the call site has to keep in sync with its own layout — the aside
 * on Deploy passes no prop and gets the right shape at both widths.
 *
 * **It draws no horizontal padding.** The container provides the gutter, which
 * is how a `PropertyGrid` in a `CardBody` lines up with the `CardHeader` above
 * it, and how one seated in a `CardBody flush` can be given the gutter it needs.
 */
export function PropertyGrid({
  items,
  layout = 'rows',
  columns = 1,
  density = 'default',
  label,
  className,
}: PropertyGridProps) {
  const compact = density === 'compact';

  return (
    <div
      role={label ? 'group' : undefined}
      aria-label={label}
      className={cn('@container/page', className)}
    >
      <dl
        className={cn(
          'grid',
          '[&>*:first-child]:border-t-0',
          columns === 2 &&
            '@lg/page:grid-cols-2 @lg/page:gap-x-8 @lg/page:[&>*:nth-child(2)]:border-t-0',
        )}
      >
        {items.map((item, index) => (
          <Row key={`${item.label}-${index}`} item={item} layout={layout} compact={compact} />
        ))}
      </dl>
    </div>
  );
}

function Row({
  item,
  layout,
  compact,
}: {
  item: PropertyItem;
  layout: 'rows' | 'stacked';
  compact: boolean;
}) {
  const absent = item.value === undefined || item.value === null || item.value === '';
  const value = absent ? <span className="text-text-tertiary">{ABSENT}</span> : item.value;

  const name = (
    <dt className="flex min-w-0 items-center gap-1 text-xs text-text-secondary">
      <span className="min-w-0 truncate">{item.label}</span>
      {item.note ? (
        <Tooltip content={item.note}>
          {/* 24px target around a 14px glyph: SC 2.5.8 applies to a control in a
              dense row exactly as much as it does to a button on a toolbar. */}
          <button
            type="button"
            aria-label={`About ${item.label}`}
            className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-text-tertiary hover:text-text-primary"
          >
            <Info aria-hidden className="h-icon-sm w-icon-sm" />
          </button>
        </Tooltip>
      ) : null}
    </dt>
  );

  if (layout === 'stacked') {
    return (
      <div
        className={cn(
          'min-w-0 border-t border-border',
          compact ? 'py-1.5' : 'py-[var(--cell-y)]',
        )}
      >
        {name}
        <dd className="mt-0.5 flex min-w-0 items-start justify-between gap-2 break-words text-sm text-text-primary">
          <span className="min-w-0">{value}</span>
          {item.action ? <span className="shrink-0">{item.action}</span> : null}
        </dd>
      </div>
    );
  }

  return (
    // Stacked is the base and the two-column row is the enhancement, so the
    // narrow case needs no query to be correct. 24rem is where a 7rem label, a
    // 1rem gutter and a value long enough to be worth a row — a timestamp, a
    // URL, an email — stop competing for the same 250px.
    <div
      className={cn(
        'grid grid-cols-[minmax(0,1fr)] border-t border-border',
        '@sm/page:items-baseline @sm/page:gap-x-4',
        compact
          ? // `compact` is the inspector density, and an inspector is narrow by
            // definition: a 10rem label track in a 288px pane leaves 71px for
            // the value, which broke `amara@example.com` as `amara@ex /
            // ample.com`. The names in an inspector are short — "Email",
            // "First seen" — so the track can be.
            'py-1.5 @sm/page:min-h-8 @sm/page:grid-cols-[minmax(4.5rem,8rem)_minmax(0,1fr)]'
          : 'py-[var(--cell-y)] @sm/page:min-h-[var(--row-h)] @sm/page:grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)]',
      )}
    >
      {name}
      {/* The action rides inside the `dd` rather than in a third grid column:
          `dl > div` may hold `dt` and `dd` and nothing else, and an auto column
          that is empty on most rows still charges every row its `gap-x`. */}
      <dd
        className={cn(
          'mt-0.5 flex min-w-0 items-baseline justify-between gap-2 text-sm text-text-primary',
          '@sm/page:mt-0',
        )}
      >
        <span className="min-w-0 break-words">{value}</span>
        {item.action ? <span className="shrink-0 self-center">{item.action}</span> : null}
      </dd>
    </div>
  );
}
