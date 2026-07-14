import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { User, Shield, Bell, Palette, Briefcase, Headphones, CodeXml } from 'lucide-react';
import { cn } from '../lib/utils';
import PageHeader from '../components/ui/PageHeader';
import ProfileTab from './settings/ProfileTab';
import SecurityTab from './settings/SecurityTab';
import NotificationsTab from './settings/NotificationsTab';
import AppearanceTab from './settings/AppearanceTab';
import LiveChatTab from './settings/LiveChatTab';
import WorkspaceTab from './settings/WorkspaceTab';
import ContactTab from './settings/ContactTab';
import { getAuthState } from '../utils/auth';
import { useWorkspace } from '../context/WorkspaceContext';

const TABS = [
    { id: 'profile', label: 'Profile', icon: User, Component: ProfileTab },
    { id: 'security', label: 'Security', icon: Shield, Component: SecurityTab },
    { id: 'notifications', label: 'Notifications', icon: Bell, Component: NotificationsTab },
    { id: 'appearance', label: 'Appearance', icon: Palette, Component: AppearanceTab },
    { id: 'live_chat', label: 'Live Chat', icon: Headphones, Component: LiveChatTab },
    { id: 'workspace', label: 'Workspace', icon: Briefcase, Component: WorkspaceTab },
    { id: 'contact', label: 'Need something custom?', icon: CodeXml, Component: ContactTab, divider: true },
];

/**
 * Settings — thin tabbed shell for Account & Workspace preferences.
 *
 * A left tab rail drives an URL-synced ``?tab=`` query param (deep-linkable,
 * back-button friendly), delegating to a focused component per tab under
 * ``pages/settings/``. An unknown or absent tab falls back to Profile.
 *
 * Per-bot configuration (widget behavior, visitor messages, tone, live-chat
 * queue) intentionally does NOT live here anymore — see the WorkspaceTab
 * pointer card that links to Bot Settings.
 */
export default function Settings() {
    const [params, setParams] = useSearchParams();
    // Operators get a stripped Settings shell — Profile only. The Install
    // OyeChats PWA card that operators need is already rendered inside
    // ProfileTab (gated on isOperatorRole there), so filtering the top-level
    // tab list to Profile alone gives them "Profile fields + Install card"
    // with zero owner-only surfaces (security keys, appearance, live-chat
    // settings, workspace, custom-work contact).
    //
    // Two operator paths both collapse to the same shape:
    //   1. Legacy X-Operator-Key session with a non-manager role.
    //   2. Client identity whose current workspace role is 'operator'
    //      (invited via the workspace switcher).
    const { isOperator, isBotManager } = getAuthState();
    const { currentRole: workspaceRole } = useWorkspace();
    const pureOperator = (isOperator && !isBotManager) || workspaceRole === 'operator';
    const visibleTabs = useMemo(
        () => (pureOperator ? TABS.filter((t) => t.id === 'profile') : TABS),
        [pureOperator],
    );
    const active = visibleTabs.find((t) => t.id === params.get('tab')) || visibleTabs[0];
    const Active = active.Component;

    return (
        <div className="space-y-6 animate-fade-in">
            <PageHeader title="Settings" subtitle="Account & workspace preferences" />

            <div className="flex flex-col md:flex-row gap-6">
                <nav
                    aria-label="Settings sections"
                    className="md:w-56 shrink-0 flex md:flex-col gap-1 overflow-x-auto"
                >
                    {visibleTabs.map((t) => {
                        const Icon = t.icon;
                        const on = t.id === active.id;
                        return (
                            <button
                                key={t.id}
                                type="button"
                                aria-current={on ? 'page' : undefined}
                                onClick={() => setParams({ tab: t.id })}
                                className={cn(
                                    'flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium text-left whitespace-nowrap transition-colors',
                                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
                                    t.divider && 'mt-2 pt-3 border-t border-surface-200 dark:border-surface-800',
                                    on
                                        ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                                        : 'text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800/60'
                                )}
                            >
                                <Icon className="w-4 h-4 shrink-0" />
                                {t.label}
                            </button>
                        );
                    })}
                </nav>

                <div className="flex-1 min-w-0 max-w-3xl">
                    <Active />
                </div>
            </div>
        </div>
    );
}
