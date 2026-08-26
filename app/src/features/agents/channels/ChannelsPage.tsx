import { useEffect, useState, type ReactElement } from 'react';
import { Globe, PlugZap } from 'lucide-react';
import {
  Button,
  EmptyState,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
} from '../../../design-system';
import { InsightCard } from '../../../design-system/components/InsightCard';
import { useAgent } from '../../../context/AgentContext';
import { getBot } from '../../../services/api';
import { type Bot } from '../../../types/domain';
import { ChannelCard } from './ChannelCard';
import { WebsiteInstall } from './WebsiteInstall';
import { DomainRestrictionsSection } from './DomainRestrictionsSection';
import { SubdomainSessionSection } from './SubdomainSessionSection';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';

/**
 * The full agent record includes channel fields the lightweight list `Bot`
 * omits. `getBot` returns the complete row; we read those extra fields through
 * this local widening of the shared `Bot` type (all optional - the backend may
 * not set them). The Channels tab is Website-only, so only the widget-install
 * and domain fields are read here.
 */
interface ChannelBot extends Bot {
  allowed_domains?: string[] | null;
  domain_check_enabled?: boolean | null;
  session_share_domain?: string | null;
}

/** Skeleton placeholder shown while the agent record loads. */
function ChannelsSkeleton(): ReactElement {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-20 w-full rounded-xl" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}

/**
 * ChannelsPage - the agent's "Channels" tab. Answers one question: *where is my
 * AI connected?* It surfaces the live Website channel with the full install
 * flow (embed snippet, domain allow-list, cross-subdomain sessions). Meetings,
 * Email, and the roadmap channels live in Workspace → Integrations. Data is
 * loaded fresh via `getBot`.
 */
export function ChannelsPage(): ReactElement {
  const { t } = useTranslation();
  const { agent, loading: agentLoading } = useAgent();
  const numericId = agent?.id ?? null;

  // Load token = which agent + which retry. Storing it alongside the result lets
  // us derive loading/error/record during render (never setState-in-effect for
  // derived values) while ignoring responses from a superseded request.
  const [reloadKey, setReloadKey] = useState(0);
  const token = numericId != null ? `${numericId}:${reloadKey}` : null;

  const [fetched, setFetched] = useState<{ token: string; bot: ChannelBot } | null>(null);
  const [failed, setFailed] = useState<{ token: string; message: string } | null>(null);

  useEffect(() => {
    if (numericId == null || token == null) return undefined;
    let cancelled = false;
    getBot(numericId)
      .then((bot) => {
        if (!cancelled) setFetched({ token, bot: bot as ChannelBot });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFailed({
            token,
            message: err instanceof Error ? err.message : translateNow('agents.weCouldntLoadYourChannels') || 'We couldn’t load your channels.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [numericId, token]);

  const record = fetched && fetched.token === token ? fetched.bot : null;
  const loadError = failed && failed.token === token ? failed.message : null;
  const loading = agentLoading || (numericId != null && record == null && loadError == null);

  // ── States: agent missing / loading / error ───────────────────────────────
  const body = (): ReactElement => {
    if (!agentLoading && numericId == null) {
      return (
        <EmptyState
          icon={PlugZap}
          title={t('agents.noChatbotSelected') || 'No chatbot selected'}
          description={t('agents.openAChatbotToSee') || 'Open a chatbot to see where it\'s connected.'}
        />
      );
    }
    if (loading) return <ChannelsSkeleton />;
    if (loadError || !record) {
      return (
        <EmptyState
          icon={PlugZap}
          title={t('agents.couldntLoadChannels') || 'Couldn’t load channels'}
          description={loadError ?? (t('agents.somethingWentWrongPleaseTry') || 'Something went wrong. Please try again.')}
          action={
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
              {t('agents.tryAgain') || 'Try again'}
            </Button>
          }
        />
      );
    }

    // ── Derived channel state ────────────────────────────────────────────────
    const installed = Boolean(record.widget_installed_at);
    const website = record.website;
    const botKey = record.bot_key;

    return (
      <div className="space-y-8">
        {/* Status summary - only the actionable "not live yet" nudge; the
            celebratory "live" card is intentionally omitted. */}
        {!installed && (
          <InsightCard
            tone="warning"
            icon={PlugZap}
            title={t('agents.yourChatbotIsntLiveYet') || 'Your chatbot isn’t live yet'}
            body={t('agents.addTheSnippetBelowTo') || 'Add the snippet below to your website so visitors can start chatting. It takes about a minute.'}
          />
        )}

        {/* Live channels */}
        <section aria-label={t('agents.liveChannels') || 'Live channels'} className="space-y-4">
          <SectionHeader
            title={t('agents.liveChannels') || 'Live channels'}
            description={t('agents.placesYourChatbotCanAnswer') || 'Places your chatbot can answer people today.'}
          />

          {/* Website - the primary channel, with the full install flow */}
          <ChannelCard
            icon={Globe}
            iconTone="accent"
            name="Website"
            description={
              installed
                ? website
                  ? t('agents.embeddedOn', { site: website }) || `Embedded on ${website}.`
                  : t('agents.widgetInstalledOnSite') || 'The chat widget is installed on your site.'
                : t('agents.embedTheChatWidgetTo') || 'Embed the chat widget to go live on your site.'
            }
            status={
              installed ? (
                <StatusBadge tone="success" dot>
                  {t('agents.live') || 'Live'}
                </StatusBadge>
              ) : (
                <StatusBadge tone="warning" dot>
                  {t('agents.notInstalled') || 'Not installed'}
                </StatusBadge>
              )
            }
          >
            {botKey && numericId != null ? (
              <>
                <WebsiteInstall botKey={botKey} botId={numericId} />
                {numericId != null && (
                  <DomainRestrictionsSection
                    key={numericId}
                    botId={numericId}
                    website={website}
                    initialAllowedDomains={record.allowed_domains ?? []}
                    initialDomainCheckEnabled={Boolean(record.domain_check_enabled)}
                    onSaved={(next) =>
                      setFetched((prev) =>
                        prev && prev.token === token ? { token, bot: { ...prev.bot, ...next } } : prev,
                      )
                    }
                  />
                )}
                {numericId != null && (
                  <SubdomainSessionSection
                    key={`session-${numericId}`}
                    botId={numericId}
                    website={website}
                    initialShareDomain={record.session_share_domain ?? null}
                    onSaved={(next) =>
                      setFetched((prev) =>
                        prev && prev.token === token ? { token, bot: { ...prev.bot, ...next } } : prev,
                      )
                    }
                  />
                )}
              </>
            ) : (
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {t('agents.thisChatbotDoesntHaveAn') || 'This chatbot doesn’t have an embed key yet. Finish creating the chatbot to get one.'}
              </p>
            )}
          </ChannelCard>
        </section>
      </div>
    );
  };

  return (
    <PageContainer>
      {body()}
    </PageContainer>
  );
}
