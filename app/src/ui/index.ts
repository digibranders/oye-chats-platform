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
  formatBadgeCount,
  truncateId,
} from './lib/formatters';

/* ------------------------------------------------------------ primitives */
export { Button } from './primitives/Button';
export type { ButtonProps } from './primitives/Button';
export { buttonClass, BUTTON_ICON, BUTTON_ICON_SLOT } from './primitives/buttonStyles';
export type { ButtonVariant, ButtonSize } from './primitives/buttonStyles';
export {
  controlClass,
  splitControlClass,
  CONTROL_SIZE,
  DISABLED_CONTROL,
  DISABLED_FILLED,
  HIT_AREA,
  FOCUS_RING,
} from './primitives/controlStyles';
export type { ControlSize, ControlGeometry } from './primitives/controlStyles';
export { ColorInput } from './primitives/ColorInput';
export type { ColorInputProps } from './primitives/ColorInput';
export { Badge, StatusDot, WorkingDots } from './primitives/Badge';
export type { BadgeProps, BadgeTone, StatusDotProps, Tone } from './primitives/Badge';
export { Avatar } from './primitives/Avatar';
export type { AvatarProps, AvatarSize } from './primitives/Avatar';
export { Field, FieldSet } from './primitives/Field';
export type { FieldProps } from './primitives/Field';
export { useField, useFieldControlProps, useFieldGroupProps } from './primitives/fieldContext';
export type { FieldContextValue } from './primitives/fieldContext';
export { Input, Textarea, CONTROL_BASE } from './primitives/Input';
export type { InputProps, TextareaProps } from './primitives/Input';
export { Select } from './primitives/Select';
export type { SelectProps, SelectOption } from './primitives/Select';
export { DatePicker } from './primitives/DatePicker';
export type { DatePickerProps } from './primitives/DatePicker';
export { DateTimePicker } from './primitives/DateTimePicker';
export type { DateTimePickerProps } from './primitives/DateTimePicker';
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
export { RadioCards } from './primitives/RadioCards';
export type { RadioCardsProps, RadioCardItem } from './primitives/RadioCards';
export { Progress, Meter } from './primitives/Progress';
export type { ProgressProps, MeterProps } from './primitives/Progress';
export { Skeleton, SkeletonText } from './primitives/Skeleton';
export { Spinner } from './primitives/Spinner';
export { Separator, Kbd, Eyebrow, EYEBROW_CLASS } from './primitives/Misc';
export { isMacPlatform, modifierKey } from './lib/platform';
export { validateEmail, validateUrl, normalizeUrl, isHexColor } from './lib/validators';

/* ---------------------------------------------------------------- layout
   The layout layer. It did not exist until this pass, which is why 88
   hand-written `grid-cols-*` strings grew in `features/` and every page whose
   author did not write one rendered as a single column of full-width cards.
   `Stack` sets the rhythm BETWEEN sections; it is not how peers are arranged. */
export { Card, CardHeader, CardBody, CardSection, CardFooter, Well } from './layout/Card';
export type { CardProps, CardHeaderProps, WellProps } from './layout/Card';
export { Page, PageHeader, Section, Stack, Toolbar } from './layout/Page';
export type { PageProps, PageHeaderProps, SectionProps, PageWidth } from './layout/Page';
export { Grid } from './layout/Grid';
export type { GridProps } from './layout/Grid';
export { Measure } from './layout/Measure';
export type { MeasureProps, MeasureWidth } from './layout/Measure';
export { Columns } from './layout/Columns';
export type { ColumnsProps } from './layout/Columns';
export { SidebarLayout } from './layout/SidebarLayout';
export type { SidebarLayoutProps } from './layout/SidebarLayout';
export { SplitPane } from './layout/SplitPane';
export type { SplitPaneProps } from './layout/SplitPane';
export { PaneHeader } from './layout/PaneHeader';
export type { PaneHeaderProps } from './layout/PaneHeader';
export { PropertyGrid } from './layout/PropertyGrid';
export type { PropertyGridProps, PropertyItem } from './layout/PropertyGrid';
export { SettingRow, SettingGroup, SettingBand } from './layout/SettingRow';
export type { SettingRowProps, SettingGroupProps } from './layout/SettingRow';
export { RailFrame, RailItem, RailGroupLabel, RailBackLink } from './layout/RailFrame';
export type { RailFrameProps, RailItemProps } from './layout/RailFrame';
export { Tabs, TabPanel } from './layout/Tabs';
export type { TabsProps, TabItem } from './layout/Tabs';
export { Disclosure } from './layout/Disclosure';
export type { DisclosureProps } from './layout/Disclosure';
export { SaveBar } from './layout/SaveBar';
export type { SaveBarProps } from './layout/SaveBar';
export { NavTabs } from './layout/NavTabs';
export type { NavTabsProps, NavTabItem } from './layout/NavTabs';

