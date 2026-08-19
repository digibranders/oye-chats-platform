import { Card, CardBody, CardHeader, CardSection, DefinitionList } from '../../../ui';
import { BLOCKED_CAPABILITIES } from './behaviour.config';

/**
 * What this page would control if the API let it.
 *
 * Four `Bot` columns are read by live code and have no write path at all —
 * routing strategy, the two disconnect grace periods, the follow-up pause, and
 * the chatbot's own active flag. Three of them were on the rebuild's capability
 * ledger as "backend supports them, no UI", which turned out to be half true:
 * the *behaviour* is supported, the *API* is not.
 *
 * They are named here rather than quietly omitted for two reasons. A customer
 * who has been told routing is configurable needs to see that it is not, in the
 * place they would look for it. And the next engineer needs the file and the
 * line, rather than repeating the archaeology that produced this list.
 */
export function BlockedCapabilitiesSection() {
  return (
    <Card>
      <CardHeader
        title="Not configurable yet"
        titleAs="h2"
        description="Settings this chatbot has in its database that the API does not yet expose. They run on their defaults until it does."
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
