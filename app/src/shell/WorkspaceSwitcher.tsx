import { useCallback } from 'react';
import { t as translateNow } from '../i18n/i18n';
import { useNavigate } from 'react-router-dom';
import { Building2, Check, ChevronsUpDown, Headphones } from 'lucide-react';
import { cn, Popover } from '../design-system';
import { useWorkspace } from '../context/WorkspaceContext';
import type { Workspace } from '../types/domain';
import { useTranslation } from '../i18n/useTranslation';

/** Human-readable seat role for a workspace entry. */
function roleLabel(ws: Workspace): string {
  if (ws.role === 'owner') return translateNow('shell.owner') || 'Owner';
  const seat = ws.operator_role || 'operator';
  return seat.charAt(0).toUpperCase() + seat.slice(1);
}

/** Owned workspaces read as a building; linked-operator memberships as a headset. */
function WorkspaceGlyph({ ws, className }: { ws: Workspace; className?: string }) {
  const Icon = ws.role === 'owner' ? Building2 : Headphones;
  return <Icon size={15} aria-hidden="true" className={className} />;
}

/**
 * WorkspaceSwitcher - the TopBar control for moving between the workspaces a
 * single identity can act in: their own (owner) workspace and any workspace
 * they joined as a linked operator via an accepted invite. Backed by
 * `GET /me/workspaces`; switching flips `X-Workspace-Id` for every scoped
 * request and reconnects side channels (see `WorkspaceContext.switchWorkspace`).
 *
 * Renders nothing for single-workspace identities so the chrome stays quiet -
 * it only appears once there's an actual choice to make.
 */
export function WorkspaceSwitcher() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    workspaces,
    currentWorkspaceId,
    currentWorkspaceName,
    hasMultipleWorkspaces,
    switchWorkspace,
  } = useWorkspace();

  const handleSwitch = useCallback(
    async (workspaceId: number, close: () => void) => {
      close();
      if (workspaceId === currentWorkspaceId) return;
      try {
        await switchWorkspace(workspaceId, { navigate });
      } catch (error) {
        console.error('WorkspaceSwitcher: failed to switch workspace', error);
      }
    },
    [currentWorkspaceId, navigate, switchWorkspace],
  );

  if (!hasMultipleWorkspaces) return null;

  const current = workspaces.find((w) => w.id === currentWorkspaceId) ?? null;
  const currentName = current?.name || currentWorkspaceName || t('shell.workspace') || 'Workspace';

  return (
    <Popover
      align="start"
      role="menu"
      panelClassName="w-72"
      trigger={(triggerProps) => (
        <button
          type="button"
          ref={triggerProps.setRef}
          onClick={triggerProps.onClick}
          aria-haspopup={triggerProps['aria-haspopup']}
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          aria-label={
            t('shell.workspaceSwitcher.current', { name: currentName }) ||
            `Current workspace: ${currentName}. Switch workspace`
          }
          className="flex h-9 max-w-[42vw] items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-2.5 text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] md:max-w-[220px]"
        >
          {current && (
            <WorkspaceGlyph ws={current} className="shrink-0 text-[var(--ds-text-subtle)]" />
          )}
          <span className="truncate text-[13px] font-medium">{currentName}</span>
          <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-text-subtle)]" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
            {t('shell.workspaceSwitcher.title') || 'Switch workspace'}
          </p>
          <div className="max-h-80 overflow-y-auto p-1">
            {workspaces.map((ws) => {
              const isCurrent = ws.id === currentWorkspaceId;
              return (
                <button
                  key={ws.id}
                  type="button"
                  role="menuitem"
                  onClick={() => handleSwitch(ws.id, close)}
                  aria-current={isCurrent || undefined}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-[var(--ds-radius-md)] px-3 py-2 text-left transition-colors',
                    isCurrent
                      ? 'bg-[var(--ds-accent-soft)]'
                      : 'hover:bg-[var(--ds-bg-hover)]',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                      ws.role === 'owner'
                        ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]'
                        : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]',
                    )}
                  >
                    <WorkspaceGlyph ws={ws} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--ds-text)]">
                      {ws.name}
                    </span>
                    <span className="block text-[11px] text-[var(--ds-text-subtle)]">
                      {roleLabel(ws)}
                    </span>
                  </span>
                  {isCurrent && (
                    <Check size={15} aria-hidden="true" className="shrink-0 text-[var(--ds-accent)]" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Popover>
  );
}
