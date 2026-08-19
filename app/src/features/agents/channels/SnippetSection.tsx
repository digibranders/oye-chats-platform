import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot as BotIcon, Check, Mail } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  CopyField,
  Eyebrow,
  Skeleton,
  buttonClass,
  useClipboard,
} from '../../../ui';
import { recordActivationEvent } from '../../../services/api';
import { ATTRIBUTION_TEXT } from '../../../data/widgetEmbed';
import type { Platform, PlatformEnv } from '../../../data/platformIntegrations';
import { developerEmail, embedSnippet } from './deployModel';
import { buildInstallPrompt } from './installPrompt';

export interface SnippetSectionProps {
  botKey: string;
  botName: string;
  botId: number;
  env: PlatformEnv;
  apiBaseUrl: string;
  /** The platform chosen in the guide below, so the prompt and email match it. */
  platform: Platform | null;
  /** True when the snippet must carry the crawlable attribution anchor. */
  attribution: boolean;
  /** Entitlements have not resolved, so we do not yet know which snippet is right. */
  resolving: boolean;
}

/**
 * The snippet, and the two ways it leaves this page without being pasted here.
 *
 * **Nothing is rendered until entitlements resolve.** The entitlements fallback
 * defaults `branding_removable` to `false`, so an unresolved fetch would compute
 * "include the attribution anchor" even for a workspace entitled to remove it —
 * and unlike a gated *action*, which the backend re-checks, nothing re-verifies
 * a string the customer has already copied into their own repository. So this
 * waits rather than guesses.
 *
 * The attribution anchor is stated, never hidden. It is a visible, `nofollow`
 * link in the customer's served HTML, and it is the only attribution a crawler
 * can ever see: the widget mounts into a shadow root from JavaScript after a
 * visitor clicks the launcher, so its in-widget badge is invisible to every
 * crawler — non-rendering crawlers run no JS, and rendering ones never click.
 * A customer who finds that out later, from their SEO agency, is a customer we
 * have lost.
 */
export function SnippetSection({
  botKey,
  botName,
  botId,
  env,
  apiBaseUrl,
  platform,
  attribution,
  resolving,
}: SnippetSectionProps) {
  const prompt = useClipboard();
  const [emailed, setEmailed] = useState(false);

  const snippet = embedSnippet({ botKey, env, attribution });
  const email = developerEmail({
    botName,
    snippet,
    env,
    apiBaseUrl,
    platformName: platform?.name ?? null,
    attribution,
  });

  async function copyPrompt() {
    // Belt-and-braces alongside the disabled state: never build a briefing from
    // an unresolved entitlement.
    if (resolving) return;
    await prompt.copy(buildInstallPrompt({ botKey, apiBaseUrl, env, platform, attribution }));
    // Recorded on intent, not on clipboard success: the customer asked for the
    // snippet, and whether the browser let us write it is a browser fact, not an
    // activation fact. `recordActivationEvent` never throws by design.
    void recordActivationEvent('install_snippet_copied', { botId });
  }

  return (
    <Card>
      <CardHeader
        eyebrow="The snippet"
        titleAs="h2"
        title="Add this to your website"
        description="One tag, on every page. It goes in the shared layout or footer template so it loads site-wide — you only ever paste it once."
      />
      <CardBody className="space-y-5">
        <div className="space-y-1.5">
          <Eyebrow>Embed key</Eyebrow>
          {/* Not masked. The key is a public identifier — it is visible in the
              page source of every site that runs the widget, and it is safe to
              commit — so hiding it behind a reveal control would teach the
              customer to treat it as a secret and be afraid to paste it. */}
          <CopyField value={botKey} label="embed key" />
          <p className="text-xs text-text-secondary">
            Public and safe to commit. Requests are still checked against the domains you allow
            below.
          </p>
        </div>

        {resolving ? (
          <div aria-busy aria-label="Working out which snippet your plan needs" className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>
        ) : (
          <div className="space-y-2">
            <Eyebrow>Paste immediately before &lt;/body&gt;</Eyebrow>
            <CodeBlock
              code={snippet}
              label="embed snippet"
              caption={attribution ? 'Both lines — the script and the credit link' : 'Your plan removes the credit link'}
            />
          </div>
        )}

        {!resolving && attribution ? (
          <Alert
            tone="plan"
            title={`The second line is your “${ATTRIBUTION_TEXT}” link`}
            action={
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                See plans
              </Link>
            }
          >
            It is a normal visible link with <code className="figure">rel="nofollow"</code>, and it
            has to stay in the HTML your server sends — hiding it with CSS breaks Google&rsquo;s
            policy against <em>your</em> domain, not ours. The badge inside the chat window does not
            count: the widget renders in a shadow root only after a visitor clicks, so no crawler
            ever sees it. Plans with white-label branding get a snippet without this line.
          </Alert>
        ) : null}

        {!resolving && !attribution ? (
          <Alert tone="neutral" title="No credit link on your plan">
            Your plan includes white-label branding, so the snippet above is the script tag alone.
            If an older “{ATTRIBUTION_TEXT}” link is already on your site, removing it is up to you
            — we never touch what is already there.
          </Alert>
        ) : null}

        {/* The buyer is very often not the installer. For an SMB the person who
            signs up frequently cannot edit the website at all, so handing the
            job to whoever can is a first-class path, not a fallback. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <a
            href={email.href}
            className={buttonClass('secondary', 'md')}
            onClick={() => {
              setEmailed(true);
              void recordActivationEvent('install_snippet_copied', { botId });
            }}
          >
            {emailed ? (
              <Check aria-hidden className="h-4 w-4 text-success" />
            ) : (
              <Mail aria-hidden className="h-4 w-4" />
            )}
            Email this to my developer
          </a>
          <Button
            variant="secondary"
            onClick={() => void copyPrompt()}
            disabled={resolving}
            iconLeft={
              prompt.state === 'copied' ? (
                <Check aria-hidden className="h-4 w-4 text-success" />
              ) : (
                <BotIcon aria-hidden className="h-4 w-4" />
              )
            }
          >
            {prompt.state === 'copied' ? 'Prompt copied' : 'Copy a prompt for a coding agent'}
          </Button>
          <span role="status" aria-live="polite" className="sr-only">
            {prompt.state === 'copied' ? 'Install prompt copied' : ''}
            {prompt.state === 'failed'
              ? 'Could not copy the prompt. Use the email option instead.'
              : ''}
          </span>
        </div>
        <p className="text-xs text-text-secondary">
          The email and the agent prompt both carry the exact snippet above, the platform steps you
          pick below, and the two Content-Security-Policy origins the widget needs.
        </p>
      </CardBody>
    </Card>
  );
}
