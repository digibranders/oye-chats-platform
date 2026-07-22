import { useEffect, useState, type ReactElement } from 'react';
import { Calendar, Globe, Inbox, Lock, Mail, PlugZap } from 'lucide-react';
import {
  Button,
  EmptyState,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
} from '../../../design-system';
import { InsightCard } from '../../../design-system/components/InsightCard';
import { QuickAction } from '../../../design-system/components/QuickAction';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { useUpgradeModal } from '../../../context/UpgradeModalContext';
import { getBot, updateBot } from '../../../services/api';
import { type Bot } from '../../../types/domain';
import { ChannelCard } from './ChannelCard';
import { WebsiteInstall } from './WebsiteInstall';
import { DomainRestrictionsSection } from './DomainRestrictionsSection';
import { COMING_SOON_CHANNELS } from './channels.data';

/**
 * The full agent record includes channel fields the lightweight list `Bot`
 * omits. `getBot` returns the complete row; we read those extra fields through
 * this local widening of the shared `Bot` type (all optional — the backend may
 * not set them). See `pages/Integrations.jsx` for the source of truth on these
 * meeting fields.
 */
interface ChannelBot extends Bot {
  meeting_booking_enabled?: boolean;
  meeting_provider?: string | null;
  calendly_url?: string | null;
  zcal_url?: string | null;
  calcom_url?: string | null;
  notification_emails?: { default?: string[] } | null;
  allowed_domains?: string[] | null;
  domain_check_enabled?: boolean | null;
}

const MEETING_PROVIDER_LABELS: Record<string, string> = {
  calendly: 'Calendly',
  zcal: 'Zcal',
  calcom: 'Cal.com',
};

