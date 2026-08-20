import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot as BotIcon, Check, Mail } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  CodeBlock,
  CopyField,
  Skeleton,
  Tooltip,
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
 * have lost. It is one alert of 24 words now, not 58 plus a 44-word twin for the
 * plans that do not get it — the `CodeBlock`'s own caption already says which
 * snippet this is.
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
        eyebrow="Snippet"
        titleAs="h2"
        title="Add this to your website"
        description="One tag, in your site’s shared layout."
      />
      <CardBody className="space-y-5">
        {resolving ? (
          <div aria-busy aria-label="Working out which snippet your plan needs" className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-32 w-full rounded-md" />
          </div>
        ) : (
          <CodeBlock
            code={snippet}
            label="embed snippet"
            caption={
              attribution
                ? 'Paste before </body> — both lines, the script and the credit link'
                : 'Paste before </body> — your plan removes the credit link'
            }
          />
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
            It is a visible <code className="figure">nofollow</code> link and has to stay in the
            HTML your server sends. White-label plans get a snippet without it.
          </Alert>
        ) : null}

        <div>
          {/* Not masked. The key is a public identifier — it is visible in the
              page source of every site that runs the widget, and it is safe to
              commit — so hiding it behind a reveal control would teach the
              customer to treat it as a secret and be afraid to paste it. */}
          <CopyField value={botKey} label="embed key" />
          <p className="mt-1.5 text-xs text-text-secondary">Public and safe to commit.</p>
        </div>
      </CardBody>

      {/* The buyer is very often not the installer. For an SMB the person who
          signs up frequently cannot edit the website at all, so handing the job
          to whoever can is a first-class path, not a fallback. */}
      <CardSection className="flex flex-wrap items-center gap-2">
        <Tooltip content="Carries the snippet above, the platform steps, and the two Content-Security-Policy origins the widget needs">
          <a
            href={email.href}
            className={buttonClass('secondary', 'sm')}
            onClick={() => {
              setEmailed(true);
              void recordActivationEvent('install_snippet_copied', { botId });
            }}
          >
            {emailed ? (
              <Check aria-hidden className="text-success" />
            ) : (
              <Mail aria-hidden />
            )}
            Email this to my developer
          </a>
        </Tooltip>
        <Tooltip content="The same briefing, written for a coding agent">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void copyPrompt()}
            disabled={resolving}
            iconLeft={
              prompt.state === 'copied' ? (
                <Check aria-hidden className="text-success" />
              ) : (
                <BotIcon aria-hidden />
              )
            }
          >
            {prompt.state === 'copied' ? 'Prompt copied' : 'Copy a prompt for a coding agent'}
          </Button>
        </Tooltip>
        <span role="status" aria-live="polite" className="sr-only">
          {prompt.state === 'copied' ? 'Install prompt copied' : ''}
          {prompt.state === 'failed'
            ? 'Could not copy the prompt. Use the email option instead.'
            : ''}
        </span>
      </CardSection>
    </Card>
  );
}
