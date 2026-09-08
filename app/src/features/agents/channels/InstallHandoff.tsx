import { useState } from 'react';
import { Bot as BotIcon, Check, Mail, Send } from 'lucide-react';
import {
  Alert,
  Button,
  CopyField,
  Field,
  Input,
  Tooltip,
  formatRelative,
  useClipboard,
} from '../../../ui';
import { recordActivationEvent, sendInstallInvite } from '../../../services/api';
import type { Platform, PlatformEnv } from '../../../data/platformIntegrations';
import { embedSnippet } from './deployModel';
import { developerEmail } from './developerEmail';
import { buildInstallPrompt } from './installPrompt';
import { useTranslation } from '../../../i18n/useTranslation';
import { Trans } from '../../../i18n/Trans';

export interface InstallHandoffProps {
  botKey: string;
  botName: string;
  botId: number;
  env: PlatformEnv;
  apiBaseUrl: string;
  /** The platform chosen in the guide below, so the prompt and email match it. */
  platform: Platform | null;
  /** `Bot.dev_invite_email` — who the briefing last went to, or null. */
  devInviteEmail: string | null;
  /** `Bot.dev_invite_sent_at` — when it went, or null. */
  devInviteSentAt: string | null;
}

/**
 * Matches the server's `EmailAddress` validator, which is the thing that
 * actually decides. Checked here only so a typo costs nothing: the alternative
 * is a round trip to be told about a missing `@`.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The key, and the two ways this install leaves the page without being pasted
 * here.
 *
 * It used to be a card of its own at the top of Deploy, headed "Add this to
 * your website", carrying the script tag above these controls. That tag was
 * printed twice on one screen: the platform guide beside it opens with the
 * same snippet, in the form the customer's stack actually needs — a `<script>`
 * for HTML, a `<Script>` for Next, a theme-editor path for Shopify. Every one
 * of the fifteen platforms carries the code in its own steps, so the generic
 * copy was the one nobody should follow, printed first and largest.
 *
 * What was NOT duplicated is here: the embed key on its own, for the platforms
 * that ask for a key rather than a tag, and the hand-off. The buyer is very
 * often not the installer — for an SMB the person who signs up frequently
 * cannot edit the website at all — so handing the job to whoever can is a
 * first-class path rather than a fallback.
 */
