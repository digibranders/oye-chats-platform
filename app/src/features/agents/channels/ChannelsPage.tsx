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

    return (
      <div className="space-y-8">
        {/* Status summary - only the actionable "not live yet" nudge; the
            celebratory "live" card is intentionally omitted. */}
        {!installed && (
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

          {/* Website - the primary channel, with the full install flow */}
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
                This agent doesn’t have an embed key yet. Finish creating the agent to get one.
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
