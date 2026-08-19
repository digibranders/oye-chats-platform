import { useState } from 'react';
import { UserCheck } from 'lucide-react';
import { Alert, Button, Card, CardBody, CardHeader, ConfirmDialog, DefinitionList, toast } from '../../ui';
import { platform } from '../client';
import { useSupportSessions } from './supportSessionStore';
import type { ClientDetail, ImpersonationGrant } from './types';

/**
 * Minting a support session.
 *
 * This is the most dangerous control in the product: the token it creates lets
 * its holder act as the customer, inside the customer's own workspace, with the
 * customer's data. So the control is deliberately slow — a blocking
 * `alertdialog`, the customer named in the title, and the account's email typed
 * out before the confirm button enables. Typing the address is not friction for
 * its own sake: the one mistake this prevents is minting against the account
 * *next to* the one you meant, which nothing else on the screen catches.
 *
 * **The endpoint accepts no reason.** `POST /superadmin/clients/{id}/impersonate`
 * takes a path parameter and nothing else (`superadmin_routes_v2.py:452`); the
 * audit row it writes carries the actor, the target, the token id and the expiry
 * (`:503`). A reason box here would be a text field that goes nowhere, so the
 * dialog says what *is* recorded instead of pretending to record more.
 */
export function ImpersonateCard({ client }: { client: ClientDetail }) {
  const { open } = useSupportSessions();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A privilege write the server refuses outright, so the button says why
  // rather than offering an action that always fails.
  const blocked = client.is_superadmin;

  return (
    <Card>
      <CardHeader
        titleAs="h3"
        eyebrow="Impersonation"
        title="Act as this customer"
        description="Opens their workspace in a new tab under a one-time token. Everything you do is done as them."
      />
      <CardBody className="flex flex-col gap-4">
        {error ? (
          <Alert tone="danger" live title="The support session was not opened">
            {error}
          </Alert>
        ) : null}

        {blocked ? (
          <Alert tone="neutral" title="Super-admin accounts cannot be impersonated">
            A token against another super-admin would carry their privileges, which is a lateral
            escalation between admins. The server refuses it before writing a row.
          </Alert>
        ) : null}

        <DefinitionList
          columns={2}
          items={[
            { label: 'Token lifetime', value: <span className="figure">30 minutes</span> },
            { label: 'Scope', value: 'One browser tab. Closing it ends the session.' },
            {
              label: 'Recorded',
              value: 'Your account, the target account, the token id and the expiry — in the audit log.',
            },
            { label: 'Reason', value: 'Not accepted by this endpoint. Nothing is stored.' },
          ]}
        />

        <Alert tone="warning" title="What the customer sees, and what you can do">
          The customer is not notified. Writes are allow-listed server-side during a support session,
          so destructive actions in their workspace are refused — but everything readable is readable,
          including their conversations, leads and billing detail.
        </Alert>

        <div>
          <Button variant="secondary" disabled={blocked} onClick={() => setConfirming(true)}>
            <UserCheck aria-hidden className="h-4 w-4" />
            Open a support session
          </Button>
        </div>
      </CardBody>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next) setConfirming(false);
        }}
        title={`Act as ${client.name}?`}
        description={
          <>
            This mints a token that signs you in as <strong>{client.name}</strong> (
            {client.email}) for 30 minutes. You will be able to read everything in their workspace —
            conversations, leads, documents and billing. The action is audit-logged against your
            account, and this endpoint stores no reason.
          </>
        }
        confirmPhrase={client.email}
        confirmPhraseLabel={`Type ${client.email} to confirm the account`}
        confirmLabel="Mint support token"
        onConfirm={async () => {
          setError(null);
          try {
            const grant = await platform.post<ImpersonationGrant>(`/clients/${client.id}/impersonate`);
            open({
              tokenId: grant.token_id,
              clientId: client.id,
              clientName: client.name,
              clientEmail: client.email,
              expiresAt: grant.expires_at,
              mintedAt: new Date().toISOString(),
              revokedAt: null,
              handoffUrl: grant.redirect_url,
            });
            setConfirming(false);
            toast.success('Support token minted. Open it from Support sessions.');
          } catch (cause) {
            // Surfaced on the page, not only inside the dialog: the kill switch
            // ("Impersonation is temporarily disabled") and the read-only role
            // refusal are both facts the operator needs after the dialog closes.
            setError(cause instanceof Error ? cause.message : 'The token could not be minted.');
            setConfirming(false);
          }
        }}
      />
    </Card>
  );
}