export function InstallHandoff({
  botKey,
  botName,
  botId,
  env,
  apiBaseUrl,
  platform,
  devInviteEmail,
  devInviteSentAt,
}: InstallHandoffProps) {
  const { t } = useTranslation();
  const prompt = useClipboard();

  // Seeded from the bot, so a reload — or a different machine — still knows.
  // Local state takes over only once this session has sent something.
  const [sent, setSent] = useState<{ email: string; at: string } | null>(
    devInviteEmail && devInviteSentAt ? { email: devInviteEmail, at: devInviteSentAt } : null,
  );
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // The one case worth a second look: the same person, twice.
  const [confirming, setConfirming] = useState(false);

  const snippet = embedSnippet({ botKey, env });
  const email = developerEmail({
    botName,
    snippet,
    env,
    apiBaseUrl,
    platformName: platform?.name ?? null,
  });

  function reveal() {
    setOpen(true);
    setConfirming(false);
    setError(null);
    // Pre-filled with the last recipient: re-sending to the same developer is
    // the common case, and retyping an address to be told it is a duplicate is
    // the worst possible ordering.
    setDraft(sent?.email ?? '');
  }

  async function send(address: string) {
    setSending(true);
    setError(null);
    try {
      const result = await sendInstallInvite(botId, address);
      setSent({ email: result.email, at: result.sent_at });
      setOpen(false);
      setConfirming(false);
      setDraft('');
      // A real milestone, unlike the `install_snippet_copied` this button used
      // to emit: nothing was ever copied.
      void recordActivationEvent('install_invite_sent', { botId });
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : t('agents.weCouldNotSendThat') || 'We could not send that email. Please try again.',
      );
    } finally {
      setSending(false);
    }
  }

  function submit() {
    const address = draft.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setError(t('agents.pleaseEnterAValidEmail') || 'Please enter a valid email address.');
      return;
    }
    // Confirm only for the address we already mailed. A second developer is a
    // new handoff, not a duplicate, and a warning that fires when nothing is
    // wrong stops being read.
    if (!confirming && sent && sent.email.toLowerCase() === address.toLowerCase()) {
      setConfirming(true);
      return;
    }
    void send(address);
  }

  async function copyPrompt() {
    await prompt.copy(buildInstallPrompt({ botKey, apiBaseUrl, env, platform }));
    // Recorded on intent, not on clipboard success: the customer asked for the
    // snippet, and whether the browser let us write it is a browser fact, not an
    // activation fact. `recordActivationEvent` never throws by design.
    void recordActivationEvent('install_snippet_copied', { botId });
  }

  return (
    <div className="space-y-3">
      <div>
        {/* Not masked. The key is a public identifier — it is visible in the
            page source of every site that runs the widget, and it is safe to
            commit — so hiding it behind a reveal control would teach the
            customer to treat it as a secret and be afraid to paste it. */}
        <CopyField value={botKey} label={t('agents.embedKey') || 'embed key'} />
        <p className="mt-1.5 text-xs text-text-secondary">{t('agents.publicAndSafeToCommit') || 'Public and safe to commit.'}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {sent && !open ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm text-text-secondary">
              <Check aria-hidden className="text-success" />
              <Trans
                k="agents.sentToWhen"
                fallback="Sent to {email} {when}"
                values={{
                  email: (
                    <strong className="font-medium text-text-primary">{sent.email}</strong>
                  ),
                  when: formatRelative(sent.at),
                }}
              />
            </span>
            <Button variant="secondary" size="sm" onClick={reveal}>
              {t('agents.sendAgain') || 'Send again'}
            </Button>
          </span>
        ) : !open ? (
          <Tooltip content="Carries the snippet above, the platform steps, and the two Content-Security-Policy origins the widget needs">
            <Button variant="secondary" size="sm" onClick={reveal} iconLeft={<Mail aria-hidden />}>
              {t('agents.emailThisToMyDeveloper') || 'Email this to my developer'}
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip content="The same briefing, written for a coding agent">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void copyPrompt()}
            iconLeft={
              prompt.state === 'copied' ? (
                <Check aria-hidden className="text-success" />
              ) : (
                <BotIcon aria-hidden />
              )
            }
          >
            {prompt.state === 'copied' ? t('agents.promptCopied') || 'Prompt copied' : t('agents.copyAPromptForA') || 'Copy a prompt for a coding agent'}
          </Button>
        </Tooltip>
        <span role="status" aria-live="polite" className="sr-only">
          {prompt.state === 'copied' ? t('agents.installPromptCopied') || 'Install prompt copied' : ''}
          {prompt.state === 'failed'
            ? t('agents.couldNotCopyThePrompt') || 'Could not copy the prompt. Use the email option instead.'
            : ''}
          {/* The send collapses the form and swaps in a line of text. That is
              obvious to anyone looking at it and silent to anyone not. */}
          {sent && !open
            ? t('agents.installSnippetEmailedTo', { email: sent.email }) ||
              `Install snippet emailed to ${sent.email}`
            : ''}
        </span>
      </div>

      {open ? (
        <form
          className="space-y-3"
          // `type="email"` earns its keep on mobile (the right keyboard, and
          // autofill), but its native validation would answer with a browser
          // bubble that no styling reaches, disappears on its own, and is not
          // wired to the input for assistive tech. `noValidate` keeps the
          // input type and moves the message into `Field`'s error, which is.
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {/* Send and Cancel belong to the control ROW, not beside the
              `Field`. As siblings of it they aligned to the field's bottom
              edge — which is under the hint, not under the input — so the
              buttons sat a line low against the text they act on. Inside,
              the label sits above the whole row and the hint below it, and
              the input and its two actions share one baseline. */}
          <Field
            label={t('agents.yourDevelopersEmail') || 'Your developer\'s email'}
            error={error}
            hint={t('agents.theyGetTheSnippetWhere') || 'They get the snippet, where it goes, and the two origins a CSP has to allow.'}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-0 flex-1 basis-64"
                type="email"
                autoComplete="email"
                autoFocus
                placeholder="dev@yourcompany.com"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  // A repeat is judged on what is being sent, so editing
                  // the address retracts the question.
                  setConfirming(false);
                  setError(null);
                }}
              />
              {/* `md`, matching the input's own rung. The "one rung below"
                  rule is for a button INSIDE a bordered control, where the
                  border steals 2px of the content box; these sit beside it,
                  where a shorter button reads as a mismatch rather than as
                  nesting. */}
              <Button
                type="submit"
                variant="primary"
                loading={sending}
                iconLeft={<Send aria-hidden />}
              >
                {t('agents.send') || 'Send'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  setConfirming(false);
                  setError(null);
                }}
              >
                {t('agents.cancel') || 'Cancel'}
              </Button>
            </div>
          </Field>

          {confirming && sent ? (
            // A warning, never a wall: the customer asked for it twice, and
            // the second time is usually deliberate.
            <Alert
              tone="warning"
              live
              title={
                t('agents.alreadySentTo', {
                  email: sent.email,
                  when: formatRelative(sent.at),
                }) || `Already sent to ${sent.email} ${formatRelative(sent.at)}`
              }
              action={
                <Button variant="secondary" size="sm" onClick={() => void send(draft.trim())}>
                  {t('agents.sendItAgain') || 'Send it again'}
                </Button>
              }
            >
              {t('agents.sendingAgainIsFineThis') || 'Sending again is fine. This is only here so a second copy is on purpose.'}
            </Alert>
          ) : null}

            <p className="text-xs text-text-secondary">
              {t('agents.wouldRatherUseYourOwnContacts') || 'Would rather use your own contacts?'}{' '}
              <a href={email.href} className="underline underline-offset-2 hover:text-text-primary">
                {t('agents.openItInMyMail') || 'Open it in my mail app'}
              </a>
              {t('agents.weCannotRecordWhatYou') || '. We cannot record what you send that way.'}
            </p>
        </form>
      ) : null}
    </div>
  );
}
