import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Card,
  CardBody,
  ErrorState,
  LoadingRows,
  LockedState,
  PageHeader,
  Stack,
  TabPanel,
  Tabs,
  buttonClass,
} from '../../ui';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { WebhooksPanel } from './integrations/WebhooksPanel';
import { EmailPanel } from './integrations/EmailPanel';
import { MeetingsPanel } from './integrations/MeetingsPanel';

/**
 * Settings ▸ Integrations — how OyeChats reaches the rest of your stack.
 *
 * Three ways out of the product, and they are genuinely different jobs rather
 * than three views of one: a webhook is machine-to-machine, an email is a
 * person being told, and a booking link is the visitor doing something. Each is
 * a tab, and each tab is in the URL, so a support conversation can point
 * straight at the one that is misconfigured.
 *
 * All three are chatbot-scoped, because the underlying settings are columns on
 * the chatbot row. That is stated on the page rather than left for the customer
 * to discover when their second chatbot sends no email.
 */

type TabKey = 'webhooks' | 'email' | 'meetings';

const TAB_ITEMS = [
  { value: 'webhooks', label: 'Webhooks' },
  { value: 'email', label: 'Email' },
  { value: 'meetings', label: 'Meetings' },
] as const;

function isTab(value: string | null): value is TabKey {
  return value === 'webhooks' || value === 'email' || value === 'meetings';
}

export function IntegrationsPage() {
  const [params, setParams] = useSearchParams();
  const { selectedBot, bots, loading, error, refreshBots } = useBotContext();
  const { hasFeature, entitlements } = useEntitlements();

  const bot = selectedBot ?? bots[0] ?? null;
  const webhooksUnlocked = hasFeature('webhooks');
  const emailAccess = entitlements.features.integrations === 'all' ? 'all' : 'reply_to_only';

  // Webhooks lead when they are available; otherwise the first tab a customer
  // can actually use is Email, and landing on a locked tab reads as a broken
  // page rather than as an upsell.
  const fallbackTab: TabKey = webhooksUnlocked ? 'webhooks' : 'email';
  const tab: TabKey = isTab(params.get('tab')) ? (params.get('tab') as TabKey) : fallbackTab;

  const header = (
    <PageHeader
      title="Integrations"
      description={
        bot
          ? `How ${bot.name ?? 'this chatbot'} tells your other tools — and your team — that something happened.`
          : 'How your chatbots tell your other tools — and your team — that something happened.'
      }
    />
  );

  if (loading) {
    return (
      <>
        {header}
        <Card>
          <CardBody>
            <LoadingRows rows={4} />
          </CardBody>
        </Card>
      </>
    );
  }

  if (error) {
    return (
      <>
        {header}
        <Card>
          <ErrorState
            title="We could not load your chatbots"
            description={error.message}
            onRetry={() => void refreshBots()}
          />
        </Card>
      </>
    );
  }

  if (!bot) {
    return (
      <>
        {header}
        <Card>
          <CardBody>
            <Alert
              tone="neutral"
              title="No chatbot yet"
              action={
                <Link to="/welcome" className={buttonClass('primary', 'sm')}>
                  Create a chatbot
                </Link>
              }
            >
              Every integration here belongs to a chatbot — the endpoint we call, the inbox we
              email, the calendar we offer. Create one and its integrations appear here.
            </Alert>
          </CardBody>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      <Stack>
        <Tabs
          label="Integration types"
          items={[...TAB_ITEMS]}
          value={tab}
          onValueChange={(next) => {
            const nextParams = new URLSearchParams(params);
            nextParams.set('tab', next);
            setParams(nextParams, { replace: true });
          }}
        >
          <TabPanel value="webhooks">
            {webhooksUnlocked ? (
              <WebhooksPanel botId={bot.id} />
            ) : (
              <LockedState
                title="Webhooks are not included on your plan"
                description="A webhook is how a qualified lead reaches your CRM within a second of qualifying, without anyone re-typing it. We POST the whole conversation, the contact details and the score to any HTTPS endpoint, sign every request, and retry five times if your server is down."
                action={
                  <Link to="/billing" className={buttonClass('primary', 'md')}>
                    See plans
                  </Link>
                }
              />
            )}
          </TabPanel>

          <TabPanel value="email">
            <EmailPanel bot={bot} access={emailAccess} onSaved={() => void refreshBots()} />
          </TabPanel>

          <TabPanel value="meetings">
            <MeetingsPanel bot={bot} onSaved={() => void refreshBots()} />
          </TabPanel>
        </Tabs>
      </Stack>
    </>
  );
}
