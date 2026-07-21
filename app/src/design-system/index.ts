/**
 * Design System — public barrel.
 * Import shared UI from here: `import { Button, Card, PageContainer } from '@/design-system'`
 * (or via relative path). Tokens live in `tokens.css` (imported once at the app entry).
 */

// Theme
export { ThemeProvider } from './theme/ThemeProvider';
export { useTheme } from './theme/theme-context';
export type { Theme, ResolvedTheme, ThemeContextValue } from './theme/theme-context';

// Utilities
export { cn } from './lib/cn';

// Primitives
export { Button } from './primitives/Button';
export type { ButtonProps } from './primitives/Button';
export { Card, CardHeader, CardTitle, CardContent, CardFooter } from './primitives/Card';
export { StatusBadge } from './primitives/Badge';
export type { StatusBadgeProps } from './primitives/Badge';
export { Skeleton } from './primitives/Skeleton';

// Composite components
export { SectionHeader } from './components/SectionHeader';
export type { SectionHeaderProps } from './components/SectionHeader';
export { EmptyState } from './components/EmptyState';
export type { EmptyStateProps } from './components/EmptyState';
export { PageContainer } from './components/PageContainer';
export type { PageContainerProps } from './components/PageContainer';
export { Breadcrumbs } from './components/Breadcrumbs';
export type { Crumb, BreadcrumbsProps } from './components/Breadcrumbs';
