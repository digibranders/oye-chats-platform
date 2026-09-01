import { Link, useSearchParams } from 'react-router-dom';
import { Plug } from 'lucide-react';
import {
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  LoadingRows,
  LockedState,
  Stack,
  TabPanel,
  Tabs,
  buttonClass,
} from '../../ui';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { resolveScopedBotId } from '../../context/botScope';
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
  const { hasFeature, entitlements, isFree } = useEntitlements();

  /**
   * Which chatbot these integrations belong to.
   *
   * NOT `selectedBot ?? bots[0]`. That silently targeted the FIRST chatbot
   * whenever nothing was scoped, so in a two-chatbot workspace a webhook could
   * be configured against a chatbot the reader never chose and the page never
   * named. It is the same defect logged as ledger B1 against the business-hours
   * editor on `GeneralPage`, which wrote `bots[0]` unconditionally.
   *
   * `resolveScopedBotId` uses the sole chatbot when there is exactly one — the
   * state almost every account is in — and null with several, where the page
   * asks rather than guesses.
   */
  const scopedBotId = resolveScopedBotId(selectedBot, bots);
  const bot = bots.find((candidate) => candidate.id === scopedBotId) ?? null;
  const webhooksUnlocked = hasFeature('webhooks');
  const emailAccess = entitlements.features.integrations === 'all' ? 'all' : 'reply_to_only';
  // Email and meeting booking are whole-feature paid: the Free plan sees the
  // upsell in place of the panel, the same treatment the Webhooks tab already
  // gives a plan without them.
  const integrationsUnlocked = !isFree;

  // Webhooks lead when they are available; otherwise the first tab a customer
  // can actually use is Email, and landing on a locked tab reads as a broken
  // page rather than as an upsell.
  const fallbackTab: TabKey = webhooksUnlocked ? 'webhooks' : 'email';
  const tab: TabKey = isTab(params.get('tab')) ? (params.get('tab') as TabKey) : fallbackTab;

  if (loading) {
    return (
      <Card>
        <CardBody>
          <LoadingRows rows={4} />
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <ErrorState
          title="We could not load your chatbots"
          description={error.message}
          onRetry={() => void refreshBots()}
        />
      </Card>
    );
  }

  if (!bot) {
    return (
      <Card>
        <EmptyState
          icon={Plug}
          title={bots.length > 1 ? 'Choose a chatbot' : 'No chatbot yet'}
          description={
            bots.length > 1
              ? 'Every integration belongs to one chatbot. Pick one from Showing, in the sidebar.'
              : 'Every integration belongs to a chatbot.'
          }
          action={
            <Link to="/welcome" className={buttonClass('primary', 'sm')}>
              Create a chatbot
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <>
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
                description="A qualified lead reaches your CRM within a second, signed and retried, without anyone re-typing it."
                action={
                  <Link to="/billing" className={buttonClass('primary', 'md')}>
                    See plans
                  </Link>
                }
              />
            )}
          </TabPanel>

          <TabPanel value="email">
            {integrationsUnlocked ? (
              <EmailPanel bot={bot} access={emailAccess} onSaved={() => void refreshBots()} />
            ) : (
              <LockedState
                title="Email notifications are not on your plan"
                description="Get told the moment a lead qualifies, a chat is handed to a human, or a visitor leaves a message, routed to the inboxes you choose."
                action={
                  <Link to="/billing" className={buttonClass('primary', 'md')}>
                    See plans
                  </Link>
                }
              />
            )}
          </TabPanel>

          <TabPanel value="meetings">
            {integrationsUnlocked ? (
              <MeetingsPanel bot={bot} onSaved={() => void refreshBots()} />
            ) : (
              <LockedState
                title="Meeting booking is not on your plan"
                description="Let a qualified visitor book a call with your team straight from the chat, on your own Calendly or Zcal link."
                action={
                  <Link to="/billing" className={buttonClass('primary', 'md')}>
                    See plans
                  </Link>
                }
              />
            )}
          </TabPanel>
        </Tabs>
      </Stack>
    </>
  );
}