function meetingUrlOf(bot: ChannelBot): string {
  return bot.calendly_url || bot.zcal_url || bot.calcom_url || '';
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
 * ChannelsPage — the agent's "Channels" tab. Answers one question: *where is my
 * AI connected?* It surfaces the live Website channel (with the full install
 * flow), the Meetings and Email channels, and the roadmap of channels still to
 * come. Data is loaded fresh via `getBot`; the Meetings channel can be toggled
 * with `updateBot`.
 */
export function ChannelsPage(): ReactElement {
  const { agent, loading: agentLoading } = useAgent();
  const { entitlements } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  const premiumIntegrationsLocked = entitlements.features.integrations !== 'all';
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
            message: err instanceof Error ? err.message : 'We couldn’t load your channels.',
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

  // ── Meetings channel write (updateBot) ────────────────────────────────────
  const [savingMeetings, setSavingMeetings] = useState(false);
  const [meetingsError, setMeetingsError] = useState<string | null>(null);

  const setMeetingsEnabled = async (next: boolean): Promise<void> => {
    if (numericId == null || token == null) return;
    setSavingMeetings(true);
    setMeetingsError(null);
    try {
      // PATCH /bots/{id} returns { message }, NOT the bot — so merge the single
      // changed field into the current record instead of overwriting it (which
      // would blank out bot_key, website, install status, etc.).
      await updateBot(numericId, { meeting_booking_enabled: next });
      setFetched((prev) =>
        prev && prev.token === token
          ? { token, bot: { ...prev.bot, meeting_booking_enabled: next } }
          : prev,
      );
    } catch (err: unknown) {
      setMeetingsError(err instanceof Error ? err.message : 'Couldn’t save. Please try again.');
    } finally {
      setSavingMeetings(false);
    }
  };

  // ── States: agent missing / loading / error ───────────────────────────────
  const body = (): ReactElement => {
    if (!agentLoading && numericId == null) {
      return (
        <EmptyState
          icon={PlugZap}
          title="No agent selected"
          description="Open an agent to see where it's connected."
        />
      );
    }
    if (loading) return <ChannelsSkeleton />;
    if (loadError || !record) {
      return (
        <EmptyState
          icon={PlugZap}
          title="Couldn’t load channels"
          description={loadError ?? 'Something went wrong. Please try again.'}
          action={
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </Button>
          }
        />
      );
    }

    // ── Derived channel state ────────────────────────────────────────────────
    const installed = Boolean(record.widget_installed_at);
    const website = record.website;
    const botKey = record.bot_key;

    const meetingUrl = meetingUrlOf(record);
    const meetingsConfigured = Boolean(meetingUrl);
    const meetingsOn = Boolean(record.meeting_booking_enabled);
    const providerLabel = record.meeting_provider
      ? (MEETING_PROVIDER_LABELS[record.meeting_provider] ?? 'your scheduler')
      : 'your scheduler';

    const notifyCount = record.notification_emails?.default?.length ?? 0;

    return (
      <div className="space-y-8">
        {/* Status summary */}
        {installed ? (
          <InsightCard
            tone="success"
            icon={Globe}
            title="Your agent is live on your website"
            body={
              website
                ? `Visitors on ${website} can chat with your agent right now.`
                : 'Visitors can chat with your agent on your website right now.'
            }
          />
        ) : (
          <InsightCard
            tone="warning"
            icon={PlugZap}
            title="Your agent isn’t live yet"
            body="Add the snippet below to your website so visitors can start chatting. It takes about a minute."
          />
        )}

        {/* Live channels */}
        <section aria-label="Live channels" className="space-y-4">
          <SectionHeader
            title="Live channels"
            description="Places your agent can answer people today."
          />

          {/* Website — the primary channel, with the full install flow */}
          <ChannelCard
            icon={Globe}
            iconTone="accent"
            name="Website"
            description={
              installed
                ? website
                  ? `Embedded on ${website}.`
                  : 'The chat widget is installed on your site.'
                : 'Embed the chat widget to go live on your site.'
            }
            status={
              installed ? (
                <StatusBadge tone="success" dot>
                  Live
                </StatusBadge>
              ) : (
                <StatusBadge tone="warning" dot>
                  Not installed
                </StatusBadge>
              )
            }
          >
            {botKey ? (
              <>
                <WebsiteInstall botKey={botKey} />
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
              </>
            ) : (
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                This agent doesn’t have an embed key yet. Finish creating the agent to get one.
              </p>
            )}
          </ChannelCard>

          {/* Meetings — bookings inside the chat. Requires the paid `integrations: 'all'` tier. */}
          <ChannelCard
            icon={premiumIntegrationsLocked ? Lock : Calendar}
            iconTone={premiumIntegrationsLocked ? 'neutral' : 'info'}
            name="Meetings"
            description={
              premiumIntegrationsLocked
                ? 'Let visitors book a meeting without leaving the conversation. Available on paid plans.'
                : meetingsOn && meetingsConfigured
                  ? `Visitors can book time via ${providerLabel} right inside the chat.`
                  : 'Let visitors book a meeting without leaving the conversation.'
            }
            status={
              premiumIntegrationsLocked ? (
                <StatusBadge tone="neutral">
                  <Lock size={11} aria-hidden="true" />
                  Locked
                </StatusBadge>
              ) : meetingsOn && meetingsConfigured ? (
                <StatusBadge tone="success" dot>
                  Active
                </StatusBadge>
              ) : meetingsConfigured ? (
                <StatusBadge tone="neutral">Off</StatusBadge>
              ) : (
                <StatusBadge tone="neutral">Not set up</StatusBadge>
              )
            }
            action={
              premiumIntegrationsLocked ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openUpgradeModal('meetings_integration')}
                >
                  <Lock size={13} aria-hidden="true" />
                  Upgrade to connect
                </Button>
              ) : meetingsConfigured ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant={meetingsOn ? 'outline' : 'primary'}
                    size="sm"
                    disabled={savingMeetings}
                    onClick={() => void setMeetingsEnabled(!meetingsOn)}
                  >
                    {savingMeetings
                      ? 'Saving…'
                      : meetingsOn
                        ? 'Turn off'
                        : 'Turn on'}
                  </Button>
                  {meetingsError ? (
                    <span role="alert" className="text-[12px] text-[var(--ds-danger)]">
                      {meetingsError}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-[12px] text-[var(--ds-text-subtle)]">
                    Add a scheduling link to turn this on.
                  </p>
                  <QuickAction
                    icon={Calendar}
                    label="Set up in Integrations"
                    to="/workspace/integrations"
                  />
                </div>
              )
            }
          />

          {/* Email — always-on fallback capture */}
          <ChannelCard
            icon={Mail}
            iconTone="success"
            name="Email"
            description="When no one’s available, visitors leave a message and it lands in your inbox."
            status={
              notifyCount > 0 ? (
                <StatusBadge tone="success" dot>
                  Active
                </StatusBadge>
              ) : (
                <StatusBadge tone="warning" dot>
                  Needs setup
                </StatusBadge>
              )
            }
            action={
              <div className="flex flex-col gap-2">
                <p className="text-[12px] text-[var(--ds-text-subtle)]">
                  {notifyCount > 0
                    ? `Notifications go to ${notifyCount} address${notifyCount === 1 ? '' : 'es'}.`
                    : 'Add notification recipients so you never miss a message.'}
                </p>
                <QuickAction icon={Inbox} label="Open inbox" to="/inbox" />
              </div>
            }
          />
        </section>

        {/* Roadmap channels */}
        <section aria-label="More channels" className="space-y-4">
          <SectionHeader
            title="More channels"
            description="We’re bringing your agent to more places soon."
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {COMING_SOON_CHANNELS.map((channel) => (
              <ChannelCard
                key={channel.id}
                icon={channel.icon}
                iconTone="neutral"
                name={channel.name}
                description={channel.description}
                status={<StatusBadge tone="neutral">Coming soon</StatusBadge>}
              />
            ))}
          </div>
        </section>
      </div>
    );
  };

  return (
    <PageContainer
      title="Channels"
      description="Where your AI agent is connected and talking to people."
    >
      {body()}
    </PageContainer>
  );
}
