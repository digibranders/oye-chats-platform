import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
    Gift,
    Sparkles,
    ArrowLeft,
    PanelLeftClose,
    PanelLeftOpen,
} from 'lucide-react';
import { cn } from '../lib/utils';
import SettingsDropup from '../components/SettingsDropup';
import { getCurrentUser } from '../services/api';

/**
 * Sidebar for the dedicated affiliate experience.
 *
 * Intentionally narrow — affiliates have ONE primary task (manage referral
 * codes) so the menu is one item plus a way back to the customer dashboard
 * for users who happen to also be customers.
 *
 * Identity model:
 *   - Pure affiliates (bot_count === 0): no "Back to OyeChats" link.
 *     They never had a customer experience and shouldn't see one promoted
 *     from inside the affiliate shell.
 *   - Customer-affiliates (bot_count > 0): "Back to OyeChats" link
 *     surfaces at the bottom of the menu so they can swap into the
 *     customer sidebar at any time.
 */
export default function AffiliateSidebar({ isOpen, setIsOpen }) {
    const location = useLocation();
    const [hasCustomerSide, setHasCustomerSide] = useState(false);

    // Fetch once on mount — we only need bot_count to decide whether to
    // surface the "Back to OyeChats" link. Failure is non-fatal; default
    // is "no customer side", which is the safer default (pure affiliates
    // shouldn't see a link to a section they don't have).
    useEffect(() => {
        let cancelled = false;
        getCurrentUser()
            .then((me) => {
                if (!cancelled) setHasCustomerSide((me?.bot_count || 0) > 0);
            })
            .catch(() => {
                /* keep default */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const menuItems = [
        { path: '/affiliate', name: 'Dashboard', icon: Gift },
    ];

    const isActive = (item) =>
        location.pathname === item.path
        || (item.path !== '/affiliate' && location.pathname.startsWith(item.path));

    const renderLink = (item) => {
        const Icon = item.icon;
        const active = isActive(item);
        return (
            <NavLink
                key={item.path}
                to={item.path}
                className={cn(
                    'flex items-center gap-3 px-3 rounded-xl transition-all group',
                    isOpen ? 'w-full h-8' : 'w-8 h-8 justify-center',
                    active
                        ? 'bg-surface-100 text-surface-900 dark:bg-white/[0.08] dark:text-white'
                        : 'text-surface-500 hover:bg-surface-100 hover:text-surface-700 dark:text-surface-400 dark:hover:bg-white/[0.05] dark:hover:text-surface-200',
                )}
                title={!isOpen ? item.name : undefined}
            >
                <Icon
                    size={18}
                    className={cn(
                        'flex-shrink-0 transition-colors',
                        active
                            ? 'text-primary-600 dark:text-primary-400'
                            : 'text-surface-400 group-hover:text-surface-600 dark:text-surface-500 dark:group-hover:text-surface-300',
                    )}
                />
                {isOpen && <span className="truncate text-sm">{item.name}</span>}
                {active && isOpen && (
                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-primary-500 flex-shrink-0" />
                )}
            </NavLink>
        );
    };

    return (
        <aside
            className={cn(
                'fixed top-0 left-0 h-screen overflow-x-hidden bg-white dark:bg-surface-950 border-r border-surface-200 dark:border-surface-800/50 z-20 transition-all duration-300',
                isOpen ? 'w-[14.5rem]' : 'w-20',
            )}
        >
            {/* Brand lockup */}
            <div className="flex items-center justify-center h-16 border-b border-surface-200 dark:border-surface-800/50">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center flex-shrink-0 shadow-lg shadow-primary-500/25">
                        <Sparkles size={18} />
                    </div>
                    {isOpen && (
                        <span className="text-[15px] font-bold text-surface-900 dark:text-white tracking-tight truncate pr-4">
                            Affiliate
                        </span>
                    )}
                </div>
            </div>

            <nav className="p-4 space-y-1 mt-2 overflow-y-auto h-[calc(100vh-8rem)]">
                {menuItems.map(renderLink)}

                {hasCustomerSide && (
                    <div className="pt-4 mt-4 border-t border-surface-200 dark:border-surface-800/60">
                        {isOpen && (
                            <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-surface-400 dark:text-surface-600">
                                Other
                            </p>
                        )}
                        <NavLink
                            to="/"
                            className={cn(
                                'flex items-center gap-3 px-3 rounded-xl transition-all group',
                                isOpen ? 'w-full h-8' : 'w-8 h-8 justify-center',
                                'text-surface-500 hover:bg-surface-100 hover:text-surface-700 dark:text-surface-400 dark:hover:bg-white/[0.05] dark:hover:text-surface-200',
                            )}
                            title={!isOpen ? 'Back to OyeChats' : undefined}
                        >
                            <ArrowLeft size={18} className="flex-shrink-0 text-surface-400 dark:text-surface-500 group-hover:text-surface-600 dark:group-hover:text-surface-300" />
                            {isOpen && <span className="truncate text-sm">Back to OyeChats</span>}
                        </NavLink>
                    </div>
                )}
            </nav>

            <div className="absolute bottom-4 left-0 w-full px-4 space-y-2">
                <SettingsDropup isOpen={isOpen} />
                <button
                    onClick={() => setIsOpen((prev) => !prev)}
                    className={cn(
                        'flex items-center gap-2 w-full px-3 py-2 rounded-xl text-surface-500 hover:bg-surface-100 hover:text-surface-700 dark:text-surface-400 dark:hover:bg-white/[0.05] dark:hover:text-surface-200 transition-all',
                        !isOpen && 'justify-center',
                    )}
                    title={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                >
                    {isOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
                    {isOpen && <span className="text-sm">Collapse</span>}
                </button>
            </div>
        </aside>
    );
}
