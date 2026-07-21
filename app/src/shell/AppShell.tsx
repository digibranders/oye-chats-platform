import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { cn } from '../design-system';

const MOBILE_BREAKPOINT = 768;
const COLLAPSE_KEY = 'oc_sidebar_collapsed';

function readCollapsed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(COLLAPSE_KEY) === 'true';
}

/**
 * AppShell — the global layout. Owns the responsive sidebar/topbar chrome and
 * the command-palette state, and renders routed pages through `<Outlet />`.
 * This is the layout route wrapping the entire authenticated app.
 */
export function AppShell() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  );
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Track viewport → mobile drawer vs. desktop rail.
  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth < MOBILE_BREAKPOINT;
      setIsMobile(mobile);
      if (!mobile) setMobileOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Persist desktop collapse preference.
  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  // ⌘K / Ctrl-K opens the command palette.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (isMobile) setMobileOpen((open) => !open);
    else setCollapsed((value) => !value);
  }, [isMobile]);

  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const openSearch = useCallback(() => setPaletteOpen(true), []);

  const contentMargin = isMobile ? 'ml-0' : collapsed ? 'ml-[68px]' : 'ml-60';

  return (
    <div className="min-h-screen bg-[var(--ds-bg-canvas)] text-[var(--ds-text)]">
      {/* Mobile backdrop */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 backdrop-blur-sm"
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      <Sidebar
        collapsed={collapsed}
        isMobile={isMobile}
        mobileOpen={mobileOpen}
        onNavigate={closeMobile}
      />

      <div className={cn('flex min-h-screen flex-col transition-[margin] duration-300', contentMargin)}>
        <TopBar isMobile={isMobile} onToggleSidebar={toggleSidebar} onOpenSearch={openSearch} />
        <main className="flex-1 px-4 py-6 md:px-6 md:py-8">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
