import { useNavigate } from 'react-router-dom';
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  Avatar,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuTrigger,
  cn,
} from '../ui';
import { useWorkspace } from '../context/WorkspaceContext';
import { OyeChatsMark } from './OyeChatsMark';

/**
 * The workspace the user is acting in.
 *
 * It sits at the top of the rail rather than in the top bar, because the
 * workspace is the outermost scope: everything below it in the rail is scoped by
 * this choice, and putting the two in different places made that relationship
 * invisible.
 *
 * When the account has only one workspace it renders as a plain brand block —
 * a switcher offering one option is a control that teaches the user nothing.
 */
export function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { workspaces, currentWorkspaceId, currentWorkspaceName, hasMultipleWorkspaces, switchWorkspace } =
    useWorkspace();

  const name = currentWorkspaceName ?? 'OyeChats';

  if (!hasMultipleWorkspaces) {
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <OyeChatsMark size={24} onInk />
        <span className="min-w-0 truncate text-base font-semibold text-rail-text">{name}</span>
      </div>
    );
  }

  return (
    <MenuRoot>
      <MenuTrigger
        className={cn(
          'flex w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left',
          'transition-colors duration-[var(--dur-fast)] hover:bg-rail-hover',
        )}
      >
        <OyeChatsMark size={24} onInk />
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-rail-text">{name}</span>
        <ChevronsUpDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-rail-text-muted" />
      </MenuTrigger>
      <MenuContent align="start" className="w-64">
        <MenuLabel>Workspaces</MenuLabel>
        {workspaces.map((workspace) => {
          const isCurrent = workspace.id === currentWorkspaceId;
          return (
            <MenuItem
              key={workspace.id}
              icon={<Avatar name={workspace.name ?? 'Workspace'} size="xs" shape="rounded" />}
              onSelect={() => {
                onNavigate?.();
                if (!isCurrent) void switchWorkspace(workspace.id, { navigate });
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {isCurrent ? (
                  <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent-600" />
                ) : null}
              </span>
            </MenuItem>
          );
        })}
      </MenuContent>
    </MenuRoot>
  );
}
