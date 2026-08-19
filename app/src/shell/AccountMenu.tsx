import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HelpCircle, LogOut, MessageSquarePlus, Settings, User } from 'lucide-react';
import {
  Avatar,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  cn,
} from '../ui';
import { getCurrentUser } from '../services/api';
import { keys } from '../query/keys';
import { clearAuthStorage } from '../utils/authStorage';

/**
 * The account menu, anchored at the foot of the rail.
 *
 * `/auth/me` is fetched through the query cache here, not by this component. The
 * app it replaces called that endpoint from ten independent places with no cache
 * between them, so navigating Home → Settings → Members fired it three more
 * times and each surface could show a different answer.
 */
export function AccountMenu({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    // The signed-in identity changes about as often as the session does.
    staleTime: 5 * 60_000,
  });

  const name = (data?.name as string | undefined) ?? (data?.email as string | undefined) ?? 'Account';
  const email = data?.email as string | undefined;

  function signOut() {
    clearAuthStorage();
    navigate('/login', { replace: true });
  }

  return (
    <MenuRoot>
      <MenuTrigger
        aria-label="Account"
        className={cn(
          'flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
          'transition-colors duration-[var(--dur-fast)] hover:bg-rail-hover',
          collapsed && 'justify-center px-0',
        )}
      >
        <Avatar name={name} size="sm" />
        {!collapsed ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-rail-text">{name}</span>
            {email ? (
              <span className="block truncate text-2xs text-rail-text-muted">{email}</span>
            ) : null}
          </span>
        ) : null}
      </MenuTrigger>

      <MenuContent align="start" className="w-60">
        <MenuLabel>{email ?? 'Signed in'}</MenuLabel>
        <MenuItem icon={<User aria-hidden className="h-3.5 w-3.5" />} onSelect={() => navigate('/account')}>
          Your profile
        </MenuItem>
        <MenuItem
          icon={<Settings aria-hidden className="h-3.5 w-3.5" />}
          onSelect={() => navigate('/account/preferences')}
        >
          Preferences
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<MessageSquarePlus aria-hidden className="h-3.5 w-3.5" />}
          onSelect={() => navigate('/feedback')}
        >
          Send feedback
        </MenuItem>
        <MenuItem
          icon={<HelpCircle aria-hidden className="h-3.5 w-3.5" />}
          onSelect={() => window.open('https://www.oyechats.com/docs', '_blank', 'noopener')}
        >
          Help and docs
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<LogOut aria-hidden className="h-3.5 w-3.5" />} onSelect={signOut}>
          Sign out
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
