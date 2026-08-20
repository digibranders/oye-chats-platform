import { Card, CardBody, CardHeader, CardSection, DefinitionList } from '../../../ui';
import { BLOCKED_CAPABILITIES } from './behaviour.config';

/**
 * What this page would control if the column did anything.
 *
 * Two `Bot` columns are stored, defaulted and never read: the live-chat routing
 * strategy, whose only reader has no caller, and the operator disconnect grace
 * period, whose timer sleeps a class constant. A control over either would
 * validate, save, echo back and change nothing — which is how a customer learns
 * not to trust the settings next to it.
 *
 * The list used to be four. The visitor disconnect grace period, the follow-up
 * pause and the chatbot's own active flag became writable and each has a
 * surface now, so they are gone from here rather than left standing as a claim
 * the product no longer makes.
 *
 * The two that remain are named rather than quietly omitted for two reasons. A
 * customer who has been told routing is configurable needs to see that it is
 * not, in the place they would look for it. And the next engineer needs the
 * file and the line, rather than repeating the archaeology that produced this
 * list.
 */
export function BlockedCapabilitiesSection() {
  return (
    <Card>
      <CardHeader
        title="Not configurable yet"
        titleAs="h2"
        description="Settings this chatbot stores but nothing reads. They would save and change nothing, so there is deliberately no control for them until the code behind each one is finished."
      />
      <CardBody className="space-y-5">
        {BLOCKED_CAPABILITIES.map((item) => (
          <div key={item.title}>
            <h3 className="text-base font-medium text-text-primary">{item.title}</h3>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-text-secondary">
              {item.detail}
            </p>
          </div>
        ))}
      </CardBody>
      <CardSection className="bg-surface-sunken">
        <DefinitionList
          items={BLOCKED_CAPABILITIES.map((item) => ({
            label: item.title,
            value: <span className="figure text-xs">{item.reference}</span>,
          }))}
        />
      </CardSection>
    </Card>
  );
}
