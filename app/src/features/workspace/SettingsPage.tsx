import { type FormEvent, type ReactElement, type ReactNode, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Check,
  Clock,
  Globe,
  Mail,
  Pencil,
  Shield,
  Sparkles,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  InsightCard,
  Input,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
  cn,
} from '../../design-system';
import { getCurrentUser, updateClientProfile } from '../../services/api';
import { useWorkspace } from '../../context/WorkspaceContext';
import { type CurrentUser } from '../../types/domain';

// ── Helpers ──────────────────────────────────────────────────────────────────

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

const labelClass = 'mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]';

// ── Load state machine ───────────────────────────────────────────────────────

type LoadPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly user: CurrentUser };

type Feedback = { readonly tone: 'success' | 'error'; readonly message: string };

// ── Small presentational pieces ──────────────────────────────────────────────

interface SettingRowProps {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
}

/** A read-only key/value line inside a settings card. */
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
 * SettingsPage — the Workspace ▸ Settings surface. One job: answer
 * "How is my workspace configured?".
 *
 * The account owner's name is the single wired mutation here: it loads from
 * `/auth/me` and saves through `updateClientProfile`. Workspace identity
 * (name, role, agents) is shown read-only from the workspace context.
 * Business-hours default and the branding footer are faithful scaffolds — the
 * backend surfaces those per-agent today, so they explain where the setting
 * lives and are marked for workspace-level wiring later (see the manifest TODOs).
 */
export function SettingsPage(): ReactElement {
  const { currentWorkspaceId, currentWorkspaceName, currentRole, workspaces } = useWorkspace();

  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Name editing
  const [nameEditing, setNameEditing] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [savingName, setSavingName] = useState(false);

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
          message: toMessage(error, 'We couldn’t load your workspace settings. Please try again.'),
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

  const startNameEditing = (): void => {
    setName(user?.name ?? '');
    setNameError('');
    // Clear any banner from a previous save so it can't linger next to a fresh edit.
    setFeedback(null);
    setNameEditing(true);
  };

  const cancelNameEditing = (): void => {
    setNameEditing(false);
    setFeedback(null);
  };

  const handleSaveName = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Your name can’t be empty.');
      return;
    }
    if (trimmed === (user?.name ?? '')) {
      setNameEditing(false);
      return;
    }
    setSavingName(true);
    setNameError('');
    try {
      const updated = await updateClientProfile({ name: trimmed });
      setPhase((current) =>
        current.status === 'ready'
          ? { status: 'ready', user: { ...current.user, name: updated.name } }
          : current,
      );
      setNameEditing(false);
      setFeedback({ tone: 'success', message: 'Your name has been updated.' });
    } catch (error) {
      setNameError(toMessage(error, 'Failed to update your name.'));
    } finally {
      setSavingName(false);
    }
  };

  const roleTone = currentRole === 'owner' ? 'accent' : currentRole === 'admin' ? 'info' : 'neutral';

  return (
    <PageContainer
      title="Workspace settings"
      description="How this workspace is set up — your account details and the defaults new agents inherit."
    >
      {/* Live feedback for the name mutation. The region stays mounted (even
          when empty) so screen readers announce content as it appears. */}
      <div aria-live="polite">
        {feedback && (
          <div
            className={cn(
              'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-[13px]',
              feedback.tone === 'success'
                ? 'border-[var(--ds-success)] bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
                : 'border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]',
            )}
          >
            <span>{feedback.message}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              aria-label="Dismiss message"
              className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {phase.status === 'loading' && <LoadingState />}

      {phase.status === 'error' && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load your settings"
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
            </Card>
          </section>

          {/* ── Profile ─────────────────────────────────────────────────── */}
          <section aria-labelledby="profile-heading" className="space-y-4">
            <SectionHeader
              title={<span id="profile-heading">Your profile</span>}
              description="How you appear to teammates in this workspace."
              actions={
                !nameEditing ? (
                  <Button variant="outline" size="sm" onClick={startNameEditing}>
                    <Pencil size={14} aria-hidden="true" />
                    Edit name
                  </Button>
                ) : undefined
              }
            />
            <Card className="p-6">
              {nameEditing ? (
                <form onSubmit={handleSaveName} className="space-y-4">
                  {nameError && (
                    <div
                      role="alert"
                      className="rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2 text-[13px] text-[var(--ds-danger)]"
                    >
                      {nameError}
                    </div>
                  )}
                  <div>
                    <label htmlFor="profile-name" className={labelClass}>
                      Your name
                    </label>
                    <Input
                      id="profile-name"
                      autoFocus
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. Priya Sharma"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="submit" disabled={savingName}>
                      {savingName ? (
                        'Saving…'
                      ) : (
                        <>
                          <Check size={16} aria-hidden="true" />
                          Save changes
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={savingName}
                      onClick={cancelNameEditing}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="divide-y divide-[var(--ds-border)]">
                  <SettingRow icon={UserRound} label="Name" value={user.name} />
                  <SettingRow icon={Mail} label="Email" value={user.email} />
                </div>
              )}
              {!nameEditing && (
                <p className="mt-4 flex items-center gap-1.5 text-[12px] text-[var(--ds-text-muted)]">
                  <Shield size={13} aria-hidden="true" />
                  Changing your email is a separate, verified step in Security.
                </p>
              )}
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
