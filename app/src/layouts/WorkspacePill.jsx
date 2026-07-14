/**
 * Workspace switcher — the top-left pill that lets a Client identity hop
 * between the workspaces they belong to.
 *
 * Rendered inside ``TopBar`` next to the sidebar-toggle button. Behaviour:
 *
 *   • Single workspace (owner-only, no invites)  → renders as a static label,
 *     no dropdown affordance, no click target.
 *   • Multiple workspaces                         → interactive pill; click
 *     opens a dropdown that lists every workspace with role badge + bot count.
 *   • "Create your own workspace" entry is shown ONLY when the caller has no
 *     bots of their own yet (invited-only users). Owners already have a
 *     workspace-creation surface in ``/chatbot?create=true``.
 *
 * Everything user-visible reads from ``useWorkspace``; the pill itself owns
 * no state beyond dropdown open/closed.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Plus, Building2, Headphones } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { cn } from '../lib/utils';

function _roleBadge(entry) {
    if (entry.role === 'owner') return { label: 'Owner', className: 'text-brand-600 dark:text-brand-400' };
    // operator_role can be operator | admin | owner (per Operator.role) — show
    // "Admin" for elevated linked-operator roles, otherwise "Operator".
    if (entry.operator_role === 'admin' || entry.operator_role === 'owner') {
        return { label: 'Admin', className: 'text-surface-600 dark:text-surface-300' };
    }
    return { label: 'Operator', className: 'text-surface-600 dark:text-surface-300' };
}

function _entrySummary(entry) {
    if (entry.role === 'owner') {
        const n = entry.bot_count || 0;
        return n === 0 ? 'No bots yet' : `${n} bot${n === 1 ? '' : 's'}`;
    }
    return 'Live-chat operator';
}

export default function WorkspacePill() {
    const navigate = useNavigate();
    const {
        workspaces,
        currentWorkspaceId,
        currentWorkspaceName,
        currentRole,
        hasMultipleWorkspaces,
        isInvitedOnly,
        switchWorkspace,
        isLoading,
    } = useWorkspace();

    const [open, setOpen] = useState(false);
    const containerRef = useRef(null);
    const buttonRef = useRef(null);
    // Menu position in viewport coords. The dropdown renders with
    // ``position: fixed`` so it escapes the TopBar's stacking context,
    // which pulls in ``backdrop-filter: blur()`` — Chrome/Safari treat that
    // as a compositing group that clips descendants to the filter box (see
    // the ``sticky z-20 backdrop-blur-xl`` <header> in TopBar.jsx). An
    // ``absolute`` dropdown inside it would be cropped at the header's
    // bottom edge no matter what ``overflow`` says. Fixed positioning +
    // per-open coordinate capture sidesteps the whole clipping story.
    const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

    // Ref on the portaled menu — outside-click needs to know whether the
    // click landed inside the menu, but the menu isn't a DOM descendant of
    // ``containerRef`` anymore (it's a child of ``document.body`` via
    // createPortal), so ``containerRef.contains(event.target)`` alone would
    // treat every menu click as "outside" and close the menu on selection.
    const menuRef = useRef(null);

    // Close on outside click.
    useEffect(() => {
        function onDocClick(event) {
            if (!containerRef.current) return;
            const inPill = containerRef.current.contains(event.target);
            const inMenu = menuRef.current?.contains(event.target);
            if (!inPill && !inMenu) setOpen(false);
        }
        if (open) document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [open]);

    // Close on Escape.
    useEffect(() => {
        function onKey(event) {
            if (event.key === 'Escape') setOpen(false);
        }
        if (open) document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    // Recompute the menu's viewport position whenever it opens, and also on
    // scroll / resize while it's open — the pill sits inside a sticky
    // TopBar, so those events don't move the pill relative to the viewport,
    // but a virtual keyboard or a font-scale change can shift it a few px.
    // Snap the menu 8px below the pill; align its left edge to the pill.
    useEffect(() => {
        if (!open) return;
        function updatePosition() {
            const el = buttonRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            setMenuPos({ top: rect.bottom + 8, left: rect.left });
        }
        updatePosition();
        window.addEventListener('scroll', updatePosition, true);
        window.addEventListener('resize', updatePosition);
        return () => {
            window.removeEventListener('scroll', updatePosition, true);
            window.removeEventListener('resize', updatePosition);
        };
    }, [open]);

    // The pill is a SWITCHER — it only earns real estate when the caller
    // actually has somewhere to switch to. A regular workspace owner with
    // no accepted operator invites elsewhere sees nothing here. The
    // breadcrumb, the sidebar workspace name, and the profile menu already
    // tell them who they are and where they are; a static "OWNER" chip on
    // top of all that would be redundant chrome.
    //
    // Hidden branches (return null instead of a static label):
    //   • Loading — brief blank instead of a skeleton that vanishes when it
    //     turns out the user only has one workspace. Cleaner than flashing a
    //     placeholder for the 99% case that resolves to "nothing to show."
    //   • Zero workspaces — legacy X-Operator-Key sessions never populate
    //     ``workspaces``, so this covers them too.
    //   • Single workspace — the only case where the caller has nowhere to
    //     switch to. Their own workspace, without any linked-operator
    //     memberships in other workspaces.
    if (isLoading || workspaces.length === 0 || !hasMultipleWorkspaces) {
        return null;
    }

    const currentEntry = workspaces.find((w) => w.id === currentWorkspaceId);
    const label = currentEntry?.name || currentWorkspaceName || 'Workspace';
    const roleBadge = currentEntry ? _roleBadge(currentEntry) : { label: currentRole || '', className: '' };

    async function handleSwitch(nextId) {
        setOpen(false);
        if (nextId === currentWorkspaceId) return;
        try {
            await switchWorkspace(nextId, { navigate });
        } catch (err) {
            // Surface silently — a switch failure is rare (workspace vanished
            // between list fetch and click) and the response interceptor
            // covers the workspace_access_denied case via its own event.
            console.error('Workspace switch failed', err);
        }
    }

    return (
        <div ref={containerRef} className="relative">
            <button
                ref={buttonRef}
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    'flex items-center gap-2 px-2.5 py-1.5 rounded-xl border transition-colors',
                    'border-surface-200 dark:border-surface-800',
                    'hover:bg-surface-100 dark:hover:bg-surface-800',
                    open && 'bg-surface-100 dark:bg-surface-800',
                )}
                aria-haspopup="listbox"
                aria-expanded={open}
                title="Switch workspace"
            >
                {currentRole === 'operator'
                    ? <Headphones size={14} className="text-surface-500 shrink-0" />
                    : <Building2 size={14} className="text-surface-500 shrink-0" />}
                <span className="text-sm font-medium text-surface-800 dark:text-surface-200 truncate max-w-[160px] md:max-w-[220px]">
                    {label}
                </span>
                <span className={cn('text-[10px] font-medium uppercase tracking-wide hidden sm:inline', roleBadge.className)}>
                    {roleBadge.label}
                </span>
                <ChevronDown size={14} className={cn('text-surface-400 transition-transform', open && 'rotate-180')} />
            </button>

            {/* Portal to document.body — the TopBar's ``backdrop-filter``
                (a) creates a containing block for ``position: fixed``
                    descendants (so ``fixed`` alone would still resolve
                    coordinates relative to the header, not the viewport),
                (b) traps the whole subtree in its own stacking context at
                    z=20, losing every z-index race against the sidebar
                    (z=30) and every other overlay in the app.
                Rendering into ``document.body`` sidesteps both — the menu
                lands in the ROOT stacking context where z-50 wins. */}
            {createPortal(
                <AnimatePresence>
                {open && (
                    <motion.div
                        ref={menuRef}
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.12 }}
                        role="listbox"
                        aria-label="Workspaces"
                        style={{
                            top: menuPos.top,
                            left: menuPos.left,
                            // Inline maxWidth avoids the Tailwind arbitrary-value
                            // route (``max-w-[calc(100vw-24px)]`` was producing
                            // ``max-width: 0`` in this build because the
                            // stylesheet wasn't regenerated for the arbitrary
                            // class name, crushing the dropdown to a 2px sliver).
                            // The intent is "never overflow the viewport by more
                            // than a 12px gutter on each side" — plain CSS calc
                            // does that reliably.
                            maxWidth: 'calc(100vw - 24px)',
                        }}
                        className={cn(
                            'fixed z-50 w-80',
                            'rounded-xl border shadow-xl',
                            'bg-white dark:bg-surface-950',
                            'border-surface-200 dark:border-surface-800',
                            'overflow-hidden',
                        )}
                    >
                        <WorkspaceList
                            workspaces={workspaces}
                            currentWorkspaceId={currentWorkspaceId}
                            onSelect={handleSwitch}
                        />

                        {/* "Create your own workspace" — shown when the caller
                            has no bots of their own yet. Owners with bots
                            already have this affordance under Sidebar's
                            "My Bots"; showing it again would be noisy. */}
                        {isInvitedOnly && (
                            <div className="border-t border-surface-200 dark:border-surface-800 py-1">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setOpen(false);
                                        // Route to the bot-create flow. Client
                                        // side takes over from here — creating
                                        // their first bot promotes their owned
                                        // workspace from empty to actively used.
                                        navigate('/chatbot?create=true');
                                    }}
                                    className={cn(
                                        'w-full px-3 py-2.5 flex items-center gap-2 text-left',
                                        'text-sm text-surface-700 dark:text-surface-200',
                                        'hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors',
                                    )}
                                >
                                    <Plus size={14} className="text-surface-500" />
                                    <span className="flex-1">Create your own workspace</span>
                                </button>
                            </div>
                        )}
                    </motion.div>
                )}
                </AnimatePresence>,
                document.body,
            )}
        </div>
    );
}


