import { type FormEvent, type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { AlertTriangle, Check, Mail, Pencil, UserRound, type LucideIcon } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  FeedbackBanner,
  Input,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
  useFeedback,
} from '../../design-system';
import { getCurrentUser, updateClientProfile } from '../../services/api';
import { type CurrentUser } from '../../types/domain';
import { ChangeEmailCard, ChangePasswordCard } from './AccountSecuritySection';
import { AccountSessionsSection } from './AccountSessionsSection';
import { AppearanceSection } from './AppearanceSection';
import { ContactSection } from './ContactSection';
import { NotificationsSection } from './NotificationsSection';

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
        {value || '-'}
      </span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * SettingsPage - the top-level Settings surface. One job: answer "How is MY
 * account set up?" - profile, appearance, and sign-in security. This is the
 * account/profile page, not the org one: workspace identity (company,
 * website, agent count) and agent-wide defaults live on
 * Workspace ▸ General instead (see `../workspace/GeneralPage`).
 *
 * Loads once from `/auth/me` and holds the single source of truth for the
 * signed-in user; the name edit (`updateClientProfile`) and the email change
 * flow inside `AccountSecuritySection` both write back into this same
 * `phase.user` so the profile card above never goes stale.
 */
export function SettingsPage(): ReactElement {
  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);
  const { feedback, notify, dismiss } = useFeedback();

  // Name editing
  const [nameEditing, setNameEditing] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Load / reload. No synchronous setState in the effect body - the first
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
          message: toMessage(error, 'We couldn’t load your account settings. Please try again.'),
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

  const startNameEditing = (): void => {
    setName(user?.name ?? '');
    setNameError('');
    // Clear any banner from a previous save so it can't linger next to a fresh edit.
    dismiss();
    setNameEditing(true);
  };

  const cancelNameEditing = (): void => {
    setNameEditing(false);
    dismiss();
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
      notify({ tone: 'success', message: 'Your name has been updated.' });
    } catch (error) {
      setNameError(toMessage(error, 'Failed to update your name.'));
    } finally {
      setSavingName(false);
    }
  };

  /** Keeps the profile card's email row in sync with AccountSecuritySection's change-email flow. */
  const handleEmailChange = (patch: { email?: string; pending_email?: string | null }): void => {
    setPhase((current) =>
      current.status === 'ready' ? { status: 'ready', user: { ...current.user, ...patch } } : current,
    );
  };

  return (
    <PageContainer title="Settings" description="Your account, profile and sign-in security.">
      {/* Live feedback for the name mutation. */}
      <FeedbackBanner feedback={feedback} onDismiss={dismiss} />

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
          {/* ── Profile ─────────────────────────────────────────────────── */}
          <section aria-labelledby="profile-heading" className="space-y-4">
            <SectionHeader
              title={<span id="profile-heading">Your profile</span>}
              description="Your identity, sign-in email, and password."
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
                <SettingRow icon={UserRound} label="Name" value={user.name} />
              )}
            </Card>

            {user.kind === 'operator' ? (
              <Card>
                <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ds-text)]">
                      <Mail size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
                      Email address
                    </p>
                    <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">
                      Contact your workspace owner to change your email - operator accounts don’t have a
                      self-serve email change today.
                    </p>
                  </div>
                  <StatusBadge tone="neutral" className="shrink-0">
                    Not available
                  </StatusBadge>
                </div>
              </Card>
            ) : (
              <ChangeEmailCard user={user} onEmailChange={handleEmailChange} />
            )}

            <ChangePasswordCard isOperator={user.kind === 'operator'} />
          </section>

          {/* ── Appearance ──────────────────────────────────────────────── */}
          <AppearanceSection />

          {/* ── Notifications (browser web-push + install-as-app) ─────────── */}
          <NotificationsSection />

          {/* ── Sessions + two-factor (moved here from Workspace ▸ Security) ── */}
          <AccountSessionsSection email={user.email ?? ''} />

          {/* ── Need something custom? ───────────────────────────────────── */}
          <ContactSection />
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
