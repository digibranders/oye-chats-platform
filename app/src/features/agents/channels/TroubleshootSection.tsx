import { Card, CardBody, CardHeader, CodeBlock } from '../../../ui';
import { troubleshootItems, type TroubleshootInput } from './deployModel';

export interface TroubleshootSectionProps extends TroubleshootInput {
  /** The anchor the install card links to. */
  id: string;
}

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
 * reached this card has a broken install and is scanning for the one line that
 * matches their situation; hiding six of the seven behind a click is the wrong
 * trade at exactly the moment reading speed matters most.
 */
export function TroubleshootSection({ id, ...input }: TroubleshootSectionProps) {
  const items = troubleshootItems(input);

  // `tabIndex={-1}` so the "What to check" link moves focus here as well as
  // scrolling, rather than leaving a keyboard user where they were.
  return (
    <div id={id} tabIndex={-1} className="scroll-mt-24 focus:outline-none">
      <Card>
        <CardHeader
          eyebrow="If it is not showing up"
          titleAs="h2"
          title={`${items.length} things to check`}
          description="In the order they actually go wrong. Work down the list — most installs are fixed by the first three."
        />
        <CardBody flush>
          <ol>
            {items.map((item, index) => (
              <li key={item.id} className="border-t border-border px-5 py-4 first:border-t-0">
                <div className="flex gap-3">
                  <span
                    aria-hidden
                    className="figure flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-2xs font-medium text-text-secondary"
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
        </CardBody>
      </Card>
    </div>
  );
}
