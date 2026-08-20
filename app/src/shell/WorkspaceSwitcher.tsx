import { useNavigate } from 'react-router-dom';
import { Check, ChevronsUpDown, Settings, UserPlus } from 'lucide-react';
import {
  Avatar,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from '../ui';
import { useWorkspace } from '../context/WorkspaceContext';
import { OyeChatsMark } from './OyeChatsMark';

/** Past this many memberships a menu is the wrong control; see the docblock. */
const MENU_LIMIT = 8;

/**
 * The workspace the user is acting in.
 *
 * It sits at the top of the rail rather than in the top bar, because the
 * workspace is the outermost scope: everything below it in the rail is scoped by
 * this choice, and putting the two in different places made that relationship
 * invisible.
 *
 * **It is always a menu, even at one workspace.** It used to render a bare
 * `<div>` for the single-workspace case — the overwhelming majority of accounts
 * — which threw the one trigger at the top of the rail away exactly when the
 * account is smallest and the user least oriented. Linear, Vercel and Notion
 * all keep it, because it is also where workspace settings and inviting people
 * live. The workspace *list* is what is conditional, not the menu.
 *
 * It opens to the **right**. Anchored to a full-height column at the edge of the
 * viewport, a `bottom` menu is collision-flipped and its 256px panel overhung
 * the 248px rail by twenty pixels onto the canvas.
 *
 * The mark sits in the same 16px optical box as every glyph below it, so the
 * brand and the first nav icon share one vertical line. Its centre used to land
 * at 24 or 30 depending on whether the account had more than one workspace,
 * against 26 for every icon under it.
 */
export function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { workspaces, currentWorkspaceId, currentWorkspaceName, hasMultipleWorkspaces, switchWorkspace } =
    useWorkspace();

  const name = currentWorkspaceName ?? 'OyeChats';
  const listable = hasMultipleWorkspaces && workspaces.length <= MENU_LIMIT;

  function go(to: string) {
    onNavigate?.();
    navigate(to);
  }

  return (
    <MenuRoot>
      <MenuTrigger
        aria-label={`Workspace: ${name}`}
        className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-rail-hover focus-visible:outline-rail-accent"
      >
        <span className="flex h-icon-md w-icon-md shrink-0 items-center justify-center">
          <OyeChatsMark size={20} onInk className="-m-0.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-rail-text">{name}</span>
        <ChevronsUpDown aria-hidden className="h-icon-sm w-icon-sm shrink-0 text-rail-text-muted" />
      </MenuTrigger>

      <MenuContent side="right" align="start" className="w-64">
        <MenuItem
          icon={<Settings aria-hidden />}
          onSelect={() => go('/settings/workspace')}
        >
          Workspace settings
        </MenuItem>
        <MenuItem icon={<UserPlus aria-hidden />} onSelect={() => go('/settings/team')}>
          Invite people
        </MenuItem>

        {hasMultipleWorkspaces ? (
          <>
            <MenuSeparator />
            <MenuLabel>Workspaces</MenuLabel>
            {listable ? (
              workspaces.map((workspace) => {
                const isCurrent = workspace.id === currentWorkspaceId;
                return (
                  <MenuItem
                    key={workspace.id}
                    icon={<Avatar name={workspace.name ?? 'Workspace'} size="xs" shape="rounded" />}
                    selected={isCurrent}
                    onSelect={() => {
                      onNavigate?.();
                      if (!isCurrent) void switchWorkspace(workspace.id, { navigate });
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                      {isCurrent ? (
                        <Check aria-hidden className="h-icon-sm w-icon-sm shrink-0 text-accent-600" />
                      ) : null}
                    </span>
                  </MenuItem>
                );
              })
            ) : (
              // Past eight memberships a scrolling menu with no filter is not a
              // way to find one by name, and `MenuContent` cannot hold a text
              // input by rule — every child of a `role="menu"` has to be a
              // `menuitem`. The list moves to the members screen until this is
              // a `Popover` + `Combobox`, the swap `AgentSwitcher` already made.
              <MenuItem onSelect={() => go('/settings/team')}>
                Switch workspace ({workspaces.length})
              </MenuItem>
            )}
          </>
        ) : null}
      </MenuContent>
    </MenuRoot>
  );
}
