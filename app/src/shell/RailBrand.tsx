
import { useTranslation } from '../i18n/useTranslation';/**
 * The brand mark at the top of the expanded rail.
 *
 * Static, deliberately. This used to be a menu — `WorkspaceSwitcher` — showing
 * the current workspace's name beside a small mark, with "Workspace settings",
 * "Invite people" and a workspace list behind it. For the common solo account
 * that name is the same word the account menu at the bottom of the rail
 * already shows next to the person's own name and email, so removing the menu
 * and printing the full wordmark here instead stops the same identity being
 * stated twice, one static, one interactive, forty-eight pixels apart.
 *
 * "Workspace settings" and "Invite people" are still one click away, from the
 * account menu's own path into `/settings/workspace` and `/settings/team` —
 * this was a shortcut to them, not their only address. Switching between
 * workspaces, for the accounts that have more than one, has no replacement
 * surface yet; it lived only here.
 *
 * `/new_white.png`, not `/new_dark.png` — the same knock-out `AuthShell` uses
 * against this exact `--color-rail` background, for the same reason: the dark
 * mark is black ink on transparent and would render black-on-black here.
 *
 * `h-7`, matching the size `AuthShell` renders this exact asset at — one brand
 * mark, one size, wherever it appears.
 */
export function RailBrand() {
  const { t } = useTranslation();
  return (
    <div className="flex h-9 min-w-0 flex-1 items-center px-2.5">
      <img src="/new_white.png" alt={t('shell.oyechats') || 'OyeChats'} className="h-7 w-auto object-contain" draggable={false} />
    </div>
  );
}
