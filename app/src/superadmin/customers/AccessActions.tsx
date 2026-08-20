import { useState } from 'react';
import { KeyRound, Mail, ShieldCheck, Trash2, UserX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  PropertyGrid,
  formatDateTime,
  toast,
} from '../../ui';
import { platform } from '../client';
import { PLATFORM_ROOT } from '../nav';
import { PrivilegesDialog } from './AccountDialogs';
import type { ClientDetail, RotateKeyResult } from './types';

type Pending = 'suspend' | 'restore' | 'reset' | 'rotate' | null;

/**
 * Everything that changes what this account can do.
 *
 * Grouped rather than scattered down the page because they share one property:
 * each takes effect the instant it is confirmed, on a live account, with no
 * undo. Each row states its own consequence in the confirmation — "this cannot
 * be undone" on its own is not one.
 */
export function AccessCard({ client, onChanged }: { client: ClientDetail; onChanged: () => void }) {
  const [pending, setPending] = useState<Pending>(null);
  const [privileges, setPrivileges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);

  const suspended = client.suspended_at !== null;

  async function run(action: () => Promise<void>): Promise<void> {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action was refused.');
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader
        titleAs="h3"
        eyebrow="Access"
        title="Credentials and standing"
        description="Each takes effect immediately, on a live account."
      />

      {error ? (
        <CardBody>
          <Alert tone="danger" live title="That action was refused">
            {error}
          </Alert>
        </CardBody>
      ) : null}

      {rotated ? (
        <CardBody>
          <Alert tone="success" live title="API key rotated">
            The full value is not returned by the API — the customer reads it from their own
            dashboard.
          </Alert>
        </CardBody>
      ) : null}

      <CardBody>
        {/* Four property rows, not four titled sections with a sentence each:
            every one of those sentences is stated again — better — in the
            confirmation that follows the button. */}
        <PropertyGrid
          label="Credentials and standing"
          items={[
            {
              label: 'Standing',
              value: suspended ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone="danger">Suspended</Badge>
                  <span className="figure text-xs text-text-tertiary">
                    {formatDateTime(client.suspended_at)}
                  </span>
                </span>
              ) : (
                <Badge tone="success">Active</Badge>
              ),
              action: (
                <Button
                  size="sm"
                  variant={suspended ? 'secondary' : 'danger'}
                  onClick={() => setPending(suspended ? 'restore' : 'suspend')}
                >
                  <UserX aria-hidden />
                  {suspended ? 'Restore access' : 'Suspend'}
                </Button>
              ),
            },
            {
              label: 'Password',
              note: 'Emails a six-digit reset code valid for 15 minutes. You never see or set their password.',
              value: 'Set by the customer',
              action: (
                <Button size="sm" variant="secondary" onClick={() => setPending('reset')}>
                  <Mail aria-hidden />
                  Send reset code
                </Button>
              ),
            },
            {
              label: 'API key',
              note: 'Rotating issues a new X-API-Key and invalidates the current one on the next request.',
              value: rotated ? <span className="figure">{rotated}</span> : 'Never rotated from here',
              action: (
                <Button size="sm" variant="secondary" onClick={() => setPending('rotate')}>
                  <KeyRound aria-hidden />
                  Rotate
                </Button>
              ),
            },
            {
              label: 'Privileges',
              value: client.is_superadmin ? (
                <Badge tone="plan">Super-admin · {client.superadmin_role ?? 'unset'}</Badge>
              ) : (
                'Customer account'
              ),
              action: (
                <Button size="sm" variant="secondary" onClick={() => setPrivileges(true)}>
                  <ShieldCheck aria-hidden />
                  Change
                </Button>
              ),
            },
          ]}
        />
      </CardBody>

      <PrivilegesDialog
        client={client}
        open={privileges}
        onOpenChange={setPrivileges}
        onSaved={onChanged}
      />

      <ConfirmDialog
        open={pending === 'suspend'}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={`Suspend ${client.name}?`}
        description={
          <>
            Every sign-in and every request carrying their API key is refused from the next attempt.
            Their {client.bots.length} chatbot{client.bots.length === 1 ? '' : 's'}, documents and
            conversation history are left intact, and restoring access reverses this exactly.
          </>
        }
        confirmLabel="Suspend account"
        destructive
        onConfirm={() =>
          run(async () => {
            await platform.patch(`/clients/${client.id}`, { suspended: true });
            setPending(null);
            onChanged();
            toast.success('Account suspended.');
          })
        }
      />

      <ConfirmDialog
        open={pending === 'restore'}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={`Restore access for ${client.name}?`}
        description="They will be able to sign in and authenticate again from their next attempt."
        confirmLabel="Restore access"
        onConfirm={() =>
          run(async () => {
            await platform.patch(`/clients/${client.id}`, { suspended: false });
            setPending(null);
            onChanged();
            toast.success('Access restored.');
          })
        }
      />

      <ConfirmDialog
        open={pending === 'reset'}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title="Send a password-reset code?"
        description={
          <>
            A six-digit code is emailed to <strong>{client.email}</strong>, valid for 15 minutes.
            Their current password keeps working until they use it. If the email cannot be sent the
            API answers 502 and no code is issued.
          </>
        }
        confirmLabel="Send reset code"
        onConfirm={() =>
          run(async () => {
            await platform.post(`/clients/${client.id}/reset-password`);
            setPending(null);
            toast.success('Reset code emailed to the customer.');
          })
        }
      />

      <ConfirmDialog
        open={pending === 'rotate'}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={`Rotate the API key for ${client.name}?`}
        description={
          <>
            Their current <code className="font-mono text-xs">X-API-Key</code> stops authenticating
            immediately. Every dashboard session and every server-side integration signed with it
            breaks until it is updated, and the new key is never returned in full — nobody can hand it
            back to them. Their embedded widgets are unaffected: those authenticate with the bot key,
            which this does not touch.
          </>
        }
        confirmPhrase={client.email}
        confirmPhraseLabel={`Type ${client.email} to confirm the account`}
        confirmLabel="Rotate key"
        destructive
        onConfirm={() =>
          run(async () => {
            const result = await platform.post<RotateKeyResult>(`/clients/${client.id}/rotate-api-key`);
            setRotated(result.api_key_masked);
            setPending(null);
            onChanged();
          })
        }
      />
    </Card>
  );
}

