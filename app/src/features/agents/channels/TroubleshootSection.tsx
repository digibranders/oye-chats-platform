import { CodeBlock } from '../../../ui';
import { troubleshootItems, type TroubleshootInput } from './deployModel';

export type TroubleshootSectionProps = TroubleshootInput;

/**
 * What to check when the widget is on the site and we still cannot see it.
 *
 * Every entry is something the customer can rule out themselves in under a
 * minute, in the order the failures actually occur, and the two that are
 * specific to this product lead — the origin allow-list, and the fact that a
 * load from localhost or from the dashboard preview deliberately never counts.
 * Nothing on the open internet will tell them either of those, and "contact
 * support" for a self-serve product is a queue, not an answer.
 *
 * It renders as a plain list rather than as an accordion. A customer who has
 * reached this tab has a broken install and is scanning for the one line that
 * matches their situation; hiding six of the seven behind a click is the wrong
 * trade at exactly the moment reading speed matters most.
 *
 * It draws no card of its own: it is a panel of the help card on Deploy, which
 * already has one. It used to be a full-width card of its own, five cards down
 * a page the install status linked to by anchor.
 */
export function TroubleshootSection(input: TroubleshootSectionProps) {
  const items = troubleshootItems(input);

  return (
    <ol>
      {items.map((item, index) => (
        <li key={item.id} className="border-t border-border px-cell py-4 first:border-t-0">
          <div className="flex gap-3">
            <span
              aria-hidden
              className="figure flex h-6 w-6 shrink-0 items-center justify-center rounded-xs bg-surface-sunken text-2xs font-medium text-text-secondary"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium text-text-primary">{item.title}</p>
              <p className="mt-1 text-prose text-text-secondary">{item.body}</p>
              {item.code ? (
                <CodeBlock className="mt-2.5" code={item.code} label={item.title} />
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
