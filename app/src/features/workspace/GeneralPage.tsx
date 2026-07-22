import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { AlertTriangle, Building2, Clock, Globe, Info, Sparkles, type LucideIcon } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  InsightCard,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
} from '../../design-system';
import { getCurrentUser } from '../../services/api';
import { useWorkspace } from '../../context/WorkspaceContext';
import { type CurrentUser } from '../../types/domain';

// ── Helpers ──────────────────────────────────────────────────────────────────

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// ── Load state machine ───────────────────────────────────────────────────────

type LoadPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly user: CurrentUser };

// ── Small presentational pieces ──────────────────────────────────────────────

interface SettingRowProps {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
}

/** A read-only key/value line inside a workspace card. */
function SettingRow({ icon: Icon, label, value }: SettingRowProps): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
        <Icon size={15} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-[13px] font-medium text-[var(--ds-text)]">
        {value || '—'}
      </span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * GeneralPage — the Workspace ▸ General surface. One job: answer "How is
 * this workspace set up?" — the shared identity (name, company, website,
 * role) and the agent-wide defaults new agents inherit. Moved here from the
 * old Settings page, which is now account/profile-only (see
 * `../settings/SettingsPage`).
 *
 * Company and website are read-only: `PATCH /client/profile` only accepts
 * `name` today, so editing them is out of scope until the backend grows a
 * field for it — the card says so honestly rather than wiring a dead form.
 * Business-hours default and the branding footer are the same faithful
 * scaffolds that lived on Settings: the backend surfaces those per-agent
 * today, so this explains where the setting actually lives.
 */
export function GeneralPage(): ReactElement {
  const { currentWorkspaceId, currentWorkspaceName, currentRole, workspaces } = useWorkspace();

  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);

  // Load / reload. No synchronous setState in the effect body — the first
  // setState always follows an await, so `loading` is a genuine derived phase.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const user = await getCurrentUser();
        if (!active) return;
        setPhase({ status: 'ready', user });
      } catch (error) {
        if (!active) return;
        setPhase({
          status: 'error',
          message: toMessage(error, 'We couldn’t load your workspace. Please try again.'),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshToken]);

  const retry = (): void => {
    setPhase({ status: 'loading' });
    setRefreshToken((token) => token + 1);
  };

  const user = phase.status === 'ready' ? phase.user : null;
  // Agent count is scoped to the workspace the card actually names — not a
  // cross-workspace total. Fall back to the account's own bot_count (then 0)
  // only when the active workspace can't be resolved.
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentWorkspaceId);
  const agentCount = currentWorkspace?.bot_count ?? user?.bot_count ?? 0;

  const roleTone = currentRole === 'owner' ? 'accent' : currentRole === 'admin' ? 'info' : 'neutral';

  return (
    <PageContainer
      title="General"
      description="How this workspace is set up — shared identity and the defaults new agents inherit."
    >
      {phase.status === 'loading' && <LoadingState />}

      {phase.status === 'error' && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load your workspace"
          description={phase.message}
          action={<Button onClick={retry}>Try again</Button>}
        />
      )}

      {phase.status === 'ready' && user && (
        <>
          {/* ── Workspace identity ──────────────────────────────────────── */}
          <section aria-labelledby="workspace-identity-heading" className="space-y-4">
            <SectionHeader
              title={<span id="workspace-identity-heading">Workspace</span>}
              description="The account these agents, conversations, and billing belong to."
            />
            <Card className="p-6">
              <div className="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]"
                >
                  <Building2 size={22} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-[var(--ds-text)]">
                    {currentWorkspaceName ?? user.company_name ?? user.name ?? 'Your workspace'}
                  </p>
                  <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
                    {agentCount} agent{agentCount === 1 ? '' : 's'} in this workspace
                  </p>
                </div>
                {currentRole && (
                  <StatusBadge tone={roleTone} className="shrink-0 capitalize">
                    {currentRole}
                  </StatusBadge>
                )}
              </div>
              <div className="mt-4 divide-y divide-[var(--ds-border)] border-t border-[var(--ds-border)]">
                <SettingRow icon={Building2} label="Company" value={user.company_name} />
                <SettingRow icon={Globe} label="Website" value={user.website} />
              </div>
              <p className="mt-4 flex items-center gap-1.5 text-[12px] text-[var(--ds-text-muted)]">
                <Info size={13} aria-hidden="true" />
                Editing company details is coming soon.
              </p>
            </Card>
          </section>

          {/* ── Agent defaults (faithful scaffolds) ─────────────────────── */}
          <section aria-labelledby="defaults-heading" className="space-y-4">
            <SectionHeader
              title={<span id="defaults-heading">Agent defaults</span>}
              description="Workspace-wide defaults that new agents start from. Each agent can override these."
            />

            {/* Business hours — set per-agent today; workspace default is a TODO. */}
            <InsightCard
              icon={Clock}
              tone="neutral"
              title="Business hours"
              body="Business hours decide when live chat shows as available and when visitors see the offline form. Today they’re configured on each agent under Experience. A shared workspace default is coming so new agents inherit your hours automatically."
            />

            {/* Branding footer — plan/agent-gated; workspace toggle is a TODO. */}
            <Card className="p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ds-text)]">
                    <Sparkles size={16} aria-hidden="true" className="text-[var(--ds-accent-text)]" />
                    Branding footer
                  </p>
                  <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
                    The small “Powered by OyeChats” line shown under the chat widget. Removing it is
                    available on eligible plans and is applied per agent.
                  </p>
                </div>
                <StatusBadge tone="info" className="shrink-0">
                  Managed per agent
                </StatusBadge>
              </div>
              <div className="mt-4 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3 py-2 text-center text-[12px] text-[var(--ds-text-subtle)]">
                ⚡ Powered by OyeChats
              </div>
            </Card>
          </section>
        </>
      )}
    </PageContainer>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-6 w-40 rounded-lg" />
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-6 w-40 rounded-lg" />
      <Skeleton className="h-36 w-full rounded-xl" />
    </div>
  );
}
