import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { Link } from 'react-router-dom';
import {
  MoreHorizontal,
  ExternalLink,
  Link2,
  Pencil,
  Trash2,
  Loader2,
  Check,
  X,
  ArrowRight,
} from 'lucide-react';
import { updateBot, deleteBot, getBotDemoUrl, trackDemoShareClick } from '../../services/api';
import { type Bot } from '../../types/domain';
import { cn } from '../../design-system';

export interface AgentActionsMenuProps {
  /** The agent this menu operates on. */
  bot: Bot;
  /** Called after a successful rename or delete so the list can re-fetch. */
  onChanged: () => void;
}

function messageFromError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}

/**
 * AgentActionsMenu — the per-agent "⋯" menu shown on each tile.
 *
 * Sits as an overlay sibling of the card's navigational link (never nested
 * inside it), so both remain independent, keyboard-operable controls. Offers
 * the portfolio-management actions ported from the legacy BotCard: open the
 * agent, view its live demo (getBotDemoUrl), rename inline (updateBot), and
 * delete with a two-step confirm (deleteBot). Closes on outside-click and Esc.
 */
export function AgentActionsMenu({ bot, onChanged }: AgentActionsMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(bot.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Which menu item to focus on the next open ('last' only when the user opened
  // via ArrowUp on the trigger, per the WAI-ARIA menu-button pattern).
  const pendingFocusRef = useRef<'first' | 'last'>('first');

  // Close the menu and reset its transient sub-state. Done in the close handler
  // (not an open→false effect) so we never run a setState-in-effect reset.
  const closeMenu = useCallback((): void => {
    setOpen(false);
    setRenaming(false);
    setConfirmDelete(false);
    setCopied(false);
    setError('');
  }, []);

  const focusMenuItem = useCallback((position: 'first' | 'last'): void => {
    const items = containerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    (position === 'last' ? items[items.length - 1] : items[0]).focus();
  }, []);

  // While open: close on outside-click / Esc, and move focus into the menu so
  // the roving arrow-key navigation is reachable immediately (WAI-ARIA menu
  // button: activating the trigger focuses a menu item).
  useEffect(() => {
    if (!open) return undefined;
    const focusTimer = window.setTimeout(() => {
      focusMenuItem(pendingFocusRef.current);
      pendingFocusRef.current = 'first';
    }, 20);
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closeMenu, focusMenuItem]);

  const startRename = (): void => {
    setRenameValue(bot.name);
    setError('');
    setRenaming(true);
    window.setTimeout(() => renameInputRef.current?.focus(), 20);
  };

  const commitRename = async (): Promise<void> => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === bot.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await updateBot(bot.id, { name: trimmed });
      closeMenu();
      onChanged();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await deleteBot(bot.id);
      closeMenu();
      onChanged();
      // onChanged() re-fetches and unmounts this tile; leave `busy` set so we
      // don't fire a needless post-unmount state update.
      return;
    } catch (err) {
      setError(messageFromError(err));
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  // Roving focus between menu items with arrow keys.
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    else if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
    else nextIndex = (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const menuItemClass =
    'flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] font-medium text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:bg-[var(--ds-bg-hover)] focus-visible:outline-none';
  const demoUrl = bot.bot_key ? getBotDemoUrl(bot.bot_key) : null;

  // Copy the shareable demo link and record the share (fire-and-forget: a failed
  // analytics ping must never block the copy). The menu stays open so the
  // "Copied" confirmation is visible; it resets when the menu closes.
  const handleCopyDemo = async (): Promise<void> => {
    if (!demoUrl) return;
    try {
      await navigator.clipboard.writeText(demoUrl);
    } catch {
      setError('Could not copy — check clipboard permissions.');
      return;
    }
    setCopied(true);
    setError('');
    void trackDemoShareClick(bot.id).catch(() => undefined);
  };

  return (
    <div ref={containerRef} className="relative z-10">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${bot.name}`}
        onClick={() => (open ? closeMenu() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const position = event.key === 'ArrowUp' ? 'last' : 'first';
          if (open) {
            focusMenuItem(position);
          } else {
            pendingFocusRef.current = position;
            setOpen(true);
          }
        }}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-[var(--ds-text-subtle)] transition-colors hover:border-[var(--ds-border)] hover:bg-[var(--ds-bg-surface)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${bot.name}`}
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 top-full z-20 mt-1.5 w-56 overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] py-1.5 shadow-[var(--ds-shadow-lg)]"
        >
          <Link
            role="menuitem"
            to={`/agents/${bot.id}/overview`}
            className={menuItemClass}
            onClick={closeMenu}
          >
            <ArrowRight size={15} className="text-[var(--ds-text-subtle)]" aria-hidden="true" />
            Open agent
          </Link>

          {demoUrl && (
            <a
              role="menuitem"
              href={demoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={menuItemClass}
              onClick={closeMenu}
            >
              <ExternalLink size={15} className="text-[var(--ds-text-subtle)]" aria-hidden="true" />
              View demo
            </a>
          )}

          {demoUrl && (
            <button role="menuitem" type="button" className={menuItemClass} onClick={() => void handleCopyDemo()}>
              {copied ? (
                <Check size={15} className="text-[var(--ds-success)]" aria-hidden="true" />
              ) : (
                <Link2 size={15} className="text-[var(--ds-text-subtle)]" aria-hidden="true" />
              )}
              {copied ? 'Link copied' : 'Copy demo link'}
            </button>
          )}

          <div className="my-1 border-t border-[var(--ds-border)]" />

          {renaming ? (
            <div className="px-3 py-2">
              <label htmlFor={`rename-${bot.id}`} className="sr-only">
                Rename agent
              </label>
              <input
                id={`rename-${bot.id}`}
                ref={renameInputRef}
                value={renameValue}
                maxLength={50}
                disabled={busy}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitRename();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setRenaming(false);
                  }
                }}
                className="h-8 w-full rounded-md border border-[var(--ds-accent)] bg-[var(--ds-bg-surface)] px-2 text-[13px] text-[var(--ds-text)] outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
              />
              <div className="mt-2 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  aria-label="Cancel rename"
                  disabled={busy}
                  onClick={() => setRenaming(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-border)] disabled:opacity-50"
                >
                  <X size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Save name"
                  disabled={busy}
                  onClick={() => void commitRename()}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--ds-accent)] text-[var(--ds-accent-fg)] hover:bg-[var(--ds-accent-hover)] disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Check size={13} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          ) : (
            <button role="menuitem" type="button" className={menuItemClass} onClick={startRename}>
              <Pencil size={15} className="text-[var(--ds-text-subtle)]" aria-hidden="true" />
              Rename
            </button>
          )}

          {confirmDelete ? (
            <div className="flex items-center justify-between gap-2 px-3.5 py-2">
              <span className="text-[12px] text-[var(--ds-text-muted)]">Delete this agent?</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label="Confirm delete"
                  disabled={busy}
                  onClick={() => void handleDelete()}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--ds-danger)] text-white hover:opacity-90 disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Check size={13} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Cancel delete"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-border)] disabled:opacity-50"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : (
            <button
              role="menuitem"
              type="button"
              className={cn(
                menuItemClass,
                'text-[var(--ds-danger)] hover:bg-[var(--ds-danger-soft)] focus-visible:bg-[var(--ds-danger-soft)]',
              )}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} aria-hidden="true" />
              Delete&hellip;
            </button>
          )}

          {error && (
            <p className="px-3.5 pt-1.5 text-[12px] text-[var(--ds-danger)]" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