/* -------------------------------------------------------------- overlays */
export { Dialog } from './overlays/Dialog';
export type { DialogProps, DialogSize } from './overlays/Dialog';
export { Drawer } from './overlays/Drawer';
export type { DrawerProps, DrawerWidth } from './overlays/Drawer';
export { ConfirmDialog } from './overlays/ConfirmDialog';
export type { ConfirmDialogProps } from './overlays/ConfirmDialog';
export { PurchaseDialog, PurchaseSuccess } from './overlays/PurchaseDialog';
export type {
  PurchaseDialogProps,
  PurchasePhase,
  PurchaseSuccessProps,
} from './overlays/PurchaseDialog';
export {
  MenuRoot,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuCheckboxItem,
  MenuGroup,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubContent,
} from './overlays/Menu';
export {
  PopoverRoot,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverBody,
  PopoverFooter,
  PopoverClose,
} from './overlays/Popover';
export { Tooltip, TooltipProvider } from './overlays/Tooltip';
export type { TooltipProps } from './overlays/Tooltip';
export { Toaster } from './overlays/Toaster';
export { toast } from './overlays/toast';

/* -------------------------------------------------------------- feedback */
export { Alert } from './feedback/Alert';
export type { AlertProps } from './feedback/Alert';

/* ------------------------------------------------------------------ data */
export { DataTable } from './data/DataTable';
export type {
  DataTableProps,
  Column,
  ColumnType,
  SortState,
  SortDirection,
} from './data/DataTable';
export { ZoomPanCanvas } from './data/ZoomPanCanvas';
export type { ZoomPanCanvasProps } from './data/ZoomPanCanvas';
export {
  EmptyState,
  ErrorState,
  LockedState,
  FullPageState,
  LoadingRows,
  LoadingBars,
  LoadingConversations,
} from './data/States';
export type {
  EmptyStateProps,
  ErrorStateProps,
  LockedStateProps,
  FullPageStateProps,
  StateSize,
  StateAlign,
} from './data/States';
export { DayDivider } from './data/DayDivider';
export type { DayDividerProps } from './data/DayDivider';
export { StatTile, StatRow, FigureRow, FigureList, DefinitionList } from './data/Figures';
export type {
  StatTileProps,
  StatRowProps,
  DefinitionListProps,
  TrendDirection,
} from './data/Figures';
export { CopyField, CodeBlock } from './data/Copyable';
export type { CopyFieldProps, CodeBlockProps } from './data/Copyable';
export { useClipboard } from './hooks/useClipboard';
export { useMediaQuery } from './hooks/useMediaQuery';
export type { ClipboardState } from './hooks/useClipboard';

/* ---------------------------------------------------------------- charts */
export {
  CHART_SERIES,
  CHART_DASH,
  CHART_AXIS,
  CHART_GRID,
  CHART_MARGIN,
  CHART_CURSOR,
  CHART_TICK_PX,
  seriesColor,
  seriesDash,
} from './charts/theme';
export { ChartFrame, ChartLegend } from './charts/ChartFrame';
export type { ChartFrameProps, ChartLegendItem } from './charts/ChartFrame';
export { ChartTooltip } from './charts/ChartTooltip';
export type { ChartTooltipProps, ChartTooltipRow } from './charts/ChartTooltip';
export { ChartDataTable } from './charts/ChartDataTable';
export type { ChartDataTableProps, ChartDataColumn } from './charts/ChartDataTable';
export { RankedBars } from './charts/RankedBars';
export type { RankedBar, RankedBarsProps } from './charts/RankedBars';
