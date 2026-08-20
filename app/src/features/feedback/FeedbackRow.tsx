import {
  Badge,
  Button,
  Disclosure,
  EYEBROW_CLASS,
  cn,
  formatDateTime,
  useClipboard,
} from '../../ui';
import { type FeedbackItem } from './types';

/** A generated visitor handle ("User -3", "anon_8f21") rather than a name. */
const IDENTIFIER = /^(user|visitor|anon)[\s_-]/i;

export interface FeedbackRowProps {
  item: FeedbackItem;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * One rated answer, expandable to the full exchange.
 *
 * The row it replaces was a card in a stack of cards, each with its own
 * hairline and its own hover shadow, so a hundred ratings read as a hundred
 * objects rather than one list — and the rating itself was a coloured thumb
 * glyph and nothing else, which tells a reader who cannot separate the green
 * from the red exactly nothing. The verdict is now a `Badge`, which always
 * carries its word.
 *
 * The disclosure comes from the design system, wrapped in a heading so a log of
 * a hundred ratings is navigable by heading — which is the whole reason the
 * rows are collapsed in the first place.
 */
export function FeedbackRow({ item, expanded, onToggle }: FeedbackRowProps) {
  const positive = item.feedback === 1;
  const { state, copy } = useClipboard();

  function copyIssue() {
    void copy(
      [
        'Issue: unhelpful chatbot answer',
        '',
        `Question: ${item.question}`,
        '',
        `Answer: ${item.answer}`,
        '',
        `Rated: not helpful, ${formatDateTime(item.created_at)}`,
      ].join('\n'),
    );
  }

  return (
    <li data-feedback-id={item.message_id} className="border-t border-border first:border-t-0">
      <Disclosure
        headingLevel={3}
        open={expanded}
        onOpenChange={onToggle}
        regionLabel={`Full exchange: ${item.question}`}
        className="px-cell py-1"
        panelClassName="pb-3 pr-cell"
        summary={
          <span className="flex min-w-0 items-center gap-3">
            <Badge tone={positive ? 'success' : 'danger'} dot>
              {positive ? 'Helpful' : 'Not helpful'}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-base text-text-primary">
              {item.question}
            </span>
          </span>
        }
        trailing={
          <span className="flex items-center gap-3">
            {/* `.figure` only when it really is an id. Mono on "Priya Sharma"
                is mono on a name, which DESIGN reserves for figures and code.
                Hidden below `md`: at `sm` the row is already three deep. */}
            <span
              className={cn(
                'hidden max-w-32 truncate text-xs text-text-tertiary md:inline',
                IDENTIFIER.test(item.user) && 'figure',
              )}
            >
              {item.user}
            </span>
            <span className="figure text-xs text-text-secondary">
              {formatDateTime(item.created_at)}
            </span>
          </span>
        }
      >
          {/* A quotation rule, not a fill. A `bg-surface-sunken` block on the
              card's own `bg-surface` reads as a rendering artefact; the 3px
              leading rule is the device the visitor panel already uses for
              "here is what someone said", so the two treatments match. */}
          <dl className="grid gap-3">
            <div className="border-l-[3px] border-l-border-strong pl-3">
              <dt className={EYEBROW_CLASS}>Visitor asked</dt>
              <dd className="mt-1 text-prose text-text-primary">{item.question}</dd>
            </div>
            <div className="border-l-[3px] border-l-border-strong pl-3">
              <dt className={EYEBROW_CLASS}>Chatbot answered</dt>
              <dd className="mt-1 text-prose text-text-secondary">{item.answer}</dd>
            </div>
          </dl>

          {!positive ? (
            <div className="mt-3 flex items-center gap-3">
              <Button size="sm" variant="secondary" onClick={copyIssue}>
                {state === 'copied' ? 'Copied' : 'Copy this exchange'}
              </Button>
              {/* An alert, not a toast: it explains why nothing happened, and
                  the user has to read it in order to get the text another way. */}
              <span aria-live="polite" className="text-xs text-text-secondary">
                {state === 'failed'
                  ? 'Your browser blocked the clipboard. Select the text above and copy it.'
                  : null}
              </span>
            </div>
          ) : null}
      </Disclosure>
    </li>
  );
}
