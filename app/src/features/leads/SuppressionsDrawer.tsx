import { useState, type FormEvent } from 'react';
import { MailX } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  LockedState,
  SearchField,
  Select,
  formatDate,
  validateEmail,
  type Column,
} from '../../ui';
import type { Bot } from '../../types/domain';
import type { EmailSuppression } from '../../services/api';
import { SUPPRESSIONS_PAGE_SIZE, useSuppressions } from './useSuppressions';

export interface SuppressionsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chatbot the Leads page is scoped to, or `null` for all of them. */
  botId: number | null;
  /** Every chatbot in the workspace — a suppression is always per chatbot. */
  bots: readonly Bot[];
}

const REASON_LABEL: Record<string, string> = {
  unsubscribe: 'Unsubscribed',
  hard_bounce: 'Bounced',
  spam_complaint: 'Marked as spam',
};

function messageFrom(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : 'Something went wrong. Please try again.';
}

/**
 * Who has asked you to stop emailing them.
 *
 * `EmailSuppression` has always been written by the public unsubscribe link and
 * read by Gate 3 of the manual follow-up, and no customer could see it — so an
 * address they expected to reach was silently refused with no way to find out
 * why. This is that list, plus the one write the API allows: recording an
 * opt-out somebody gave you out of band, on a call or by replying to the email.
 *
 * **There is no removal, and the panel says so rather than implying one is
 * hidden somewhere.** The API exposes no `DELETE`, deliberately: this product's
 * lawful basis for emailing a visitor under India's DPDP Act is consent, and
 * consent that has been withdrawn is not something an admin console re-grants.
 * A reader who is looking for a delete button needs to be told it does not
 * exist, in the place they are looking for it — silence would read as a bug.
 *
 * A drawer rather than a page: it is a reference list consulted from Leads
 * ("why did that send fail?"), not a destination, and it belongs beside the
 * table that raised the question rather than at the end of a navigation.
 */