/**
 * Deleting a customer.
 *
 * A `confirmPhrase` case in the strict sense the design system reserves it for:
 * the cascade destroys work that cannot be recreated — every chatbot, every
 * embedded document and its embeddings, every conversation and every lead.
 */
export function DeleteAccountCard({ client }: { client: ClientDetail }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader
        titleAs="h3"
        eyebrow="Irreversible"
        title="Delete this account"
        description="Removes the customer and cascades through everything they own."
      />
      <CardBody className="flex flex-col gap-4">
        {error ? (
          <Alert tone="danger" live title="The account was not deleted">
            {error}
          </Alert>
        ) : null}
        <Alert tone="danger" title="What goes with it">
          {client.bots.length} chatbot{client.bots.length === 1 ? '' : 's'}, their whole knowledge
          base and its embeddings, {client.total_sessions.toLocaleString()} conversations,
          {' '}
          {client.total_messages.toLocaleString()} messages, and every lead captured from them. None
          of it is recoverable. Suspending the account instead keeps all of it and blocks access just
          as completely.
        </Alert>
        <p className="text-xs text-text-secondary">
          The server refuses this outright for an account that has been issued a tax invoice — those
          are statutory records with gapless serials — and for any super-admin account.
        </p>
        <div>
          <Button variant="danger" onClick={() => setOpen(true)}>
            <Trash2 aria-hidden className="h-4 w-4" />
            Delete account
          </Button>
        </div>
      </CardBody>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${client.name} and everything they own?`}
        description={
          <>
            This destroys their chatbots, their knowledge base, every conversation and every lead.
            There is no undo and no backup you can restore from this console. If you only need to stop
            them using the product, suspend the account instead.
          </>
        }
        confirmPhrase={client.email}
        confirmPhraseLabel={`Type ${client.email} to delete this account`}
        confirmLabel="Delete permanently"
        destructive
        onConfirm={async () => {
          setError(null);
          try {
            await platform.remove(`/clients/${client.id}`);
            toast.success(`${client.name} deleted.`);
            navigate(`${PLATFORM_ROOT}/customers`, { replace: true });
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The account was not deleted.');
            setOpen(false);
          }
        }}
      />
    </Card>
  );
}
