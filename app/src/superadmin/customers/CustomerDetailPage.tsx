import { useState } from 'react';
import { ArrowLeft, CoinsIcon, Globe2, PencilLine } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Grid,
  PropertyGrid,
  EmptyState,
  Section,
  Skeleton,
  Stack,
  StatRow,
  buttonClass,
  formatDate,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { usePlatformResource } from '../usePlatform';
import { PLATFORM_ROOT } from '../nav';
import { USD_NORMALISED_SHORT, usdCentsRounded } from '../money';
import { PAGE_SIZE } from '../recordListState';
import { AccessCard, DeleteAccountCard } from './AccessActions';
import { BillingCountryDialog, CreditsDialog, EditAccountDialog } from './AccountDialogs';
import { ImpersonateCard } from './Impersonate';
import { SupportSessionsPanel } from './SupportSessions';
import { SUBSCRIPTION_TONES, type ClientBot, type ClientDetail } from './types';

const BOT_COLUMNS: Column<ClientBot>[] = [
  {
    key: 'name',
    header: 'Chatbot',
    pinned: true,
    render: (bot) => <span className="font-medium">{bot.name || 'Untitled chatbot'}</span>,
  },
  {
    key: 'bot_key',
    header: 'Bot key',
    render: (bot) => <span className="font-mono text-xs text-text-secondary">{bot.bot_key}</span>,
  },
  {
    key: 'is_active',
    header: 'State',
    render: (bot) =>
      bot.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Disabled</Badge>,
  },
  {
    key: 'created_at',
    header: 'Created',
    secondary: true,
    render: (bot) => <span className="figure text-text-secondary">{formatDate(bot.created_at)}</span>,
  },
];

/**
 * One customer, and everything that can be done to them.
 *
 * Ordered by what a support conversation actually needs: who they are and what
 * they are paying, then their chatbots, then the controls — with impersonation
 * and its live-session list adjacent, because minting a token and being able to
 * end it must never be two different places.
 */
