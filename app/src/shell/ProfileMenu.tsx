import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot as BotIcon, Calendar, LogOut, Mail, Settings } from 'lucide-react';
import { cn, Popover, Skeleton, StatusBadge } from '../design-system';
import { getCurrentUser } from '../services/api';
import { useEntitlements } from '../hooks/useEntitlements';
import { clearAuthStorage, getAuthItem } from '../utils/authStorage';
import { clearTrialBannerDismissals } from '../utils/trialBanner';
import type { CurrentUser } from '../types/domain';

const AVATAR_TRIGGER_SIZE = 36;
const AVATAR_HEADER_SIZE = 40;

/** "Jane Doe" → "JD"; falls back to "?" when no usable name is available. */
function getInitials(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) return '?';
  return trimmed
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** ISO timestamp → "Joined Jul 16, 2026". Returns "—" on missing/bad input. */
function formatJoinedDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface AvatarCircleProps {
  name: string;
  size: number;
  online?: boolean;
}

/** Initials avatar with an optional online-status ring, sized for the trigger or the panel header. */
function AvatarCircle({ name, size, online = false }: AvatarCircleProps) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent)] font-semibold text-[var(--ds-accent-fg)]',
        size >= AVATAR_HEADER_SIZE ? 'text-[14px]' : 'text-[12px]',
      )}
    >
      {getInitials(name)}
      {online && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--ds-bg-surface)] bg-[var(--ds-success)]" />
      )}
    </span>
  );
}

/**
 * ProfileMenu — the account dropdown anchored to the TopBar avatar. Built on
 * the `Popover` primitive so it portals past the header's `backdrop-blur-md`
 * clip. Profile is fetched lazily on first interaction (not re-fetched on
 * every subsequent open) so opening the menu never blocks on a loading
 * spinner after the first time. The plan chip reads `useEntitlements()`
 * instead of its own fetch — `EntitlementsProvider` already loads it once at
 * the app root, so the chip is available immediately with no extra request.
 */
export function ProfileMenu() {
  const navigate = useNavigate();
  const fallbackName = getAuthItem('admin_name') ?? 'Admin';
  const { entitlements, loading: entitlementsLoading } = useEntitlements();
  const planName = entitlementsLoading ? null : entitlements.plan_name;

  const [profile, setProfile] = useState<CurrentUser | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState(false);
  // Guards the profile fetch to "once ever" — reset to false only on failure,
  // so a transient network blip can still recover on the next open rather
  // than permanently freezing the menu on "Profile unavailable".
  const hasFetchedRef = useRef(false);

  const loadProfile = useCallback(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    setProfileLoading(true);
    setProfileError(false);

    void getCurrentUser()
      .then((data) => setProfile(data))
      .catch((error: unknown) => {
        console.error('ProfileMenu: failed to load profile', error);
        setProfileError(true);
        hasFetchedRef.current = false;
      })
      .finally(() => setProfileLoading(false));
  }, []);

  const handleSettings = useCallback(
    (close: () => void) => {
      close();
      navigate('/settings');
    },
    [navigate],
  );

  const handleSignOut = useCallback(
    (close: () => void) => {
      close();
      clearAuthStorage();
      clearTrialBannerDismissals();
      navigate('/login');
    },
    [navigate],
  );

  const displayName = profile?.name || fallbackName;
  const isOnline = Boolean(profile?.is_online);
  const showOperatorRole = profile?.kind === 'operator' && Boolean(profile.role);

  return (
    <Popover
      align="end"
      role="menu"
      panelClassName="w-72"
      trigger={(triggerProps) => (
        <button
          type="button"
          ref={triggerProps.setRef}
          onClick={() => {
            loadProfile();
            triggerProps.onClick();
          }}
          aria-haspopup={triggerProps['aria-haspopup']}
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          aria-label="Account menu"
          className="ml-1 flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-90"
        >
          <AvatarCircle name={displayName} size={AVATAR_TRIGGER_SIZE} online={isOnline} />
        </button>
      )}
    >
      {(close) => (
        <div>
          {/* Identity header */}
          <div className="flex items-center gap-3 border-b border-[var(--ds-border)] px-4 py-4">
            <AvatarCircle name={displayName} size={AVATAR_HEADER_SIZE} online={isOnline} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <p className="min-w-0 truncate text-[14px] font-semibold text-[var(--ds-text)]">
                  {displayName}
                </p>
                {showOperatorRole && (
                  <StatusBadge tone="accent" className="shrink-0 uppercase">
                    {profile?.role}
                  </StatusBadge>
                )}
                {planName && (
                  <StatusBadge tone="neutral" className="shrink-0">
                    {planName} Plan
                  </StatusBadge>
                )}
              </div>
              {isOnline && (
                <p className="mt-0.5 flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-success)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                  Online
                </p>
              )}
              {profileError && !profile && (
                <p className="mt-1 truncate text-[11px] text-[var(--ds-text-subtle)]">
                  Profile unavailable
                </p>
              )}
            </div>
          </div>

          {/* Facts */}
          <div className="space-y-2 border-b border-[var(--ds-border)] px-4 py-3">
            {profileLoading && !profile ? (
              <>
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3.5 w-32" />
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-[12px] text-[var(--ds-text-muted)]">
                  <Mail size={13} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
                  <span className="truncate">{profile?.email ?? '—'}</span>
                </div>
                <div className="flex items-center gap-2 text-[12px] text-[var(--ds-text-muted)]">
                  <BotIcon size={13} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
                  <span>
                    {profile?.bot_count ?? '—'} {profile?.bot_count === 1 ? 'AI Agent' : 'AI Agents'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[12px] text-[var(--ds-text-muted)]">
                  <Calendar size={13} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
                  <span>Joined {formatJoinedDate(profile?.created_at)}</span>
                </div>
              </>
            )}
          </div>

          {/* Actions */}
          <div className="p-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => handleSettings(close)}
              className="flex w-full items-center gap-2 rounded-[var(--ds-radius-md)] px-3 py-2 text-left text-[13px] text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)]"
            >
              <Settings size={14} aria-hidden="true" />
              Settings
            </button>
            <div className="mt-1 border-t border-[var(--ds-border)] pt-1">
              <button
                type="button"
                role="menuitem"
                onClick={() => handleSignOut(close)}
                className="flex w-full items-center gap-2 rounded-[var(--ds-radius-md)] px-3 py-2 text-left text-[13px] font-medium text-[var(--ds-danger)] transition-colors hover:bg-[var(--ds-danger-soft)]"
              >
                <LogOut size={14} aria-hidden="true" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </Popover>
  );
}