function WorkspaceList({ workspaces, currentWorkspaceId, onSelect }) {
    // Owner first, then linked-operator memberships alphabetically —
    // matches the backend's sort order but done client-side too so a
    // freshly-added workspace slots in without waiting for a refresh.
    const sorted = useMemo(() => {
        const owner = workspaces.filter((w) => w.role === 'owner');
        const ops = workspaces
            .filter((w) => w.role !== 'owner')
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name));
        return [...owner, ...ops];
    }, [workspaces]);

    return (
        <div className="py-1 max-h-80 overflow-y-auto">
            {sorted.map((w) => {
                const isCurrent = w.id === currentWorkspaceId;
                const badge = _roleBadge(w);
                return (
                    <button
                        key={w.id}
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        onClick={() => onSelect(w.id)}
                        className={cn(
                            'w-full px-3 py-2.5 flex items-center gap-3 text-left',
                            'hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors',
                            isCurrent && 'bg-surface-50 dark:bg-surface-900/40',
                        )}
                    >
                        <div className={cn(
                            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                            w.role === 'owner'
                                ? 'bg-brand-50 dark:bg-brand-950/40 text-brand-600 dark:text-brand-400'
                                : 'bg-surface-100 dark:bg-surface-800 text-surface-500',
                        )}>
                            {w.role === 'owner' ? <Building2 size={16} /> : <Headphones size={16} />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
                                {w.name}
                            </div>
                            <div className="text-[11px] text-surface-500 truncate flex items-center gap-1.5">
                                <span className={badge.className}>{badge.label}</span>
                                <span className="text-surface-300 dark:text-surface-600">·</span>
                                <span>{_entrySummary(w)}</span>
                            </div>
                        </div>
                        {isCurrent && <Check size={14} className="text-brand-600 dark:text-brand-400 shrink-0" />}
                    </button>
                );
            })}
        </div>
    );
}
