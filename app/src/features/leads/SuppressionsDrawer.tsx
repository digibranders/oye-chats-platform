import { useState, type FormEvent } from 'react';
import { t as translateNow } from '../../i18n/i18n';
import { MailX } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Disclosure,
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
import { useTranslation } from '../../i18n/useTranslation';
import { Trans } from '../../i18n/Trans';

export interface SuppressionsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chatbot the Leads page is scoped to, or `null` for all of them. */
  botId: number | null;
  /** Every chatbot in the workspace — a suppression is always per chatbot. */
  bots: readonly Bot[];
}

/** The suppression reason in the reader's language; the key is the stored code. */
function reasonLabel(reason: string): string {
  return translateNow(`leads.suppressionReason.${reason}`) || REASON_LABEL[reason] || reason;
}

// @i18n-exempt: fallbacks, read through reasonLabel above.
const REASON_LABEL: Record<string, string> = {
  unsubscribe: 'Unsubscribed',
  hard_bounce: 'Bounced',
  spam_complaint: 'Marked as spam',
};

function messageFrom(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : translateNow('leads.somethingWentWrongPleaseTry') || 'Something went wrong. Please try again.';
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
  const { t } = useTranslation();
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
      header: t('leads.address') || 'Address',
      // No `pinned`. It exists for a wide table that scrolls sideways; in a
      // four-column drawer nothing scrolls, so all it drew was a vertical rule
      // down one column that the others did not have.
      width: '18rem',
      // Not `figure`: an email address is not a number, and monospace at 13px
      // is both wider and harder to read than Inter for one.
      render: (row) => <span className="text-text-primary">{row.email}</span>,
    },
    {
      key: 'reason',
      header: t('leads.why') || 'Why',
      render: (row) => <Badge tone="neutral">{reasonLabel(row.reason)}</Badge>,
    },
    ...(botId === null
      ? [
          {
            key: 'bot',
            header: t('leads.chatbot') || 'Chatbot',
            secondary: true,
            render: (row: EmailSuppression) => (
              <span className="text-text-secondary">{row.bot_name ?? `Chatbot ${row.bot_id}`}</span>
            ),
          } satisfies Column<EmailSuppression>,
        ]
      : []),
    {
      key: 'created',
      header: t('leads.since') || 'Since',
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
      setFormError(t('leads.enterTheAddressThatAsked') || 'Enter the address that asked you to stop.');
      return;
    }
    const invalid = validateEmail(trimmed);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    if (scopedBotId === null) {
      setFormError(t('leads.chooseWhichChatbotThisApplies') || 'Choose which chatbot this applies to.');
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
      title={t('leads.unsubscribes') || 'Unsubscribes'}
      description={t('leads.checkedBeforeEveryFollowUp') || 'Checked before every follow-up. Nothing can be removed.'}
      width="lg"
    >
      {data.forbidden ? (
        <LockedState
          title={t('leads.youCannotSeeThisWorkspaces') || 'You cannot see this workspace\'s unsubscribes'}
          description={t('leads.limitedToChatbotsYourAccount') || 'Limited to chatbots your account owns. Ask a workspace owner for access.'}
        />
      ) : (
        <div className="space-y-5">
          <SearchField
            label={t('leads.searchUnsubscribedAddresses') || 'Search unsubscribed addresses'}
            placeholder={t('leads.searchByAddress') || 'Search by address'}
            value={search}
            onValueChange={setSearch}
          />

          <DataTable
            caption={t('leads.addressesSuppressedForThisWorkspace') || 'Addresses suppressed for this workspace'}
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
                  title={t('leads.noAddressMatches') || 'No address matches'}
                  description={t('leads.noAddressContainsThatText') || 'No address contains that text.'}
                  action={
                    <Button size="sm" variant="secondary" onClick={() => setSearch('')}>
                      {t('leads.clearSearch') || 'Clear search'}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  compact
                  icon={MailX}
                  title={t('leads.nobodyHasUnsubscribed') || 'Nobody has unsubscribed'}
                  description={t('leads.everyCapturedAddressCanStill') || 'Every captured address can still be emailed.'}
                />
              )
            }
          />

          {/* A `Disclosure`, not a form loose at the bottom of a scroll that also
              holds a paginated table: after paging to page 3 the submit button
              was 400px below the fold. And the rule it used to draw stopped 20px
              short of the panel's edges on both sides, because the drawer body
              has its own gutter.

              `noValidate`: the address is validated by this form, in this design
              system's error slot, rather than by the browser's own bubble —
              which is unstyleable, disappears on the next keystroke, and (with
              `type="email"`) silently refuses to submit at all. */}
          <Disclosure summary="Record an opt-out" divider headingLevel={3}>
          <form noValidate onSubmit={submit} className="space-y-3 pt-2">
            {botId === null ? (
              <Field label={t('leads.chatbot') || 'Chatbot'} required>
                <Select
                  label={t('leads.chatbot') || 'Chatbot'}
                  value={target}
                  onValueChange={setTarget}
                  options={[
                    { value: '', label: t('leads.chooseAChatbot') || 'Choose a chatbot' },
                    ...bots.map((bot) => ({
                      value: String(bot.id),
                      label: bot.name || `Chatbot ${bot.id}`,
                    })),
                  ]}
                />
              </Field>
            ) : null}

            <Field label={t('leads.emailAddress') || 'Email address'} required error={formError}>
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
              <Alert tone="danger" live title={t('leads.weCouldNotAddThat') || 'We could not add that address'}>
                {addError}
              </Alert>
            ) : null}

            {added ? (
              <Alert tone="success" live>
                {t('leads.willNotBeEmailedAgain', { email: added }) ||
                  `${added} will not be emailed again by this chatbot.`}
              </Alert>
            ) : null}

            <Button type="submit" variant="secondary" loading={data.adding}>
              {t('leads.addToUnsubscribes') || 'Add to unsubscribes'}
            </Button>
          </form>
          </Disclosure>

          {/* The reason a reader hunts for a delete button — answered where they
              hunt for it, and not above the list on every open. */}
          <Disclosure
            summary={t('leads.whyCantIRemoveAnAddress') || 'Why can’t I remove an address?'}
            divider
            headingLevel={3}
          >
            <p className="text-prose text-text-secondary">
              {t('leads.whyCantIRemoveAnAddressBody') ||
                'An address is added when somebody clicks unsubscribe, when their mail bounces permanently, or when you record it here. Nothing removes one: not this panel, and not support. We may only email a visitor with their consent, and consent that has been withdrawn cannot be restored from here.'}
            </p>
          </Disclosure>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('leads.neverEmailThisAddressAgain') || 'Never email this address again?'}
        description={
          <Trans
            k="leads.everyFollowUpToWillBeRefused"
            fallback="Every follow-up to {email} from this chatbot will be refused from now on, including ones your teammates try to send. There is no way to reverse it from this console."
            values={{ email: <strong>{email.trim()}</strong> }}
          />
        }
        confirmLabel={t('leads.addToUnsubscribes') || 'Add to unsubscribes'}
        onConfirm={confirmAdd}
      />
    </Drawer>
  );
}