export function SuppressionsDrawer({ open, onOpenChange, botId, bots }: SuppressionsDrawerProps) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [email, setEmail] = useState('');
  const [target, setTarget] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const data = useSuppressions({ botId, page, search, enabled: open });

  // A new search, or a new chatbot, is a different question — so it starts at
  // its first page. Reset during render rather than in an effect: an effect
  // would paint page 4 of the previous question first, and page 4 of a
  // one-page result renders as "no unsubscribes" for a frame.
  const scope = `${botId ?? 'all'}|${search.trim()}`;
  const [pagedScope, setPagedScope] = useState(scope);
  if (pagedScope !== scope) {
    setPagedScope(scope);
    setPage(1);
  }

  // Which chatbot a new suppression is recorded against. Pre-set to the page's
  // own scope; only asked for when the page is showing every chatbot, because a
  // suppression on the wrong chatbot silently fails to stop the send the user
  // was trying to stop.
  const scopedBotId = botId ?? (target ? Number(target) : null);

  const columns: Column<EmailSuppression>[] = [
    {
      key: 'email',
      header: 'Address',
      pinned: true,
      width: '18rem',
      render: (row) => <span className="figure text-sm text-text-primary">{row.email}</span>,
    },
    {
      key: 'reason',
      header: 'Why',
      render: (row) => <Badge tone="neutral">{REASON_LABEL[row.reason] ?? row.reason}</Badge>,
    },
    ...(botId === null
      ? [
          {
            key: 'bot',
            header: 'Chatbot',
            secondary: true,
            render: (row: EmailSuppression) => (
              <span className="text-text-secondary">{row.bot_name ?? `Chatbot ${row.bot_id}`}</span>
            ),
          } satisfies Column<EmailSuppression>,
        ]
      : []),
    {
      key: 'created',
      header: 'Since',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="figure text-sm text-text-secondary">{formatDate(row.created_at)}</span>
      ),
    },
  ];

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setFormError('Enter the address that asked you to stop.');
      return;
    }
    const invalid = validateEmail(trimmed);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    if (scopedBotId === null) {
      setFormError('Choose which chatbot this applies to.');
      return;
    }
    setFormError(null);
    setAddError(null);
    setAdded(null);
    setConfirming(true);
  }

  async function confirmAdd(): Promise<void> {
    if (scopedBotId === null) return;
    try {
      const address = email.trim();
      await data.add({ botId: scopedBotId, email: address });
      setConfirming(false);
      setEmail('');
      setAddError(null);
      // Announced, not merely reflected in a row somewhere down the list: the
      // new address may be on page three, and a form that empties itself is
      // not an outcome anybody can hear.
      setAdded(address);
    } catch (cause) {
      // Rethrown so `ConfirmDialog` keeps itself open and shows the reason:
      // this is the last moment before a permanent record, and a failure that
      // closed the dialog would look exactly like a success.
      setAddError(messageFrom(cause));
      throw cause;
    }
  }

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Unsubscribes"
      description="Addresses that have asked not to receive follow-up emails. Every send is checked against this list."
      width="lg"
    >
      {data.forbidden ? (
        <LockedState
          title="You cannot see this workspace's unsubscribes"
          description="This list contains visitors' email addresses, so it is limited to the chatbots your account owns. If you believe you should have access, ask a workspace owner."
        />
      ) : (
        <div className="space-y-5">
          <Alert tone="neutral" title="This list cannot be undone">
            An address is added when somebody clicks unsubscribe, when their mail bounces
            permanently, or when you record it here. Nothing removes one — not this panel and not
            support. We may only email a visitor with their consent, and consent that has been
            withdrawn cannot be restored from here. If they want to hear from you again, they have
            to reach out themselves.
          </Alert>

          <SearchField
            label="Search unsubscribed addresses"
            placeholder="Search by address"
            value={search}
            onValueChange={setSearch}
          />

          <DataTable
            caption="Addresses suppressed for this workspace"
            columns={columns}
            rows={data.rows}
            rowKey={(row) => String(row.id)}
            loading={data.loading}
            error={data.error ? data.error.message : null}
            onRetry={data.retry}
            page={page}
            onPageChange={setPage}
            rowCount={data.total}
            pageSize={SUPPRESSIONS_PAGE_SIZE}
            empty={
              search.trim() ? (
                <EmptyState
                  compact
                  icon={MailX}
                  title="No address matches"
                  description="Nothing on the unsubscribe list contains that text. Clear the search to see the whole list."
                  action={
                    <Button size="sm" variant="secondary" onClick={() => setSearch('')}>
                      Clear search
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  compact
                  icon={MailX}
                  title="Nobody has unsubscribed"
                  description="Every address you have captured can still be emailed. Anyone who clicks unsubscribe in a follow-up appears here immediately."
                />
              )
            }
          />

          {/* `noValidate`: the address is validated by this form, in this
              design system's error slot, rather than by the browser's own
              bubble — which is unstyleable, disappears on the next keystroke,
              and (with `type="email"`) silently refuses to submit at all. */}
          <form noValidate onSubmit={submit} className="space-y-3 border-t border-border pt-5">
            <div>
              <h3 className="text-base font-medium text-text-primary">
                Record an opt-out you were given elsewhere
              </h3>
              <p className="mt-0.5 text-xs text-text-secondary">
                Somebody asked you to stop on a call, in a reply, or in a ticket. Adding them here
                is what makes that stick — it is the same list the unsubscribe link writes to.
              </p>
            </div>

            {botId === null ? (
              <Field label="Chatbot" required hint="Unsubscribes are per chatbot, never workspace-wide.">
                <Select
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  options={[
                    { value: '', label: 'Choose a chatbot' },
                    ...bots.map((bot) => ({
                      value: String(bot.id),
                      label: bot.name || `Chatbot ${bot.id}`,
                    })),
                  ]}
                />
              </Field>
            ) : null}

            <Field label="Email address" required error={formError}>
              <Input
                type="text"
                inputMode="email"
                autoComplete="off"
                value={email}
                placeholder="name@company.com"
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (formError) setFormError(null);
                  if (added) setAdded(null);
                }}
              />
            </Field>

            {addError ? (
              <Alert tone="danger" live title="We could not add that address">
                {addError}
              </Alert>
            ) : null}

            {added ? (
              <Alert tone="success" live>
                {added} will not be emailed again by this chatbot.
              </Alert>
            ) : null}

            <Button type="submit" variant="secondary" loading={data.adding}>
              Add to unsubscribes
            </Button>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Never email this address again?"
        description={
          <>
            Every follow-up to <strong>{email.trim()}</strong> from this chatbot will be refused
            from now on, including ones your teammates try to send. There is no way to reverse it
            from this console.
          </>
        }
        confirmLabel="Add to unsubscribes"
        onConfirm={confirmAdd}
      />
    </Drawer>
  );
}
