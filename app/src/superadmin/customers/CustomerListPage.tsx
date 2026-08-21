import { useState, type ReactElement } from 'react';
import { UserPlus } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Dialog,
  EmptyState,
  Field,
  Input,
  SearchField,
  NavTabs,
  Section,
  Select,
  Stack,
  StatRow,
  Toolbar,
  formatDate,
  formatNumber,
  toast,
  validateEmail,
  type Column,
} from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { platform } from '../client';
import { usePlatformList, useUrlState } from '../usePlatform';
import { PLATFORM_ROOT } from '../nav';
import { RecordList } from '../RecordList';
import { byDate, byNumber, byText, includesText, usePagedRows } from '../recordListState';
import { CredentialsTab, DevicesTab, IdentitiesTab, NotificationsTab, OperatorsTab } from './DirectoryTabs';
import { SupportSessionsPanel } from './SupportSessions';
import { useSupportSessions } from './supportSessionStore';
import { SUBSCRIPTION_TONES, type ClientRow } from './types';
import { USD_NORMALISED_SHORT, usdCentsRounded } from '../money';

const BASE = `${PLATFORM_ROOT}/customers`;

const TABS = [
  { to: BASE, label: 'Accounts', end: true },
  { to: `${BASE}/operators`, label: 'Operators' },
  { to: `${BASE}/identities`, label: 'Sign-in identities' },
  { to: `${BASE}/credentials`, label: 'API keys' },
  { to: `${BASE}/devices`, label: 'Devices' },
  { to: `${BASE}/notifications`, label: 'Notifications' },
];

const STATUSES = [
  { value: '', label: 'Any subscription' },
  { value: 'active', label: 'Active' },
  { value: 'trialing', label: 'Trialing' },
  { value: 'past_due', label: 'Past due' },
  { value: 'paused', label: 'Paused' },
  { value: 'canceled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
  { value: 'none', label: 'No subscription' },
];

/** A password nobody ever sees. See `CreateAccountDialog` for why that is the point. */
function unseenPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('');
}

/**
 * Provisioning an account by hand.
 *
 * `POST /superadmin/clients` requires a password and answers with the new
 * account's API key in full. Neither is rendered: a super-admin who knows a
 * customer's password can act as them without an audit trail, and this console
 * never shows more of a credential than the last four characters. So the
 * password is random and discarded, and the customer takes ownership through the
 * verification code the server emails them plus a self-service reset.
 */
function CreateAccountDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailProblem = email.trim() ? validateEmail(email.trim()) : null;
  const ready = name.trim().length > 0 && email.trim().length > 0 && emailProblem === null;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await platform.post('/clients', {
        name: name.trim(),
        email: email.trim(),
        password: unseenPassword(),
        website: website.trim() || null,
      });
      toast.success('Account created. The customer has been emailed a verification code.');
      setName('');
      setEmail('');
      setWebsite('');
      onCreated();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The account was not created.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create a customer account"
      description="Nobody sets the password, including you: a random one is generated and discarded, and the customer sets their own from the verification email."
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>
            Create account
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" live title="The account was not created" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-4">
        <Field label="Account name" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme Ltd" />
        </Field>
        <Field
          label="Login email"
          required
          hint="Where the verification code goes, and the account's identity."
          error={email.trim() ? emailProblem : null}
        >
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="ops@acme.com"
          />
        </Field>
        <Field label="Website" optional hint="Used as the default crawl target.">
          <Input value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="acme.com" />
        </Field>
      </div>
    </Dialog>
  );
}

