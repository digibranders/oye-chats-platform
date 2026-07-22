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
export { buttonVariants } from './primitives/buttonVariants';
export type { ButtonVariantProps } from './primitives/buttonVariants';
export { Card, CardHeader, CardTitle, CardContent, CardFooter } from './primitives/Card';
export { StatusBadge } from './primitives/Badge';
export type { StatusBadgeProps } from './primitives/Badge';
export { Skeleton } from './primitives/Skeleton';
export { Input } from './primitives/Input';
export type { InputProps } from './primitives/Input';
export { Progress } from './primitives/Progress';
export type { ProgressProps } from './primitives/Progress';

// Composite components
export { SectionHeader } from './components/SectionHeader';
export type { SectionHeaderProps } from './components/SectionHeader';
export { EmptyState } from './components/EmptyState';
export type { EmptyStateProps } from './components/EmptyState';
export { PageContainer } from './components/PageContainer';
export type { PageContainerProps } from './components/PageContainer';
export { Breadcrumbs } from './components/Breadcrumbs';
export type { Crumb, BreadcrumbsProps } from './components/Breadcrumbs';
export { ProgressStepper } from './components/ProgressStepper';
export type { ProgressStepperProps, StepperItem } from './components/ProgressStepper';

// Composite components — Admin 2.0 page kit
export { MetricCard } from './components/MetricCard';
export type { MetricCardProps, MetricTrend } from './components/MetricCard';
export { InsightCard } from './components/InsightCard';
export type { InsightCardProps, InsightTone } from './components/InsightCard';
export { ActionCard } from './components/ActionCard';
export type { ActionCardProps } from './components/ActionCard';
export { AgentCard } from './components/AgentCard';
export type { AgentCardProps, AgentCardStatus, AgentCardMetric } from './components/AgentCard';
export { ConversationCard } from './components/ConversationCard';
export type { ConversationCardProps, ConversationStatus } from './components/ConversationCard';
export { QuickAction } from './components/QuickAction';
export type { QuickActionProps } from './components/QuickAction';
export { ActivityTimeline } from './components/ActivityTimeline';
export type { ActivityTimelineProps, ActivityItem, ActivityTone } from './components/ActivityTimeline';
export { DataTable } from './components/DataTable';
export type { DataTableProps, Column, ColumnAlign } from './components/DataTable';
export { Tabs } from './components/Tabs';
export type { TabsProps, TabItem } from './components/Tabs';
export { Modal } from './components/Modal';
export type { ModalProps, ModalSize } from './components/Modal';
export { Popover } from './components/Popover';
export type { PopoverProps, PopoverAlign, PopoverTriggerProps } from './components/Popover';
