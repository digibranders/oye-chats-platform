import { Construction, type LucideIcon } from 'lucide-react';
import { PageContainer, EmptyState } from '../design-system';

export interface PagePlaceholderProps {
  title: string;
  description?: string;
  /** Rebuild phase that will deliver this surface (shown in the placeholder). */
  phase?: number;
  icon?: LucideIcon;
}

/**
 * PagePlaceholder - a foundation-only page. Phase 1 ships the shell, routing,
 * and design system; real pages arrive in later phases. Every route renders one
 * of these so the IA is fully navigable and breadcrumbs/active-state can be
 * verified before any page is built.
 */
export function PagePlaceholder({ title, description, phase, icon = Construction }: PagePlaceholderProps) {
  return (
    <PageContainer title={title} description={description}>
      <EmptyState
        icon={icon}
        title="This surface is coming soon"
        description={
          phase
            ? `“${title}” is part of Phase ${phase} of the Admin 2.0 rebuild. The foundation (shell, navigation, routing, design system) is in place - the page itself lands in a later phase.`
            : `“${title}” will be built in a later phase of the Admin 2.0 rebuild.`
        }
      />
    </PageContainer>
  );
}
