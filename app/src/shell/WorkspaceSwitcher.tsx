import { useNavigate } from 'react-router-dom';
import { Building2, Headphones } from 'lucide-react';
import { Combobox, toast } from '../ui';
import { useWorkspace } from '../context/WorkspaceContext';
import type { Workspace } from '../types/domain';
import { useTranslation } from '../i18n/useTranslation';

/**
 * Which workspace every screen in the console is reading.
 *
 * **It appears only when there is more than one.** `RailBrand` removed the old
 * menu because, for the solo account that is most of them, the workspace name
 * is the same word the account menu already prints beside the person's own
 * name — one identity stated twice, forty-eight pixels apart. That reasoning
 * holds exactly as far as the solo case and no further: once an identity can
 * act in several workspaces, the current one stops being implied by who you
 * are and becomes a mode that changes the data on every screen. Acting in the
 * wrong one is not a cosmetic mistake — it is replying to another company's
 * visitor — so for those accounts it is persistent chrome, not a menu item.
 *
 * A `Combobox`, matching `AgentSwitcher`: the rail already has one switcher
 * shape and a second one would be a second convention. It carries the seat
 * role as the option's second line rather than leaving the owned/linked
 * distinction to the glyph alone, because colour and iconography are never a
 * signal on their own (DESIGN.md 6.3, 6.5).
 *
 * Expanded only, again like `AgentSwitcher` — a 60px rail has room for one
 * 24px control and it is already the expander.
 *
 * The switch itself belongs to `WorkspaceContext.switchWorkspace`, which
 * aborts every in-flight scoped request before it flips so a late response for
 * the previous workspace cannot land afterwards, then sends owners to the
 * dashboard and operators to the inbox.
 */
export function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { workspaces, currentWorkspaceId, hasMultipleWorkspaces, switchWorkspace } = useWorkspace();

  /** The seat held in that workspace, not the kind of membership. */
  function seatLabel(ws: Workspace): string {
    if (ws.role === 'owner') return t('shell.owner') || 'Owner';
    if (ws.operator_role === 'admin') return t('shell.admin') || 'Admin';
    return t('shell.operator') || 'Operator';
  }

  // Nothing to choose between, so nothing to draw.
  if (!hasMultipleWorkspaces) return null;

  return (
    <Combobox
      size="sm"
      label={t('shell.workspaceSwitcher.title') || 'Switch workspace'}
      value={currentWorkspaceId === null ? null : String(currentWorkspaceId)}
      placeholder={t('shell.workspace') || 'Workspace'}
      searchPlaceholder={t('shell.findAWorkspace') || 'Find a workspace…'}
      emptyMessage={t('shell.noWorkspacesMatch') || 'No workspaces match'}
      options={workspaces.map((ws) => ({
        value: String(ws.id),
        label: ws.name,
        description: seatLabel(ws),
        // An owned workspace and a workspace you were invited into are
        // different things to be standing in, and the glyph says which
        // before the second line is read.
        icon:
          ws.role === 'owner' ? (
            <Building2 aria-hidden className="h-icon-sm w-icon-sm" />
          ) : (
            <Headphones aria-hidden className="h-icon-sm w-icon-sm" />
          ),
      }))}
      onValueChange={(next) => {
        if (!next || next === String(currentWorkspaceId)) return;
        onNavigate?.();
        void switchWorkspace(Number(next), { navigate }).catch(() => {
          // The context leaves the current workspace untouched when the switch
          // throws, so the honest report is that nothing moved.
          toast.error(t('shell.workspaceSwitchFailed') || 'Could not switch workspace');
        });
      }}
      className="border-rail-border bg-rail-hover text-rail-text hover:border-rail-text-muted"
    />
  );
}
