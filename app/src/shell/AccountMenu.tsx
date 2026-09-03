import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HelpCircle, LogOut, MessageSquarePlus, User } from 'lucide-react';
import {
  Avatar,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  cn,
} from '../ui';
import { getCurrentUser } from '../services/api';
import { keys } from '../query/keys';
import { clearAuthStorage } from '../utils/authStorage';
import { useWorkspace } from '../context/WorkspaceContext';
import { useTranslation } from '../i18n/useTranslation';

/**
 * The account menu, anchored at the foot of the rail.
 *
 * `/auth/me` is fetched through the query cache here, not by this component. The
 * app it replaces called that endpoint from ten independent places with no cache
 * between them, so navigating Home → Settings → Members fired it three more
 * times and each surface could show a different answer.
 *
 * It opens to the **right**, like the workspace switcher: a `bottom` menu on a
 * trigger pinned to the bottom of the viewport is collision-flipped every time,
 * and its panel sat flush against the rail's edge with its shadow bleeding onto
 * the canvas.
 *
 * The trigger is a `--spacing-row` identity row, the one deliberate exception to
 * the rail's 36px item height — but it shares the item's 10px inset, so the
 * avatar's left edge lands on the icon column rather than two pixels inside it.
 */
export function AccountMenu({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentWorkspaceName, effectiveRole } = useWorkspace();
  const { data } = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    // The signed-in identity changes about as often as the session does.
    staleTime: 5 * 60_000,
  });

  const name = (data?.name as string | undefined) ?? (data?.email as string | undefined) ?? (t('shell.account') || 'Account');
  const email = data?.email as string | undefined;
  // The trigger already carries the name and the email on two lines, so the
  // menu's group label is the one fact it does not: which seat you hold, where.
  const seat = [effectiveRole, currentWorkspaceName].filter(Boolean).join(' · ');

  function signOut() {
    clearAuthStorage();
    navigate('/login', { replace: true });
  }

  return (
    <MenuRoot>
      <MenuTrigger
        aria-label={t('shell.account') || 'Account'}
        className={cn(
          'flex h-row w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-start',
          'transition-colors duration-[var(--dur-fast)] hover:bg-rail-hover focus-visible:outline-rail-accent',
          collapsed && 'justify-center px-0',
        )}
      >
        <Avatar name={name} src={data?.avatar_url} size="sm" />
        {!collapsed ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-medium text-rail-text">{name}</span>
            {email ? (
              <span className="block truncate text-2xs text-rail-text-muted">{email}</span>
            ) : null}
          </span>
        ) : null}
      </MenuTrigger>

      <MenuContent side="inline-end" align="end" className="w-64">
        {seat ? <p className="px-2 pb-1 pt-1.5 text-2xs text-text-tertiary">{seat}</p> : null}
        <MenuItem icon={<User aria-hidden />} onSelect={() => navigate('/account')}>
          {t('shell.accountSettings') || 'Account settings'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<MessageSquarePlus aria-hidden />}
          onSelect={() =>
            window.open('https://www.oyechats.com/contact', '_blank', 'noopener')
          }
        >
          {t('shell.sendFeedback') || 'Send feedback'}
        </MenuItem>
        <MenuItem
          icon={<HelpCircle aria-hidden />}
          onSelect={() => window.open('https://www.oyechats.com/docs', '_blank', 'noopener')}
        >
          {t('shell.helpAndDocs') || 'Help and docs'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<LogOut aria-hidden />} onSelect={signOut}>
          {t('shell.signOut') || 'Sign out'}
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
