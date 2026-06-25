import { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, BookOpen, BarChart3, Target, Crosshair, Headphones,
  Bot, ChevronDown, Plus, Check, Settings, Plug, UsersRound, CreditCard,
  Gift, Palette, Lock,
} from 'lucide-react';
import OyeChatsMark from '../components/OyeChatsMark';
import { useBotContext } from '../context/BotContext';
import { getAuthState } from '../utils/auth';
import { getOfflineMessages, getLeadStats, getCurrentUser } from '../services/api';
import useEntitlements from '../hooks/useEntitlements';
import { useUpgradeModal } from '../context/UpgradeModalContext';
import { cn } from '../lib/utils';

export default function Sidebar({ isOpen, isMobile, onClose }) {
  const location = useLocation();
  const { bots, selectedBot, selectBot, loading, error: botError } = useBotContext();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [expandedMenus, setExpandedMenus] = useState({});
  const dropdownRef = useRef(null);
  const navigate = useNavigate();
  const { isOperator: isOperatorRole, isBotManager } = getAuthState();
  // Entitlements drive which paid-only menu items render. Free users see
  // a slimmer sidebar; Standard+ see the full set. The hook is cheap
  // (Redis-cached server-side; module-cached client-side) so calling it
  // from the Sidebar — a component that mounts on every authenticated
  // page — is fine.
  const { entitlements: ent } = useEntitlements();
  // requestUpgrade is the global trigger for the premium upsell modal —
  // every gated click in this sidebar goes through it so the surface is
  // identical (copy, plan transition chip, CTA) wherever a free user hits
  // a wall.
  const { requestUpgrade } = useUpgradeModal();
  const [unreadMsgs, setUnreadMsgs] = useState(0);
  const [newLeads, setNewLeads] = useState(0);
  // Affiliate membership is derived from /auth/me (single source of truth =
  // the affiliates DB row). Cached for the session so the sidebar doesn't
  // refetch on every navigation. Default false → menu item hidden until we
  // confirm the user is enrolled.
  const [isAffiliate, setIsAffiliate] = useState(false);

  useEffect(() => {
    const fetchBadges = async () => {
      try {
        const [offlineData, leadsData] = await Promise.allSettled([
          getOfflineMessages({ status: 'new', limit: 1 }),
          getLeadStats(selectedBot?.id),
        ]);
        if (offlineData.status === 'fulfilled') setUnreadMsgs(offlineData.value?.total || 0);
        if (leadsData.status === 'fulfilled') {
          // `unread` = ChatSessions where lead_viewed_at IS NULL.
          // Drops to 0 when the team opens each lead or clicks "Mark all read".
          setNewLeads(leadsData.value?.unread || 0);
        }
      } catch {
        // badges are non-critical
      }
    };
    fetchBadges();
    const interval = setInterval(fetchBadges, 60000);
    return () => clearInterval(interval);
  }, [selectedBot?.id]);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Resolve affiliate membership exactly once per mount. Operators are
  // never affiliates (the backend always returns is_affiliate=false for
  // X-Operator-Key principals), so we can short-circuit and skip the
  // fetch entirely for them.
  useEffect(() => {
    if (isOperatorRole) return;
    let cancelled = false;
    getCurrentUser()
      .then((me) => { if (!cancelled) setIsAffiliate(Boolean(me?.is_affiliate)); })
      .catch(() => { /* non-critical — menu item just stays hidden */ });
    return () => { cancelled = true; };
  }, [isOperatorRole]);

  const handleNavClick = () => { if (isMobile && onClose) onClose(); };
  // Create-bot click is gated on the workspace's plan limit. The Chatbot
  // page also runs the same guard, but intercepting here avoids the brief
  // flash where the create modal opens and immediately demands an upgrade.
  const handleCreateBot = () => {
    setDropdownOpen(false);
    // Always route through the Chatbot page's create wizard. It picks
    // the right narrative itself: a one-screen Free form for the first
    // bot, the two-step plan-picker + Razorpay flow for every bot after.
    navigate('/chatbot?create=true');
  };

  // Free plan gating. Support stays UNLOCKED for everyone: Free users can
  // configure the offline-message form in Settings and read incoming
  // visitor messages in Support → Messages. The Live Chat *sub-tab* inside
  // Support is the part that's locked (handled in Support.jsx). Leads
  // remains fully locked for Free since it's an entirely paid surface.
  const leadsLocked = ent.isFree;

  const mainItems = isOperatorRole
    ? [{ path: '/support', name: 'Support', icon: Headphones, badge: unreadMsgs }]
    : [
        { path: '/', name: 'Overview', icon: LayoutDashboard },
        { path: '/knowledge', name: 'Sources', icon: BookOpen },
        { path: '/insights', name: 'Insights', icon: BarChart3 },
        {
          path: '/support',
          name: 'Support',
          icon: Headphones,
          // Support is always reachable. Visitor messages inbox works on
          // every plan; the Live Chat sub-tab inside the page handles its
          // own upsell.
          badge: unreadMsgs,
        },
        {
          path: '/leads',
          name: 'Leads',
          icon: Target,
          badge: leadsLocked ? 0 : newLeads,
          locked: leadsLocked,
          lockedReason: 'Lead capture and the leads dashboard are included on Starter and above.',
          lockedIntent: 'view_leads',
        },
        // Qualification (BANT) is a Standard+ feature. We render it on
        // every paid surface AND on Free with a lock badge so the value
        // is discoverable from the sidebar — same upsell pattern as Leads
        // and Integrations. Click on Free opens the upgrade modal instead
        // of routing into a backend-403'd page.
        {
          path: '/qualification',
          name: 'Qualification',
          icon: Crosshair,
          locked: !ent.hasFeature('bant'),
          lockedReason: 'Lead qualification (BANT) is included on Standard and above.',
          lockedIntent: 'view_qualification',
        },
        // Integrations covers webhooks, meeting booking, and per-event
        // email routing — all paid surfaces. Free users handle the email
        // basics they actually need from Settings → Visitor Messages, so
        // the sidebar locks the whole page rather than presenting an
        // Integrations page with one usable tab and two locked ones.
        {
          path: '/integrations',
          name: 'Integrations',
          icon: Plug,
          locked: ent.isFree,
          lockedReason: 'Webhooks, meetings, and per-event email routing are included on Starter and above.',
          lockedIntent: 'view_integrations',
        },
      ];

  // Affiliate entry slots between Team and Billing so it sits alongside
  // the other "your-account" tools rather than under "Main" (which is
  // workspace-data oriented).
  const configItems = isOperatorRole
    ? [{ path: '/team', name: 'Team', icon: UsersRound }]
    : [
        { path: '/chatbot', name: 'My Bots', icon: Bot, children: [
          { path: '/chatbot?tab=appearance', name: 'Appearance', icon: Palette },
        ] },
        // Team management (operators, departments, canned responses) only
        // makes sense when live chat is on. Locking at the sidebar gives
        // Free users a consistent upsell surface — same pattern as Leads
        // / Qualification / Integrations. Operators logged in as their
        // role above keep their unlocked Team item; they can only exist
        // on paid plans by definition.
        {
          path: '/team',
          name: 'Team',
          icon: UsersRound,
          locked: !ent.hasFeature('live_chat'),
          lockedReason: 'Operators, departments, and quick replies are included on Starter and above.',
          lockedIntent: 'view_team',
        },
        ...(isAffiliate ? [{ path: '/affiliate', name: 'Affiliate', icon: Gift }] : []),
        { path: '/billing', name: 'Billing', icon: CreditCard },
      ];

  const isActive = (item) => {
    if (item.path.includes('?')) {
      const [pathname, search] = item.path.split('?');
      return location.pathname === pathname && location.search === `?${search}`;
    }
    return location.pathname === item.path ||
      (item.path !== '/' && location.pathname.startsWith(item.path));
  };

  const isParentActive = (item) =>
    item.path !== '/' && location.pathname.startsWith(item.path.split('?')[0]);

  const renderLink = (item, index) => {
    const Icon = item.icon;
    const active = isActive(item);
    const parentActive = isParentActive(item);
    const hasBadge = item.badge > 0;
    const hasChildren = item.children?.length > 0;
    const menuKey = item.path;
    const isExpanded = hasChildren && (expandedMenus[menuKey] ?? parentActive);
    return (
      <motion.div
        key={item.path}
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.2, delay: index * 0.03 }}
      >
        <NavLink
          to={item.locked ? '#' : item.path}
          onClick={(e) => {
            // Locked items open the premium upsell modal in place of
            // navigation. We deliberately do NOT navigate to /billing
            // here — the modal explains the value first; the user is
            // one click from /billing inside the modal if they want it.
            if (item.locked) {
              e.preventDefault();
              requestUpgrade(item.lockedIntent || 'view_support');
              handleNavClick();
              return;
            }
            if (hasChildren && parentActive) {
              e.preventDefault();
              setExpandedMenus((prev) => ({ ...prev, [menuKey]: !isExpanded }));
              return;
            }
            if (hasChildren) {
              setExpandedMenus((prev) => ({ ...prev, [menuKey]: true }));
            }
            handleNavClick();
          }}
          className={cn(
            'relative flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-200 group',
            isOpen ? 'w-full' : 'w-10 h-10 justify-center',
            active && !item.locked
              ? 'bg-primary-50 dark:bg-white/[0.08] text-primary-700 dark:text-white'
              : item.locked
                ? 'text-surface-400 dark:text-surface-500 hover:bg-surface-100/60 dark:hover:bg-white/[0.04] hover:text-surface-500 dark:hover:text-surface-400'
                : 'text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-white/[0.05] hover:text-surface-700 dark:hover:text-surface-200'
          )}
          title={!isOpen ? `${item.name}${item.locked ? ' (Upgrade required)' : ''}` : undefined}
          aria-label={`${item.name}${item.locked ? ' — upgrade required' : ''}`}
        >
          {active && (
            <motion.div
              layoutId="sidebar-active"
              className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary-500 rounded-r-full"
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            />
          )}
          <div className="relative flex-shrink-0">
            <Icon
              size={18}
              className={cn(
                'transition-colors',
                item.locked
                  ? 'text-surface-300 dark:text-surface-600 group-hover:text-surface-400 dark:group-hover:text-surface-500'
                  : active ? 'text-primary-500 dark:text-primary-400' : 'text-surface-400 dark:text-surface-500 group-hover:text-surface-600 dark:group-hover:text-surface-300'
              )}
            />
            {/* Collapsed-sidebar locked indicator: replaces the badge dot with
                a tiny lock so the gated state is visible even when only the
                icon column is showing. Mutually exclusive with the badge. */}
            {item.locked && !isOpen && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-amber-500 rounded-full flex items-center justify-center">
                <Lock size={8} className="text-white" strokeWidth={3} />
              </span>
            )}
            {hasBadge && !isOpen && !item.locked && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-rose-500 rounded-full text-[8px] text-white flex items-center justify-center font-bold leading-none">
                {item.badge > 9 ? '9+' : item.badge}
              </span>
            )}
          </div>
          {isOpen && (
            <>
              <span className={cn('truncate text-[13px] font-medium flex-1', item.locked && 'text-surface-400 dark:text-surface-500')}>{item.name}</span>
              {/* Expanded-sidebar locked indicator: a small lock pill next to
                  the label, with the upgrade reason as a tooltip. Renders in
                  place of any unread badge — the customer can't act on the
                  badge anyway until they upgrade. */}
              {item.locked && (
                <span
                  className="ml-auto inline-flex items-center justify-center w-5 h-5 rounded-md bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  title={item.lockedReason || 'Upgrade required'}
                  aria-hidden="true"
                >
                  <Lock size={11} strokeWidth={2.5} />
                </span>
              )}
              {hasBadge && !item.locked && (
                <span className="ml-auto min-w-[18px] h-[18px] px-1 bg-rose-500 rounded-full text-[10px] text-white flex items-center justify-center font-bold leading-none">
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
              {hasChildren && (
                <ChevronDown
                  size={14}
                  className={cn(
                    'ml-auto text-surface-400 dark:text-surface-500 transition-transform duration-200',
                    isExpanded && 'rotate-180'
                  )}
                />
              )}
            </>
          )}
        </NavLink>
        {hasChildren && isOpen && isExpanded && (
          <div className="ml-7 mt-0.5 space-y-0.5">
            {item.children.map((child) => {
              const ChildIcon = child.icon;
              const childActive = isActive(child);
              return (
                <NavLink
                  key={child.path}
                  to={child.path}
                  onClick={handleNavClick}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-150',
                    childActive
                      ? 'text-primary-600 dark:text-primary-400 bg-primary-50/60 dark:bg-white/[0.05]'
                      : 'text-surface-400 dark:text-surface-500 hover:text-surface-700 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-white/[0.04]'
                  )}
                >
                  <ChildIcon size={14} className={childActive ? 'text-primary-500 dark:text-primary-400' : 'text-surface-400 dark:text-surface-500'} />
                  {child.name}
                </NavLink>
              );
            })}
          </div>
        )}
      </motion.div>
    );
  };

  const sidebarClasses = isMobile
    ? cn(
        'fixed top-0 left-0 h-screen z-30 flex flex-col w-60 transition-transform duration-300',
        isOpen ? 'translate-x-0' : '-translate-x-full'
      )
    : cn(
        'fixed top-0 left-0 h-screen overflow-hidden z-30 transition-all duration-300 flex flex-col',
        isOpen ? 'w-60' : 'w-[68px]'
      );

  return (
    <aside className={cn(sidebarClasses, 'bg-white dark:bg-surface-950 border-r border-surface-200 dark:border-surface-800/50')}>
      {/* Logo */}
      <div className="flex items-center h-16 px-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 overflow-hidden flex items-center justify-center flex-shrink-0">
            <OyeChatsMark size={36} />
          </div>
          {isOpen && (
            <motion.span
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-[15px] font-bold text-surface-900 dark:text-white tracking-tight"
            >
              {localStorage.getItem('company_name') || 'OyeChats'}
            </motion.span>
          )}
        </div>
      </div>

      {/* Bot Selector */}
      {isOpen && (
        <div className="px-3 pb-2" ref={dropdownRef}>
          {loading ? (
            <div className="h-9 rounded-lg bg-surface-100 dark:bg-surface-800 animate-pulse" />
          ) : botError ? (
            <div className="w-full rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
              <p className="text-[11px] font-semibold text-amber-300">Bots unavailable</p>
              <p className="mt-1 text-[10px] text-amber-200/80">Could not load workspace bots.</p>
            </div>
          ) : bots.length === 0 ? (
            isBotManager ? (
              <NavLink
                to="/chatbot"
                onClick={handleNavClick}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-dashed border-surface-300 dark:border-surface-700 bg-surface-50 dark:bg-surface-900/50 hover:bg-surface-100 dark:hover:bg-surface-800 transition-all text-left"
              >
                <div className="w-6 h-6 rounded-md bg-primary-500/10 flex items-center justify-center flex-shrink-0">
                  <Plus size={13} className="text-primary-400" />
                </div>
                <p className="text-[12px] font-semibold text-primary-400 truncate">Create a Chatbot</p>
              </NavLink>
            ) : (
              <div className="w-full rounded-lg border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900/50 px-3 py-2">
                <p className="text-[11px] font-semibold text-surface-700 dark:text-surface-200">No workspace bots</p>
                <p className="mt-1 text-[10px] text-surface-500 dark:text-surface-400">An owner or admin needs to add one.</p>
              </div>
            )
          ) : (
            <div className="relative">
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-50 dark:bg-surface-900/80 border border-surface-200 dark:border-surface-800 hover:border-surface-300 dark:hover:border-surface-700 transition-all text-left group"
              >
                <div className="w-6 h-6 rounded-md bg-primary-500/15 flex items-center justify-center flex-shrink-0">
                  <Bot size={13} className="text-primary-400" />
                </div>
                <p className="text-[12px] font-semibold text-surface-700 dark:text-surface-200 truncate flex-1">
                  {selectedBot?.name || 'Select a Bot'}
                </p>
                <ChevronDown size={14} className={cn('text-surface-500 transition-transform', dropdownOpen && 'rotate-180')} />
              </button>

              <AnimatePresence>
                {dropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.15 }}
                    className="absolute left-0 right-0 mt-1 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 rounded-xl shadow-xl overflow-hidden z-50"
                  >
                    <div className="max-h-48 overflow-y-auto py-1">
                      {bots.map((bot) => (
                        <button
                          key={bot.id}
                          onClick={() => { selectBot(bot); setDropdownOpen(false); }}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors',
                            selectedBot?.id === bot.id && 'bg-surface-100 dark:bg-surface-800/50'
                          )}
                        >
                          <div className="w-5 h-5 rounded-md bg-surface-100 dark:bg-surface-800 flex items-center justify-center flex-shrink-0">
                            <Bot size={11} className="text-surface-500 dark:text-surface-400" />
                          </div>
                          <span className="text-[12px] font-medium text-surface-700 dark:text-surface-300 truncate flex-1">{bot.name}</span>
                          {selectedBot?.id === bot.id && <Check size={13} className="text-primary-400 flex-shrink-0" />}
                        </button>
                      ))}
                    </div>
                    {isBotManager && (
                      <div className="border-t border-surface-200 dark:border-surface-800">
                        <button
                          onClick={handleCreateBot}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-primary-500 dark:text-primary-400 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                        >
                          <Plus size={13} />
                          Create new bot
                        </button>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      )}

      {/* Collapsed bot indicator */}
      {!isOpen && !isMobile && (
        <div className="flex justify-center pb-2">
          {loading ? (
            <div className="w-9 h-9 rounded-lg bg-surface-100 dark:bg-surface-800 animate-pulse" />
          ) : selectedBot ? (
            <div className="w-9 h-9 rounded-lg bg-primary-500/10 flex items-center justify-center" title={selectedBot.name}>
              <Bot size={15} className="text-primary-400" />
            </div>
          ) : isBotManager ? (
            <NavLink to="/chatbot" className="w-9 h-9 rounded-lg bg-white dark:bg-surface-900 border border-dashed border-surface-300 dark:border-surface-700 flex items-center justify-center" title="Create a chatbot">
              <Plus size={15} className="text-surface-500" />
            </NavLink>
          ) : (
            <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 flex items-center justify-center" title="No workspace bots">
              <Bot size={15} className="text-surface-600" />
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 space-y-0.5 mt-2">
        {isOpen && <p className="px-3 pt-2 pb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-surface-400 dark:text-surface-600">Main</p>}
        {mainItems.map((item, i) => renderLink(item, i))}

        <div className="pt-4">
          {isOpen && <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-surface-400 dark:text-surface-600">Configure</p>}
          {!isOpen && !isMobile && <div className="border-t border-surface-200 dark:border-surface-800 mb-2 mx-2" />}
          {configItems.map((item, i) => renderLink(item, i))}
        </div>
      </nav>

      {/* Bottom: Settings link only — the user identity card lives in TopBar's
          profile dropdown, so showing the avatar + name here is duplicate. */}
      <div className="shrink-0 p-3 border-t border-surface-200 dark:border-surface-800/50">
        <NavLink
          to="/settings"
          onClick={handleNavClick}
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-xl transition-all group',
            isOpen ? 'w-full' : 'w-10 h-10 justify-center',
            location.pathname.startsWith('/settings')
              ? 'bg-primary-50 dark:bg-white/[0.08] text-primary-700 dark:text-white'
              : 'text-surface-500 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-white/[0.05] hover:text-surface-700 dark:hover:text-surface-200'
          )}
          title={!isOpen ? 'Settings' : undefined}
          aria-label="Settings"
        >
          <Settings size={18} className="shrink-0" />
          {isOpen && (
            <span className="text-[13px] font-medium truncate">Settings</span>
          )}
        </NavLink>
      </div>
    </aside>
  );
}
