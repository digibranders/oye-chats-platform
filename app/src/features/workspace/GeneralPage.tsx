import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock,
  Globe,
  Lock,
  Pencil,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  IconTile,
  Input,
  Modal,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
} from '../../design-system';
import { getBots, getCurrentUser, updateBot, updateClientProfile } from '../../services/api';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { type Bot, type CurrentUser } from '../../types/domain';
import { BusinessHoursEditor, type BusinessHours } from './BusinessHoursEditor';

// ── Helpers ──────────────────────────────────────────────────────────────────

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// ── Load state machine ───────────────────────────────────────────────────────

type LoadPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly user: CurrentUser; readonly bots: Bot[] };

// ── Small presentational pieces ──────────────────────────────────────────────

interface SettingRowProps {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
}

/** A key/value line inside a workspace card. */
function SettingRow({ icon: Icon, label, value }: SettingRowProps): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
        <Icon size={15} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-[13px] font-medium text-[var(--ds-text)]">
        {value || '-'}
      </span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function GeneralPage(): ReactElement {
  const { currentWorkspaceId, currentWorkspaceName, currentRole, workspaces, refresh: refreshWorkspace } = useWorkspace();
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  const liveChatUnlocked = hasFeature('live_chat');

  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);

  // ── Workspace Details Edit State ─────────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [editWebsite, setEditWebsite] = useState('');
  const [isSavingDetails, setIsSavingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsSuccess, setDetailsSuccess] = useState<string | null>(null);

  // ── Business Hours Modal State ───────────────────────────────────────────
  const [isHoursModalOpen, setIsHoursModalOpen] = useState(false);
  const [hoursDraft, setHoursDraft] = useState<BusinessHours | null>(null);
  const [isSavingHours, setIsSavingHours] = useState(false);
  const [hoursNotice, setHoursNotice] = useState<string | null>(null);

  // Load user data and workspace bots
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [user, bots] = await Promise.all([
          getCurrentUser(),
          getBots().catch(() => [] as Bot[]),
        ]);
        if (!active) return;
        setPhase({ status: 'ready', user, bots });
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
  const bots = phase.status === 'ready' ? phase.bots : [];
  const primaryBot = bots[0] ?? null;

  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentWorkspaceId);
  const agentCount = currentWorkspace?.bot_count ?? user?.bot_count ?? 0;
  const roleTone = currentRole === 'owner' ? 'accent' : currentRole === 'admin' ? 'info' : 'neutral';

  // Start editing workspace identity
  const handleStartEdit = (): void => {
    if (!user) return;
    setEditName(currentWorkspaceName ?? user.name ?? '');
    setEditCompany(user.company_name ?? '');
    setEditWebsite(user.website ?? '');
    setDetailsError(null);
    setDetailsSuccess(null);
    setIsEditing(true);
  };

  // Save workspace identity
  const handleSaveDetails = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!user) return;

    const trimmedName = editName.trim();
    if (!trimmedName) {
      setDetailsError('Workspace name cannot be empty.');
      return;
    }

    setIsSavingDetails(true);
    setDetailsError(null);
    setDetailsSuccess(null);

    try {
      const updated = await updateClientProfile({
        name: trimmedName,
        company_name: editCompany.trim() || undefined,
        website: editWebsite.trim() || undefined,
      });

      // Update local phase user state
      setPhase((prev) => {
        if (prev.status !== 'ready') return prev;
        return {
          ...prev,
          user: {
            ...prev.user,
            name: updated.name,
            company_name: updated.company_name ?? null,
            website: updated.website ?? null,
          },
        };
      });

      // Refresh workspace context across topbar and app shell
      void refreshWorkspace();

      setDetailsSuccess('Workspace details updated successfully!');
      setIsEditing(false);
    } catch (error) {
      setDetailsError(toMessage(error, 'Failed to update workspace details. Please try again.'));
    } finally {
      setIsSavingDetails(false);
    }
  };

  // Open Business Hours editor modal
  const handleOpenHoursModal = (): void => {
    const hours = (primaryBot?.business_hours as unknown as BusinessHours | null) ?? null;
    setHoursDraft(hours);
    setHoursNotice(null);
    setIsHoursModalOpen(true);
  };

  // Save Business Hours
  const handleSaveHours = async (): Promise<void> => {
    if (!primaryBot || !hoursDraft) return;

    setIsSavingHours(true);
    try {
      await updateBot(primaryBot.id, { business_hours: hoursDraft as unknown as Record<string, unknown> });
      setPhase((prev) => {
        if (prev.status !== 'ready') return prev;
        const updatedBots = prev.bots.map((b) =>
          b.id === primaryBot.id ? { ...b, business_hours: hoursDraft as unknown as Record<string, unknown> } : b,
        );
        return { ...prev, bots: updatedBots };
      });
      setHoursNotice('Business hours updated successfully.');
      setIsHoursModalOpen(false);
    } catch (error) {
      setHoursNotice(toMessage(error, 'Failed to update business hours.'));
    } finally {
      setIsSavingHours(false);
    }
  };

  const primaryBotHours = primaryBot?.business_hours as unknown as BusinessHours | null;

  return (
    <PageContainer>
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
          {detailsSuccess && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--ds-accent-soft)] bg-[var(--ds-accent-soft)]/20 p-3 text-[13px] font-medium text-[var(--ds-accent-text)]">
              <CheckCircle2 size={16} className="shrink-0" />
              {detailsSuccess}
            </div>
          )}

          {/* ── Workspace identity ──────────────────────────────────────── */}
          <section aria-labelledby="workspace-identity-heading" className="space-y-4">
            <SectionHeader
              title={<span id="workspace-identity-heading">Workspace</span>}
              description="The account these agents, conversations, and billing belong to."
              actions={
                !isEditing ? (
                  <Button variant="outline" size="sm" onClick={handleStartEdit}>
                    <Pencil size={14} className="mr-1.5" />
                    Edit details
                  </Button>
                ) : undefined
              }
            />

            <Card className="p-6">
              {!isEditing ? (
                <>
                  <div className="flex items-center gap-4">
                    <IconTile icon={Building2} tone="accent" size="lg" />
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
                </>
              ) : (
                <form onSubmit={(e) => void handleSaveDetails(e)} className="space-y-4">
                  <div className="flex items-center justify-between pb-2 border-b border-[var(--ds-border)]">
                    <h3 className="text-[14px] font-semibold text-[var(--ds-text)]">Edit workspace details</h3>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsEditing(false)}
                      aria-label="Cancel editing"
                    >
                      <X size={16} />
                    </Button>
                  </div>

                  {detailsError && (
                    <div className="rounded-lg bg-[var(--ds-danger-soft)] p-3 text-[13px] text-[var(--ds-danger-text)]">
                      {detailsError}
                    </div>
                  )}

                  <div className="space-y-3">
                    <div>
                      <label className="block text-[13px] font-medium text-[var(--ds-text)] mb-1">
                        Workspace Name *
                      </label>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="e.g. Acme Support Workspace"
                        required
                      />
                    </div>

                    <div>
                      <label className="block text-[13px] font-medium text-[var(--ds-text)] mb-1">
                        Company Name
                      </label>
                      <Input
                        value={editCompany}
                        onChange={(e) => setEditCompany(e.target.value)}
                        placeholder="e.g. Acme Corporation"
                      />
                    </div>

                    <div>
                      <label className="block text-[13px] font-medium text-[var(--ds-text)] mb-1">
                        Website URL
                      </label>
                      <Input
                        type="url"
                        value={editWebsite}
                        onChange={(e) => setEditWebsite(e.target.value)}
                        placeholder="https://example.com"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--ds-border)]">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsEditing(false)}
                      disabled={isSavingDetails}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" disabled={isSavingDetails}>
                      {isSavingDetails ? 'Saving...' : 'Save changes'}
                    </Button>
                  </div>
                </form>
              )}
            </Card>
          </section>

          {/* ── Agent defaults ─────────────────────────────────────────────── */}
          <section aria-labelledby="defaults-heading" className="space-y-4">
            <SectionHeader
              title={<span id="defaults-heading">Agent defaults</span>}
              description="Workspace-wide defaults that new agents start from. Each agent can override these."
            />

            {/* Business hours default configuration */}
            <Card className="p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ds-text)]">
                    <Clock
                      size={16}
                      aria-hidden="true"
                      className={
                        liveChatUnlocked
                          ? 'text-[var(--ds-accent-text)]'
                          : 'text-[var(--ds-text-subtle)]'
                      }
                    />
                    Business hours
                    {!liveChatUnlocked && (
                      <Lock
                        size={12}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className="text-[var(--ds-text-subtle)]"
                      />
                    )}
                  </p>
                  <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
                    Business hours decide when live chat shows as available and when visitors see the offline form.
                  </p>
                </div>
                {liveChatUnlocked ? (
                  <Button variant="outline" size="sm" onClick={handleOpenHoursModal} className="shrink-0">
                    Configure schedule
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openUpgradeModal('live_chat')}
                    className="shrink-0"
                  >
                    <Lock size={12} strokeWidth={1.75} aria-hidden="true" />
                    Upgrade to configure
                  </Button>
                )}
              </div>

              {hoursNotice && liveChatUnlocked && (
                <p className="mt-3 text-[12px] text-[var(--ds-accent-text)]">{hoursNotice}</p>
              )}

              <div className="mt-4 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-3 text-[13px] text-[var(--ds-text-muted)] flex items-center justify-between">
                <span>
                  Schedule status:{' '}
                  <strong className="text-[var(--ds-text)]">
                    {!liveChatUnlocked
                      ? 'Not available on Free'
                      : primaryBotHours && primaryBotHours.enabled
                        ? `Active (${primaryBotHours.timezone || 'UTC'})`
                        : 'Always available (24/7)'}
                  </strong>
                </span>
                <StatusBadge
                  tone={
                    !liveChatUnlocked
                      ? 'neutral'
                      : primaryBotHours && primaryBotHours.enabled
                        ? 'accent'
                        : 'neutral'
                  }
                >
                  {!liveChatUnlocked
                    ? 'Locked'
                    : primaryBotHours && primaryBotHours.enabled
                      ? 'Schedule Active'
                      : '24/7 Mode'}
                </StatusBadge>
              </div>
            </Card>
          </section>

          {/* Business Hours Modal */}
          <Modal
            open={isHoursModalOpen}
            onClose={() => setIsHoursModalOpen(false)}
            title="Configure Business Hours"
          >
            <div className="space-y-4">
              <BusinessHoursEditor
                value={hoursDraft}
                onChange={(next) => setHoursDraft(next)}
              />
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-[var(--ds-border)]">
                <Button variant="ghost" size="sm" onClick={() => setIsHoursModalOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void handleSaveHours()} disabled={isSavingHours}>
                  {isSavingHours ? 'Saving...' : 'Save schedule'}
                </Button>
              </div>
            </div>
          </Modal>
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
