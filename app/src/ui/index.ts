/**
 * The console's design system — the single public surface.
 *
 * Everything visual is imported from here. A feature may not define a primitive:
 * if a screen needs one that does not exist, it is added to this directory
 * first. That rule is the whole point of the file. The system it replaces had
 * three parallel component libraries, seven Toggle implementations, five
 * drawers, six chart palettes and twelve copies of one loading block, because
 * there was nowhere that owned any of them.
 */

/* ------------------------------------------------------------------- lib */
export { cn } from './lib/cn';
export {
  ABSENT,
  formatNumber,
  formatCompact,
  formatMoney,
  formatPercent,
  formatBytes,
  formatDate,
  formatDateTime,
  formatTime,
  formatRelative,
  formatDuration,
  truncateId,
} from './lib/formatters';

/* ------------------------------------------------------------ primitives */
export { Button } from './primitives/Button';
export type { ButtonProps } from './primitives/Button';
export { buttonClass } from './primitives/buttonStyles';
export type { ButtonVariant, ButtonSize } from './primitives/buttonStyles';
export { Badge, StatusDot } from './primitives/Badge';
export type { BadgeProps, StatusDotProps, Tone } from './primitives/Badge';
export { Avatar } from './primitives/Avatar';
export type { AvatarProps, AvatarSize } from './primitives/Avatar';
export { Field, FieldSet } from './primitives/Field';
export type { FieldProps } from './primitives/Field';
export { useField, useFieldControlProps } from './primitives/fieldContext';
export type { FieldContextValue } from './primitives/fieldContext';
export { Input, Textarea, CONTROL_BASE } from './primitives/Input';
export type { InputProps, TextareaProps } from './primitives/Input';
export { Select } from './primitives/Select';
export type { SelectProps, SelectOption } from './primitives/Select';
export { Combobox } from './primitives/Combobox';
export type { ComboboxProps, ComboboxOption } from './primitives/Combobox';
export { SearchField } from './primitives/SearchField';
export type { SearchFieldProps } from './primitives/SearchField';
export { TagInput } from './primitives/TagInput';
export type { TagInputProps } from './primitives/TagInput';
export { FileDrop } from './primitives/FileDrop';
export type { FileDropProps } from './primitives/FileDrop';
export { Checkbox, Switch } from './primitives/Toggle';
export type { CheckboxProps, SwitchProps, CheckedState } from './primitives/Toggle';
export { SegmentedControl } from './primitives/SegmentedControl';
export type { SegmentedControlProps, SegmentedItem } from './primitives/SegmentedControl';
export { Progress, Meter } from './primitives/Progress';
export type { ProgressProps, MeterProps } from './primitives/Progress';
export { Skeleton, SkeletonText } from './primitives/Skeleton';
export { Spinner } from './primitives/Spinner';
export { Separator, Kbd, Eyebrow } from './primitives/Misc';
export { isMacPlatform, modifierKey } from './lib/platform';
export { validateEmail, validateUrl, normalizeUrl } from './lib/validators';

/* ---------------------------------------------------------------- layout */
export { Card, CardHeader, CardBody, CardSection, CardFooter } from './layout/Card';
export type { CardProps, CardHeaderProps } from './layout/Card';
export { Page, PageHeader, Section, Stack, Toolbar } from './layout/Page';
export type { PageProps, PageHeaderProps, SectionProps, PageWidth } from './layout/Page';
export { Tabs, TabPanel } from './layout/Tabs';
export type { TabsProps, TabItem } from './layout/Tabs';

/* -------------------------------------------------------------- overlays */
export { Dialog } from './overlays/Dialog';
export type { DialogProps, DialogSize } from './overlays/Dialog';
export { Drawer } from './overlays/Drawer';
export type { DrawerProps, DrawerWidth } from './overlays/Drawer';
export { ConfirmDialog } from './overlays/ConfirmDialog';
export type { ConfirmDialogProps } from './overlays/ConfirmDialog';
export {
  MenuRoot,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuCheckboxItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubContent,
} from './overlays/Menu';
export { PopoverRoot, PopoverTrigger, PopoverContent, PopoverClose } from './overlays/Popover';
export { Tooltip, TooltipProvider } from './overlays/Tooltip';
export type { TooltipProps } from './overlays/Tooltip';
export { Toaster } from './overlays/Toast';
export { toast } from './overlays/toast';

/* -------------------------------------------------------------- feedback */
export { Alert } from './feedback/Alert';
export type { AlertProps } from './feedback/Alert';

/* ------------------------------------------------------------------ data */
export { DataTable } from './data/DataTable';
export type { DataTableProps, Column, SortState, SortDirection } from './data/DataTable';
export { EmptyState, ErrorState, LockedState, LoadingRows } from './data/States';
export type { EmptyStateProps, ErrorStateProps, LockedStateProps } from './data/States';
export { StatTile, FigureRow, DefinitionList } from './data/Figures';
export type { StatTileProps, TrendDirection } from './data/Figures';
export { CopyField, CodeBlock } from './data/Copyable';
export { useClipboard } from './hooks/useClipboard';
export { useMediaQuery } from './hooks/useMediaQuery';
export type { ClipboardState } from './hooks/useClipboard';
export type { CopyFieldProps, CodeBlockProps } from './data/Copyable';

/* ---------------------------------------------------------------- charts */
export { CHART_SERIES, CHART_DASH, CHART_AXIS, CHART_GRID, CHART_MARGIN, seriesColor, seriesDash } from './charts/theme';
export { ChartFrame, ChartLegend } from './charts/ChartFrame';
export type { ChartFrameProps, ChartLegendItem } from './charts/ChartFrame';