export function CustomerDetailPage() {
  const { clientId } = useParams();
  const numericId = Number(clientId);
  const valid = Number.isInteger(numericId) && numericId > 0;
  const record = usePlatformResource<ClientDetail>(valid ? `/clients/${numericId}` : null);

  const [editing, setEditing] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [relocating, setRelocating] = useState(false);

  const client = record.data;
  const subscription = client?.subscription ?? null;

  return (
    <PlatformPage
      eyebrow="Customer"
      title={client?.name ?? (record.loading ? 'Loading account' : 'Account')}
      description={client ? client.email : 'One account, its chatbots, and the controls that act on it.'}
      forbidden={record.forbidden}
      error={!valid ? 'That is not a valid account id.' : record.error && !client ? record.error : null}
      onRetry={record.reload}
      actions={
        <Link to={`${PLATFORM_ROOT}/customers`} className={buttonClass('ghost', 'sm')}>
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          All accounts
        </Link>
      }
    >
      {record.loading && !client ? (
        <Stack>
          <Skeleton className="h-24" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </Stack>
      ) : !client ? (
        <EmptyState
          title="No such account"
          description="The id in the address does not match an account on this platform. It may have been deleted."
        />
      ) : (
        <Stack>
          {client.suspended_at ? (
            <Alert tone="danger" title="This account is suspended">
              Signed out since {formatDateTime(client.suspended_at)}. They cannot sign in or use
              their API key until access is restored.
            </Alert>
          ) : null}

          <Card>
            <CardBody flush>
              <StatRow
                label="Account totals"
                period="All time"
                items={[
                  {
                    // Unit and definition are hints; "All time" on the strip is
                    // the window. See the note on `revenue/OverviewTab`'s strip.
                    label: 'Monthly recurring',
                    size: 'lg',
                    value: usdCentsRounded(client.mrr_cents),
                    hint: USD_NORMALISED_SHORT,
                  },
                  {
                    label: 'Credit balance',
                    value: formatNumber(client.credits_balance),
                    hint: 'Ledger sum',
                    tone: client.credits_balance < 0 ? 'danger' : 'neutral',
                  },
                  { label: 'Conversations', value: formatNumber(client.total_sessions) },
                  { label: 'Messages', value: formatNumber(client.total_messages) },
                ]}
              />
            </CardBody>
          </Card>

          {/* `stretch`: Identity and Subscription are two panels in one row and
              `start` left the row with a 55px ragged bottom edge. */}
          <Grid cols={2}>
            <Card>
              <CardHeader
                titleAs="h3"
                title="Identity"
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                      <PencilLine aria-hidden className="h-3.5 w-3.5" />
                      Edit details
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setAdjusting(true)}>
                      <CoinsIcon aria-hidden className="h-3.5 w-3.5" />
                      Adjust credits
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setRelocating(true)}>
                      <Globe2 aria-hidden className="h-3.5 w-3.5" />
                      Billing country
                    </Button>
                  </div>
                }
              />
              <CardBody>
                <PropertyGrid
                  items={[
                    { label: 'Account id', value: <span className="figure">{client.id}</span> },
                    { label: 'Login email', value: client.email },
                    {
                      label: 'Website',
                      value: client.website ? (
                        <a
                          className="text-accent-600 underline-offset-2 hover:underline"
                          href={client.website}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {client.website}
                        </a>
                      ) : null,
                    },
                    {
                      label: 'Created',
                      value: <span className="figure">{formatDateTime(client.created_at)}</span>,
                    },
                    {
                      // Absent, not explained: the endpoint's shortcoming is not
                      // the operator's reading material, and rule 10 asks for
                      // an em dash. The accounts list carries the value.
                      label: 'Billing country',
                      value: undefined,
                    },
                    {
                      label: 'Platform role',
                      value: client.is_superadmin ? (
                        <Badge tone="plan">Super-admin · {client.superadmin_role ?? 'unset'}</Badge>
                      ) : (
                        'Customer'
                      ),
                    },
                  ]}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader titleAs="h3" title="Subscription" />
              {subscription ? (
                <CardBody>
                  <PropertyGrid
                    items={[
                      { label: 'Plan', value: subscription.plan_name || '—' },
                      {
                        label: 'Status',
                        value: (
                          <Badge tone={SUBSCRIPTION_TONES[subscription.status] ?? 'neutral'}>
                            {subscription.status.replace(/_/g, ' ')}
                          </Badge>
                        ),
                      },
                      { label: 'Billing cycle', value: subscription.billing_cycle ?? null },
                      { label: 'Payment provider', value: subscription.payment_provider ?? null },
                      {
                        label: 'Seats',
                        value:
                          subscription.operator_quantity != null ? (
                            <span className="figure">{subscription.operator_quantity}</span>
                          ) : null,
                      },
                      {
                        label: 'Current period ends',
                        value: (
                          <span className="figure">{formatDate(subscription.current_period_end)}</span>
                        ),
                      },
                      {
                        label: 'Trial ends',
                        value: subscription.trial_end ? (
                          <span className="figure">{formatDate(subscription.trial_end)}</span>
                        ) : null,
                      },
                      {
                        label: 'Cancelled',
                        value: subscription.canceled_at ? (
                          <span className="figure">{formatDate(subscription.canceled_at)}</span>
                        ) : null,
                      },
                    ]}
                  />
                </CardBody>
              ) : (
                <EmptyState
                  compact
                  title="No subscription on record"
                  description="This account has never held one, or every subscription it held was hard-deleted."
                />
              )}
            </Card>
          </Grid>

          <Section
            title="Chatbots"
            description="Open one in Records for its conversation and message counts."
          >
            <DataTable<ClientBot>
              caption={`Chatbots owned by ${client.name}`}
              columns={BOT_COLUMNS}
              rows={client.bots}
              rowKey={(bot) => String(bot.id)}
              pageSize={PAGE_SIZE}
              defaultSort={{ key: 'name', direction: 'asc' }}
              empty={
                <EmptyState
                  compact
                  title="No chatbots"
                  description="This account has not created one yet, so nothing is embedded on any site."
                />
              }
            />
          </Section>

          <Section title="Support session" description="The most dangerous control in the product.">
            {/* `stretch`, not `start`: two panels of the same kind, and `start`
                left one ending 64px above the other. */}
            <Grid cols={2}>
              <ImpersonateCard client={client} />
              <SupportSessionsPanel clientId={client.id} />
            </Grid>
          </Section>

          <Section title="Controls">
            <AccessCard client={client} onChanged={record.reload} />
          </Section>

          <Section title="Danger zone">
            <DeleteAccountCard client={client} />
          </Section>

          <EditAccountDialog
            client={client}
            open={editing}
            onOpenChange={setEditing}
            onSaved={record.reload}
          />
          <CreditsDialog
            client={client}
            open={adjusting}
            onOpenChange={setAdjusting}
            onSaved={record.reload}
          />
          <BillingCountryDialog
            client={client}
            open={relocating}
            onOpenChange={setRelocating}
            onSaved={record.reload}
          />
        </Stack>
      )}
    </PlatformPage>
  );
}