function AccountsTab() {
  const navigate = useNavigate();
  const url = useUrlState();
  const query = url.get('q');
  const status = url.get('status');
  const [creating, setCreating] = useState(false);
  // `GET /superadmin/clients` takes no query parameters at all and returns every
  // account, so both filters below are applied here. That is stated on screen.
  const list = usePlatformList<ClientRow>('/clients');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => {
      const statusMatch =
        !status ||
        (status === 'none' ? row.subscription_status == null : row.subscription_status === status);
      return statusMatch && includesText([row.name, row.email, row.website, row.plan_name], query);
    },
    comparators: {
      name: byText((row) => row.name),
      email: byText((row) => row.email),
      plan_name: byText((row) => row.plan_name),
      subscription_status: byText((row) => row.subscription_status),
      bots_count: byNumber((row) => row.bots_count),
      mrr_cents: byNumber((row) => row.mrr_cents),
      credits_balance: byNumber((row) => row.credits_balance),
      created_at: byDate((row) => row.created_at),
    },
  });

  const totalMrr = list.items.reduce((sum, row) => sum + (row.mrr_cents ?? 0), 0);
  const suspended = list.items.filter((row) => row.suspended_at !== null).length;

  const columns: Column<ClientRow>[] = [
    {
      key: 'name',
      header: 'Account',
      pinned: true,
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-medium">
            {row.name}
            {row.is_superadmin ? <Badge tone="plan">Super-admin</Badge> : null}
            {row.suspended_at ? <Badge tone="danger">Suspended</Badge> : null}
          </p>
          <p className="truncate text-xs text-text-secondary">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'plan_name',
      header: 'Plan',
      sortable: true,
      render: (row) => row.plan_name ?? '—',
    },
    {
      key: 'subscription_status',
      header: 'Subscription',
      sortable: true,
      render: (row) =>
        row.subscription_status ? (
          <Badge tone={SUBSCRIPTION_TONES[row.subscription_status] ?? 'neutral'}>
            {row.subscription_status.replace(/_/g, ' ')}
          </Badge>
        ) : (
          <Badge tone="neutral">None</Badge>
        ),
    },
    {
      key: 'bots_count',
      header: 'Chatbots',
      align: 'right',
      sortable: true,
      render: (row) => formatNumber(row.bots_count),
    },
    {
      key: 'mrr_cents',
      // `USD_NORMALISED_SHORT` is already parenthesised — "USD (converted)" —
      // so wrapping it again printed "MRR (USD (converted))" in the column head.
      header: `MRR, ${USD_NORMALISED_SHORT}`,
      align: 'right',
      sortable: true,
      render: (row) => usdCentsRounded(row.mrr_cents),
    },
    {
      key: 'credits_balance',
      header: 'Credits',
      align: 'right',
      sortable: true,
      secondary: true,
      render: (row) => formatNumber(row.credits_balance),
    },
    {
      key: 'country',
      header: 'Billing country',
      secondary: true,
      render: (row) => row.country ?? '—',
    },
    {
      key: 'created_at',
      header: 'Joined',
      sortable: true,
      secondary: true,
      render: (row) => formatDate(row.created_at),
    },
  ];

  return (
    <Stack>
      {/* Carded, like every other strip in this console. It was the one bare
          `StatRow` on the page ground: its hairlines had nothing to meet, so
          four tiles read as three floating rules over a caption. */}
      <Card>
        <CardBody flush>
          <StatRow
            columns={3}
            label="Platform totals"
            period="Right now"
            loading={list.loading}
            items={[
              { label: 'Accounts', value: formatNumber(list.items.length) },
              {
                label: 'Suspended',
                value: formatNumber(suspended),
                tone: suspended > 0 ? 'warning' : 'neutral',
              },
              {
                // A currency is a unit, not a window. See the note on
                // `revenue/OverviewTab`'s strip.
                label: 'Monthly recurring',
                value: usdCentsRounded(totalMrr),
                hint: USD_NORMALISED_SHORT,
              },
              // "Showing / After this filter" was a fourth tile printing exactly
              // what the table's own count summary prints under it.
            ]}
          />
        </CardBody>
      </Card>

      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search accounts"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Name, email, website or plan"
          />
        </div>
        <div className="w-48">
          <Select
            label="Filter by subscription status"
            value={status}
            onValueChange={(value) => url.set({ status: value })}
            options={STATUSES}
          />
        </div>
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
          <UserPlus aria-hidden className="h-3.5 w-3.5" />
          New account
        </Button>
      </Toolbar>

      <RecordList
        caption="Every account on the platform"
        rowNoun="account"
        what="the account list"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        onRowClick={(row) => navigate(`${PLATFORM_ROOT}/customers/${row.id}`)}
        empty={
          <EmptyState
            compact
            title={query || status ? 'Nothing matched' : 'No accounts yet'}
            description={
              query || status
                ? 'No account matches this filter. Clear it to see the whole platform.'
                : 'Nobody has signed up. The first account can be created from here.'
            }
            action={
              query || status ? (
                <Button size="sm" variant="secondary" onClick={() => url.set({ q: null, status: null })}>
                  Clear filters
                </Button>
              ) : null
            }
          />
        }
      />

      <CreateAccountDialog open={creating} onOpenChange={setCreating} onCreated={list.reload} />
    </Stack>
  );
}

/** The panel each directory route shows. Keyed by the segment after `/customers`. */
const PANELS: Record<string, () => ReactElement> = {
  '': AccountsTab,
  operators: OperatorsTab,
  identities: IdentitiesTab,
  credentials: CredentialsTab,
  devices: DevicesTab,
  notifications: NotificationsTab,
};

/**
 * The directory's own path segments, for the section router.
 *
 * `CustomersPage` declares a route for each of these *before* `:clientId`, which
 * would otherwise swallow all five — see the note there. Derived from `PANELS`
 * so a sixth list cannot be added here and stay unreachable there.
 */
export const DIRECTORY_SEGMENTS: readonly string[] = Object.keys(PANELS).filter(Boolean);

/**
 * The customer directory.
 *
 * One page, six lists, because they answer one question from six angles: who is
 * this account, who works in it, how do they sign in, what authenticates them,
 * what devices they are notified on, and what we have told them. Splitting them
 * across six rail entries would have made the rail longer than the work.
 */
export function CustomerListPage() {
  const { pathname } = useLocation();
  const { sessions } = useSupportSessions();
  const segment = pathname.startsWith(BASE) ? pathname.slice(BASE.length).replace(/^\//, '') : '';
  const Panel = PANELS[segment] ?? AccountsTab;

  return (
    <PlatformPage
      title="Customers"
      toolbarBleed
      toolbar={<NavTabs label="Customer directory" items={TABS} />}
    >
      <Stack>
        {sessions.length > 0 ? (
          <Section title="Support sessions in progress">
            <SupportSessionsPanel />
          </Section>
        ) : null}
        <Panel />
      </Stack>
    </PlatformPage>
  );
}
