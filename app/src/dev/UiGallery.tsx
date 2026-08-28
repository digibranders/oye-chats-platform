import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3,
  Bot,
  CreditCard,
  Download,
  FileText,
  Globe,
  Inbox,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import {
  ABSENT,
  Alert,
  Avatar,
  Badge,
  BUTTON_ICON,
  BUTTON_ICON_SLOT,
  Button,
  buttonClass,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardSection,
  CHART_AXIS,
  CHART_CURSOR,
  CHART_DASH,
  CHART_GRID,
  CHART_MARGIN,
  CHART_SERIES,
  CHART_TICK_PX,
  ChartDataTable,
  ChartFrame,
  ChartLegend,
  ChartTooltip,
  Checkbox,
  cn,
  CodeBlock,
  ColorInput,
  Columns,
  Combobox,
  CONTROL_BASE,
  CONTROL_SIZE,
  ConfirmDialog,
  PurchaseDialog,
  PurchaseSuccess,
  type PurchasePhase,
  controlClass,
  CopyField,
  DataTable,
  DatePicker,
  DateTimePicker,
  DefinitionList,
  Dialog,
  Disclosure,
  DISABLED_CONTROL,
  DISABLED_FILLED,
  Drawer,
  EmptyState,
  ErrorState,
  Eyebrow,
  EYEBROW_CLASS,
  Field,
  FieldSet,
  FigureList,
  FigureRow,
  FileDrop,
  FOCUS_RING,
  FullPageState,
  Grid,
  HIT_AREA,
  Input,
  isHexColor,
  isMacPlatform,
  Kbd,
  LoadingBars,
  LoadingConversations,
  LoadingRows,
  LockedState,
  Measure,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Meter,
  modifierKey,
  NavTabs,
  normalizeUrl,
  Page,
  PageHeader,
  PaneHeader,
  PopoverBody,
  PopoverClose,
  PopoverContent,
  PopoverFooter,
  PopoverHeader,
  PopoverRoot,
  PopoverTrigger,
  Progress,
  PropertyGrid,
  RadioCards,
  RailBackLink,
  RailFrame,
  RailGroupLabel,
  RailItem,
  RankedBars,
  SaveBar,
  SearchField,
  Section,
  SegmentedControl,
  Select,
  Separator,
  SettingBand,
  SettingGroup,
  SettingRow,
  SidebarLayout,
  Skeleton,
  SkeletonText,
  Spinner,
  SplitPane,
  Stack,
  StatRow,
  StatTile,
  StatusDot,
  Switch,
  TabPanel,
  Tabs,
  TagInput,
  Textarea,
  Toaster,
  Toolbar,
  Tooltip,
  Well,
  TooltipProvider,
  truncateId,
  useClipboard,
  useField,
  useFieldControlProps,
  useMediaQuery,
  validateEmail,
  validateUrl,
  WorkingDots,
  ZoomPanCanvas,
  formatBytes,
  formatCompact,
  formatDate,
  formatDateTime,
  formatBadgeCount,
  formatDuration,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTime,
  seriesColor,
  seriesDash,
  toast,
  type AvatarSize,
  type BadgeTone,
  type Column,
  type ControlSize,
  type DialogSize,
  type DrawerWidth,
  type MeasureWidth,
  type SortState,
  type StateSize,
} from '../ui';

/**
 * The component gallery, at `/dev/ui`.
 *
 * Every phase of this rebuild ends with a review, and a review needs something
 * to look at. Without this page the only way to see a primitive is to find a
 * screen that happens to use it, which means the ones not yet consumed — most
 * of them, early on — go unexamined until they are already load-bearing.
 *
 * It is also the fastest way to catch the class of defect that typechecks
 * cleanly and still looks wrong: a control whose height does not match the
 * input beside it, a tint that vanishes on a selected row, a focus ring that
 * erases the border it lands on.
 *
 * Two rules keep it honest, and both were learned the hard way. **Every export
 * in `src/ui/index.ts` appears here** — eight primitives were exported and never
 * rendered, and the whole popover family was one of them. And **every primitive
 * appears in every state it ships in**, at every size it offers: the last review
 * had to derive from class strings that only the `md` control set was coherent,
 * and a menu with a group label crashed the entire route because no example on
 * this page contained one.
 */

/* ------------------------------------------------------------------ data */

interface Lead {
  id: string;
  name: string;
  company: string;
  score: number;
  status: 'new' | 'qualified' | 'lost';
  question: string;
  lastSeen: string;
}

const LEADS: Lead[] = [
  {
    id: '1',
    name: 'Ana Ruiz',
    company: 'Northwind',
    score: 82,
    status: 'qualified',
    question: 'Does the widget work on Webflow, and can we restyle the launcher?',
    lastSeen: '2026-08-19T09:12:00Z',
  },
  {
    id: '2',
    name: 'Bo Chen',
    company: 'Acme Logistics',
    score: 45,
    status: 'new',
    question: 'How many documents can I upload on the Standard plan?',
    lastSeen: '2026-08-19T08:40:00Z',
  },
  {
    id: '3',
    name: 'Cyrus Mehta',
    company: 'Fynix',
    score: 12,
    status: 'lost',
    question: 'Where are you based?',
    lastSeen: '2026-08-18T17:05:00Z',
  },
  {
    id: '4',
    name: 'Dara Okafor',
    company: 'Beacon Health',
    score: 67,
    status: 'qualified',
    question: 'Can I hand a conversation to a human during office hours?',
    lastSeen: '2026-08-18T11:30:00Z',
  },
  {
    id: '5',
    name: 'Eli Sørensen',
    company: 'Kalmar Freight',
    score: 31,
    status: 'new',
    question: 'Do you support Danish?',
    lastSeen: '2026-08-17T14:02:00Z',
  },
];

const STATUS_TONE = { new: 'neutral', qualified: 'success', lost: 'danger' } as const;

const LEAD_COLUMNS: Column<Lead>[] = [
  {
    key: 'name',
    header: 'Lead',
    pinned: true,
    rowHeader: true,
    width: '14rem',
    render: (row) => (
      <span className="flex items-center gap-2">
        <Avatar name={row.name} size="sm" />
        <span className="min-w-0">
          <span className="block truncate font-medium">{row.name}</span>
          <span className="block truncate text-xs text-text-secondary">{row.company}</span>
        </span>
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <Badge tone={STATUS_TONE[row.status]} dot>
        {row.status}
      </Badge>
    ),
  },
  {
    key: 'question',
    header: 'First question',
    // The one column that is genuinely prose. Everything else is one line.
    wrap: true,
    width: '22rem',
    render: (row) => <span className="text-text-secondary">{row.question}</span>,
  },
  {
    key: 'score',
    header: 'Score',
    type: 'number',
    sortable: (a, b) => a.score - b.score,
    render: (row) => row.score,
  },
  {
    key: 'lastSeen',
    header: 'Last seen',
    secondary: true,
    sortable: (a, b) => a.lastSeen.localeCompare(b.lastSeen),
    render: (row) => <span className="text-text-secondary">{formatDateTime(row.lastSeen)}</span>,
  },
];

interface TrafficPoint {
  day: string;
  messages: number;
  conversations: number;
}

const TRAFFIC: TrafficPoint[] = [
  { day: '10 Aug', messages: 318, conversations: 74 },
  { day: '11 Aug', messages: 402, conversations: 91 },
  { day: '12 Aug', messages: 412, conversations: 96 },
  { day: '13 Aug', messages: 366, conversations: 88 },
  { day: '14 Aug', messages: 291, conversations: 63 },
  { day: '15 Aug', messages: 344, conversations: 79 },
  { day: '16 Aug', messages: 381, conversations: 84 },
];

/* --------------------------------------------------------------- helpers */

/** A labelled specimen. The eyebrow names the variant being looked at. */
function Demo({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <Eyebrow className="mb-1.5">{label}</Eyebrow>
      {children}
    </div>
  );
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="min-w-0">
      <div className={`h-12 rounded-md border border-border ${className}`} />
      <p className="mt-1.5 truncate font-mono text-2xs text-text-tertiary">{name}</p>
    </div>
  );
}

/**
 * A fixed-width slot in the size matrix.
 *
 * Every field in the system is `w-full`, which is right in a form and useless
 * in a comparison: left to themselves the six controls in a row each take the
 * whole line and stack, and stacked controls are exactly what a height
 * mismatch hides behind.
 */
function Slot({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('w-28 shrink-0', className)}>{children}</div>;
}

/** A class-string export, shown as the string it is. */
function ClassToken({ name, value }: { name: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-border py-2 last:border-b-0">
      <p className="font-mono text-2xs text-text-secondary">{name}</p>
      <p className="mt-0.5 break-words font-mono text-2xs text-text-tertiary">{value}</p>
    </div>
  );
}

/**
 * A control the system does not own, wired to its `Field` by the two hooks.
 *
 * `useFieldControlProps` is the reason a feature can add a one-off control
 * without re-deriving `aria-describedby`, `aria-invalid` and the disabled
 * inheritance that a hand-rolled form gets wrong every time.
 */
function BespokeControl() {
  const field = useField();
  const wiring = useFieldControlProps();
  return (
    <div className="min-w-0">
      <input
        {...wiring}
        defaultValue="A plain input, wired by the hooks"
        className={cn(CONTROL_BASE, controlClass('md'))}
      />
      <p className="mt-1.5 break-words font-mono text-2xs text-text-tertiary">
        {field
          ? `id=${field.id} · invalid=${String(field.invalid)} · required=${String(field.required)}`
          : 'rendered outside a Field — the hooks return nothing, by design'}
      </p>
    </div>
  );
}

/** Recharts hands the tooltip its payload; `ChartTooltip` owns the look. */
function SeriesTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <ChartTooltip
      label={label as string}
      rows={payload.map((entry, index) => ({
        name: String(entry.name ?? ''),
        value: formatNumber(Number(entry.value ?? 0)),
        seriesIndex: index,
      }))}
    />
  );
}

/* ------------------------------------------------------------ primitives */

const CONTROL_SIZES: ControlSize[] = ['sm', 'md', 'lg'];

/**
 * Every control at every size, one size per row.
 *
 * This card is the test made visible. A height, a radius or a padding
 * disagreement between two controls that share a toolbar is a one-glance defect
 * here and an invisible one in a diff — which is exactly how three of them
 * shipped: the review had to *compute* from the class strings that only the `md`
 * set was coherent, because no page in the app or the gallery ever put `sm`
 * beside `sm`.
 */
function ControlSizeMatrix() {
  const [density, setDensity] = useState<'sm' | 'md'>('md');
  const [owner, setOwner] = useState<string | null>('ana');
  const [tags, setTags] = useState<string[]>(['ops@acme.com']);
  const [brand, setBrand] = useState('#2b54c8');
  const [live, setLive] = useState(true);

  return (
    <Card>
      <CardHeader
        title="Control sizes"
        description="On a sunken strip, so every outer edge is visible. The row is the assertion: same height, same radius, same optical text inset."
      />
      <CardBody className="flex flex-col gap-4">
        {CONTROL_SIZES.map((size) => (
          <div key={size}>
            <Eyebrow className="mb-1.5">
              {size} · {CONTROL_SIZE[size].height.replace('h-control-', '')} ·{' '}
              {CONTROL_SIZE[size].radius}
              {size === 'lg'
                ? ' · select, combobox, segmented control, tag input, colour and switch stop at md'
                : ''}
            </Eyebrow>
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken p-3">
              <Button size={size}>Save</Button>
              <Button size={size} variant="secondary" iconLeft={<Plus aria-hidden />}>
                Add
              </Button>
              <Slot>
                <Input size={size} aria-label={`Name ${size}`} placeholder="Acme Support" />
              </Slot>
              <Slot>
                <SearchField
                  size={size}
                  label={`Search ${size}`}
                  value=""
                  onValueChange={() => {}}
                  placeholder="Search"
                />
              </Slot>
              {size !== 'lg' ? (
                <>
                  <Slot>
                    <Select
                      size={size}
                      label={`Status ${size}`}
                      options={[
                        { value: 'live', label: 'Live' },
                        { value: 'draft', label: 'Draft' },
                      ]}
                    />
                  </Slot>
                  <Slot>
                    <Combobox
                      size={size}
                      label={`Owner ${size}`}
                      options={[
                        { value: 'ana', label: 'Ana Ruiz' },
                        { value: 'bo', label: 'Bo Chen' },
                      ]}
                      value={owner}
                      onValueChange={setOwner}
                      clearable
                    />
                  </Slot>
                  <SegmentedControl
                    size={size}
                    label={`Density ${size}`}
                    value={density}
                    onChange={setDensity}
                    items={[
                      { value: 'sm', label: 'Compact' },
                      { value: 'md', label: 'Comfortable' },
                    ]}
                  />
                  <Slot className="w-56">
                    <TagInput
                      size={size}
                      label={`Recipients ${size}`}
                      values={tags}
                      onValuesChange={setTags}
                      validate={validateEmail}
                    />
                  </Slot>
                  {/* Without its quick picks here: the swatch row wraps, and a
                      wrapped composite says nothing about the row's height. The
                      full control, picks and all, is in the states grid below. */}
                  <Slot className="w-48">
                    <ColorInput
                      size={size}
                      aria-label={`Brand colour ${size}`}
                      value={brand}
                      onChange={setBrand}
                    />
                  </Slot>
                  <Switch
                    size={size}
                    checked={live}
                    onCheckedChange={setLive}
                    label={`Live chat ${size}`}
                    hideLabel
                  />
                </>
              ) : null}
              <Badge tone="success" size={size === 'sm' ? 'sm' : 'md'} dot>
                Live
              </Badge>
              <Spinner size={size} label={null} />
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken p-3">
          <Eyebrow className="w-full">Icon-only buttons · xs, sm, md</Eyebrow>
          <Tooltip content="Settings">
            <Button size="icon-xs" variant="ghost" aria-label="Settings, extra small">
              <Settings aria-hidden />
            </Button>
          </Tooltip>
          <Tooltip content="Settings">
            <Button size="icon-sm" variant="ghost" aria-label="Settings, small">
              <Settings aria-hidden />
            </Button>
          </Tooltip>
          <Tooltip content="Settings">
            <Button size="icon-md" variant="secondary" aria-label="Settings, medium">
              <Settings aria-hidden />
            </Button>
          </Tooltip>
          <span className="text-xs text-text-secondary">
            An icon takes its size from the control that holds it, never from the call site — tab
            through this row to see every ring land on the same box.
          </span>
        </div>
      </CardBody>
    </Card>
  );
}

const CONTROL_STATES = ['rest', 'disabled', 'error'] as const;

/**
 * The same eleven controls in each of the three states they ship in.
 *
 * Hover and focus are the two states a static page cannot print, so they are
 * left live: every control in this card responds to a pointer and to a tab, and
 * a ring that erases the border it lands on is visible only by tabbing the
 * column. The other three are side by side because that is the only arrangement
 * in which a double-dimmed checkbox, a disabled field that still lights on
 * hover, or chips that vanish at 36% opacity can be seen at all.
 */
/**
 * Checked × disabled, in one grid, because the defect was that two of these four
 * cells were byte-identical.
 *
 * Base UI renders both controls as a `<span role="switch" data-disabled>`, which
 * never matches `:disabled`, so every `disabled:` variant the component carried
 * was dead CSS. A disabled *checked* switch painted `--color-ink` at opacity 1 —
 * the live colour — and only its label dimmed. The four cells now differ.
 */
function CheckedAndDisabled() {
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);

  return (
    <Card>
      <CardHeader
        size="sm"
        titleAs="h3"
        title="Checked, and disabled"
        description="Four cells, four appearances. Read down: a disabled control keeps its state instead of losing it to a wash."
      />
      <CardBody className="grid gap-6 sm:grid-cols-2">
        <Demo label="enabled">
          <div className="flex flex-col gap-3">
            <Switch checked={on} onCheckedChange={setOn} label="Live chat" />
            <Switch checked={off} onCheckedChange={setOff} label="Quiet hours" />
            <Checkbox checked label="Include archived" onCheckedChange={() => {}} />
            <Checkbox checked={false} label="Email me a copy" onCheckedChange={() => {}} />
            <Checkbox checked="indeterminate" label="Some rows" onCheckedChange={() => {}} />
          </div>
        </Demo>
        <Demo label="disabled">
          <div className="flex flex-col gap-3">
            <Switch disabled checked onCheckedChange={() => {}} label="Live chat" />
            <Switch disabled checked={false} onCheckedChange={() => {}} label="Quiet hours" />
            <Checkbox disabled checked label="Include archived" />
            <Checkbox disabled checked={false} label="Email me a copy" />
            <Checkbox disabled checked="indeterminate" label="Some rows" />
          </div>
        </Demo>
      </CardBody>
      <CardSection className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Swatch name="control-disabled" className="bg-control-disabled" />
        <Swatch name="control-disabled-on" className="bg-control-disabled-on" />
        <Swatch name="ink · a live checked control" className="bg-ink" />
        <Swatch name="neutral-fill · a live off track" className="bg-neutral-fill" />
      </CardSection>
    </Card>
  );
}

function ControlStates() {
  const [colour, setColour] = useState('#2b54c8');

  return (
    <Card>
      <CardHeader
        title="Rest, disabled, error"
        description="Three columns of one form. Every defect the last review found at a call site was invisible in its own diff and obvious in this grid."
      />
      <CardBody className="grid gap-5 md:grid-cols-3">
        {CONTROL_STATES.map((state) => {
          const disabled = state === 'disabled';
          const error = state === 'error' ? 'That address could not be reached.' : null;
          return (
            <div key={state} className="flex flex-col gap-4">
              <Eyebrow>{state}</Eyebrow>
              <Field label="Website" error={error} disabled={disabled} hint="Include https://">
                <Input disabled={disabled} defaultValue="acme.com" />
              </Field>
              <Field label="New password" error={error} disabled={disabled}>
                <Input type="password" revealable disabled={disabled} defaultValue="hunter2" />
              </Field>
              <Field label="Plan" error={error} disabled={disabled}>
                <Select
                  label="Plan"
                  disabled={disabled}
                  defaultValue="standard"
                  options={[
                    { value: 'standard', label: 'Standard' },
                    { value: 'pro', label: 'Professional' },
                  ]}
                />
              </Field>
              <Field label="Owner" error={error} disabled={disabled}>
                <Combobox
                  label="Owner"
                  disabled={disabled}
                  options={[{ value: 'ana', label: 'Ana Ruiz' }]}
                  value="ana"
                  onValueChange={() => {}}
                />
              </Field>
              <Field label="Recipients" error={error} disabled={disabled}>
                <TagInput
                  label="Recipients"
                  disabled={disabled}
                  values={['ana@northwind.com']}
                  onValuesChange={() => {}}
                />
              </Field>
              <Field label="Brand colour" error={error} disabled={disabled}>
                <ColorInput
                  aria-label="Brand colour"
                  disabled={disabled}
                  value={colour}
                  onChange={setColour}
                  swatches={['#2b54c8', '#1b6b4c']}
                />
              </Field>
              <Field label="Welcome message" error={error} disabled={disabled}>
                <Textarea
                  rows={2}
                  disabled={disabled}
                  defaultValue="Hi — ask me anything about our pricing."
                />
              </Field>
              <Checkbox
                disabled={disabled}
                defaultChecked
                label="Include archived"
                description="Conversations closed more than 30 days ago."
              />
              <Switch
                disabled={disabled}
                checked
                onCheckedChange={() => {}}
                label="Live chat"
                description="Route conversations to a human when your team is online."
              />
              <SegmentedControl
                label={`Filter ${state}`}
                value="all"
                onChange={() => {}}
                items={[
                  { value: 'all', label: 'All' },
                  { value: 'mine', label: 'Mine', disabled },
                ]}
              />
              <RadioCards
                label={`Strictness ${state}`}
                value="strict"
                onChange={() => {}}
                items={[
                  { value: 'strict', label: 'Strict', description: 'Documents only.' },
                  {
                    value: 'open',
                    label: 'Open',
                    description: 'May answer from general knowledge.',
                    disabled,
                    badge: disabled ? <Badge tone="plan">Professional</Badge> : undefined,
                  },
                ]}
              />
              <FileDrop
                label="Add documents"
                hint="PDF, DOCX or TXT"
                accept={['.pdf', '.docx', '.txt']}
                maxSizeBytes={10 * 1024 * 1024}
                disabled={disabled}
                onFiles={() => {}}
              />
              <Button disabled={disabled} loading={state === 'error'}>
                Save changes
              </Button>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

const BADGE_TONES: BadgeTone[] = ['neutral', 'success', 'warning', 'danger', 'plan', 'ink'];
const AVATAR_SIZES: AvatarSize[] = ['xs', 'sm', 'md', 'lg'];

/**
 * The class strings and hooks the system exports for the cases it does not own.
 *
 * They are exported precisely so a one-off does not become a ninth Toggle, and
 * an export nobody can see is an export nobody trusts: `buttonClass` is used by
 * 64 files and had never appeared on this page.
 */
function EscapeHatches() {
  return (
    <Card>
      <CardHeader
        title="Escape hatches"
        description="For the two cases a component cannot cover: an element that must not be a <button>, and a control the system does not own."
      />
      <CardBody className="flex flex-col gap-6">
        <Demo label="buttonClass · a real link that looks like a button">
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/dev/ui" className={buttonClass('primary', 'md')}>
              Open docs
            </Link>
            <Link to="/dev/ui" className={buttonClass('secondary', 'sm')}>
              Small secondary
            </Link>
            <a
              href="https://www.oyechats.com"
              rel="noreferrer"
              className={buttonClass('ghost', 'sm', 'text-text-secondary')}
            >
              An external destination
            </a>
            <span className="text-xs text-text-secondary">
              A destination is an anchor. Middle-click, open-in-new-tab and the browser's own
              status bar all depend on it being one.
            </span>
          </div>
        </Demo>

        <Demo label="BUTTON_ICON · BUTTON_ICON_SLOT">
          <div className="flex flex-wrap items-center gap-4">
            {CONTROL_SIZES.map((size) => (
              <span key={size} className="flex items-center gap-2 text-xs text-text-secondary">
                <Download aria-hidden className={BUTTON_ICON[size]} />
                <code className="font-mono text-2xs text-text-tertiary">{BUTTON_ICON[size]}</code>
              </span>
            ))}
            <span className={cn('flex items-center gap-1.5', BUTTON_ICON_SLOT.sm)}>
              <Settings aria-hidden />
              <span className="text-xs text-text-secondary">a bespoke row, sized by the slot</span>
            </span>
          </div>
        </Demo>

        <Demo label="useField · useFieldControlProps">
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="A control the system does not own"
              required
              error="And it still reports its own error."
              hint="The hooks supply id, aria-describedby, aria-invalid and disabled."
            >
              <BespokeControl />
            </Field>
            <BespokeControl />
          </div>
        </Demo>

        <Demo label="Eyebrow as · dt, dd and a heading level">
          <dl className="max-w-form">
            <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-baseline gap-x-4 border-t border-border py-2">
              {/* `dl > div` may hold `dt` and `dd` and nothing else, so an
                  eyebrow naming a fact inside one had nowhere valid to go and
                  three surfaces reached past the component for EYEBROW_CLASS. */}
              <Eyebrow as="dt">Bot key</Eyebrow>
              <dd className="figure text-sm text-text-primary">bot-6a42…29b9</dd>
            </div>
            <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-baseline gap-x-4 border-t border-border py-2">
              <Eyebrow as="dt">Created</Eyebrow>
              <dd className="text-sm text-text-primary">12 August 2026</dd>
            </div>
          </dl>
          <Eyebrow as="h3" className="mt-4">
            A heading that is genuinely only a label
          </Eyebrow>
        </Demo>

        <Demo label="Class exports">
          <div className="grid gap-x-6 md:grid-cols-2">
            <ClassToken name="CONTROL_BASE" value={CONTROL_BASE} />
            <ClassToken name="controlClass('md')" value={controlClass('md')} />
            <ClassToken name="DISABLED_CONTROL" value={DISABLED_CONTROL} />
            <ClassToken name="DISABLED_FILLED" value={DISABLED_FILLED} />
            <ClassToken name="HIT_AREA" value={HIT_AREA} />
            <ClassToken name="FOCUS_RING" value={FOCUS_RING} />
            <ClassToken name="EYEBROW_CLASS" value={EYEBROW_CLASS} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-surface-sunken p-3">
            <button type="button" className={cn(HIT_AREA, FOCUS_RING, 'rounded-xs text-sm')}>
              HIT_AREA + FOCUS_RING on a 20px target
            </button>
            <button type="button" disabled className={cn(controlClass('sm'), DISABLED_CONTROL)}>
              DISABLED_CONTROL
            </button>
            <span className={cn(DISABLED_FILLED, 'rounded-sm px-2.5 py-1 text-xs')}>
              DISABLED_FILLED
            </span>
            <span className={EYEBROW_CLASS}>EYEBROW_CLASS</span>
          </div>
        </Demo>
      </CardBody>
    </Card>
  );
}

function PrimitivesPanel() {
  const [switched, setSwitched] = useState(true);
  const [checked, setChecked] = useState(true);
  const [query, setQuery] = useState('');
  const [emails, setEmails] = useState<string[]>(['ops@acme.com']);
  const [agent, setAgent] = useState<string | null>('acme');
  const [dateCaptured, setDateCaptured] = useState<string | null>('2026-08-15');
  const [promoStarts, setPromoStarts] = useState('2026-08-15T09:00');
  const [strictness, setStrictness] = useState('balanced');
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [uploads] = useState(() => [
    new File(['x'], 'pricing-2026.pdf', { type: 'application/pdf' }),
    new File(['x'], 'support-playbook.docx'),
  ]);

  return (
    <Stack>
      <Section title="Buttons" description="Intent, not decoration. At most one primary per view.">
        <Card>
          <CardBody className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Primary</Button>
            <Button variant="accent">Continue</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger" iconLeft={<Trash2 aria-hidden />}>
              Delete
            </Button>
            <Button variant="link">Inline link</Button>
            <Button iconRight={<Download aria-hidden />} variant="secondary">
              Export CSV
            </Button>
            <Button loading>Saving</Button>
            <Button disabled>Disabled</Button>
            <Button variant="danger" loading>
              Deleting
            </Button>
          </CardBody>
          <CardSection className="space-y-3">
            <Demo label="block">
              <Measure width="form">
                <Button block variant="primary">
                  One decision, the width of the form it ends
                </Button>
              </Measure>
            </Demo>
            <p className="text-xs text-text-secondary">
              Heights come from the spacing scale, so a button and an input on one row line up —
              which the next card is the proof of.
            </p>
          </CardSection>
        </Card>
      </Section>

      <Section
        title="The size matrix"
        description="One row per size. A mismatch is meant to be seen here rather than derived from a class string."
      >
        <ControlSizeMatrix />
      </Section>

      <Section
        title="Every state a control ships in"
        description="Rest, disabled and error side by side; hover and focus are live in the same grid."
      >
        <ControlStates />
      </Section>

      <Section title="Form controls" description="A label, a hint, an error, and one control.">
        <Card>
          <CardBody className="grid gap-5 md:grid-cols-2">
            <Field label="Chatbot name" required hint="Shown to visitors in the widget header.">
              <Input defaultValue="Acme Support" />
            </Field>
            <Field label="Website" hint="Include https://" error="That address could not be reached.">
              <Input defaultValue="acme" leading={<Globe aria-hidden className="h-icon-sm w-icon-sm" />} />
            </Field>
            <Field label="Reply signature" optional hint="Appended to every operator reply.">
              <Input placeholder="— The Acme team" />
            </Field>
            <Field label="Plan">
              <Select
                label="Plan"
                options={[
                  { value: 'free', label: 'Free' },
                  { value: 'standard', label: 'Standard' },
                  { value: 'pro', label: 'Professional' },
                ]}
                defaultValue="standard"
              />
            </Field>
            <Field label="Assign to agent" hint="Searchable, for long lists.">
              <Combobox
                label="Assign to agent"
                value={agent}
                onValueChange={setAgent}
                clearable
                options={[
                  { value: 'acme', label: 'Acme Support', description: 'bot-6a42…29b9' },
                  { value: 'north', label: 'Northwind Sales', description: 'bot-11c8…4f2a' },
                  { value: 'beacon', label: 'Beacon Health', description: 'bot-77ab…9012' },
                  { value: 'closed', label: 'Retired bot', description: 'archived', disabled: true },
                ]}
              />
            </Field>
            <Field label="Date captured" hint="A calendar grid, not the platform's own date picker.">
              <DatePicker
                label="Date captured"
                value={dateCaptured}
                onValueChange={setDateCaptured}
                clearable
              />
            </Field>
            <Field label="Promotion starts" hint="Date and time together — the datetime-local field this replaces.">
              <DateTimePicker label="Promotion starts" value={promoStarts} onValueChange={setPromoStarts} />
            </Field>
            <Field label="Notification recipients" hint="Enter, comma or paste a list.">
              <TagInput
                label="Notification recipients"
                values={emails}
                onValuesChange={setEmails}
                validate={validateEmail}
                normalize={(value) => value.toLowerCase()}
                placeholder="ops@example.com"
              />
            </Field>
            <Field label="Search" hideLabel>
              <SearchField
                label="Search leads"
                value={query}
                onValueChange={setQuery}
                placeholder="Search leads"
              />
            </Field>
            <Field label="Reserved message row" reserveMessageSpace hint="The row below is kept even when there is no error, so a grid of fields cannot jump.">
              <Input placeholder="Nothing wrong here" />
            </Field>
            <Field label="System prompt" className="md:col-span-2">
              <Textarea defaultValue="You are Acme's support assistant. Answer only from the knowledge base." />
            </Field>

            {/* The hint slot is a `div`, so it can hold a list. It was a `<p>`,
                which may not contain a `<ul>` — the browser closed the paragraph
                early and the list landed outside the element `aria-describedby`
                points at, so both call sites that needed one abandoned the slot
                and hand-rolled unwired text under the field instead. */}
            <Field
              label="New password"
              hint={
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>At least 12 characters</li>
                  <li>One number, or one symbol</li>
                  <li>Not a password you use anywhere else</li>
                </ul>
              }
            >
              <Input type="password" revealable placeholder="••••••••••••" />
            </Field>

            {/* `Field trailing`, not `Input trailing`. A conditional affix inside
                the control changes the input's element tree, so React remounts
                it and the caret is lost mid-typing — two surfaces shipped an
                always-present `invisible` badge to avoid it. */}
            <Field
              label="Greeting"
              trailing={
                <>
                  <Badge tone="neutral" size="sm">
                    default
                  </Badge>
                  <Button size="sm" variant="ghost">
                    Reset
                  </Button>
                </>
              }
              hint="The placeholder is what visitors see if you leave this empty."
            >
              <Input placeholder="Hi — ask me anything about our pricing." />
            </Field>

            {/* A width class sizes the CONTROL, and with an affix the control
                is the wrapper. It used to land on the `<input>` while the
                wrapper stayed `w-full`, so the badge floated ~250px right of
                the field and a `Select`'s chevron 300px from its box. */}
            <Field label="Session timeout" hint="A width class keeps its affix.">
              <Input
                className="max-w-40 figure"
                defaultValue="30"
                trailing={<span className="text-xs text-text-tertiary">min</span>}
              />
            </Field>
            <Field label="Region" hint="The same, for a select's chevron.">
              <Select
                label="Region"
                className="max-w-40"
                options={[
                  { value: 'in', label: 'India' },
                  { value: 'eu', label: 'Europe' },
                ]}
                defaultValue="in"
              />
            </Field>

            <Field
              label="Accepted formats"
              hint={
                <>
                  <Eyebrow as="span">PDF · DOCX · TXT</Eyebrow>
                  <span className="mt-0.5 block">Up to 16 MB each.</span>
                </>
              }
            >
              <Input placeholder="Paste a link to a document" />
            </Field>
          </CardBody>

          <CardSection className="grid gap-5 md:grid-cols-2">
            <FieldSet legend="Toggles" hint="A switch takes effect immediately; a checkbox waits for Save.">
              <div className="space-y-4">
                <Switch
                  checked={switched}
                  onCheckedChange={setSwitched}
                  label="Live chat"
                  description="Route conversations to a human when your team is online."
                />
                <Switch size="sm" checked onCheckedChange={() => {}} label="Small switch" />
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) => setChecked(next === true)}
                  label="Send me a daily summary"
                  description="One email at 09:00 in your workspace timezone."
                />
                <Checkbox checked="indeterminate" label="Partially selected" description="Some of the rows below are selected, not all." />
                <Checkbox label="Unchecked, no description" />
              </div>
            </FieldSet>
            <FieldSet
              legend="Weekly digest"
              disabled
              hint="disabled on the fieldset, which the HTML spec inherits to every form control inside it — including ones added later."
            >
              <div className="space-y-4">
                <Checkbox disabled label="Send me a weekly digest" />
                <Input disabled defaultValue="ops@acme.com" aria-label="Digest recipient" />
                <Button disabled size="sm" variant="secondary">
                  Send a test
                </Button>
              </div>
            </FieldSet>
            <FieldSet legend="Density" hint="A filter, so it is a radiogroup — one tab stop, arrow keys inside.">
              <div className="space-y-4">
                <SegmentedControl
                  label="Density"
                  value={density}
                  onChange={setDensity}
                  items={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact', count: 36 },
                  ]}
                />
                <SegmentedControl
                  size="sm"
                  fill
                  label="Density, filled"
                  value={density}
                  onChange={setDensity}
                  items={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact' },
                  ]}
                />
              </div>
            </FieldSet>
          </CardSection>

          <CardBody className="space-y-4">
            <Demo label="FileDrop · empty, and with a queue">
              <div className="grid gap-4 lg:grid-cols-2">
                <FileDrop
                  label="Drop documents to train on"
                  hint="Or click to choose files"
                  accept={['.pdf', '.docx', '.txt']}
                  maxSizeBytes={10 * 1024 * 1024}
                  onFiles={(files) => toast.success(`${files.length} file(s) accepted`)}
                />
                <FileDrop
                  label="Drop documents to train on"
                  hint="Two chosen, one still uploading"
                  accept={['.pdf', '.docx', '.txt']}
                  maxSizeBytes={10 * 1024 * 1024}
                  files={uploads}
                  progress={{ 'pricing-2026.pdf': 64, 'support-playbook.docx': null }}
                  onRemove={() => {}}
                  onFiles={() => {}}
                />
              </div>
            </Demo>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Disabled, without an opacity wash"
        description="The one state a review of diffs cannot catch, because the class that was meant to paint it never matched anything."
      >
        <CheckedAndDisabled />
      </Section>

      <Section
        title="Choices that need a sentence"
        description="SegmentedControl has room for a label and nothing else. The moment an option needs explaining, it becomes this."
      >
        <Card>
          <CardBody className="space-y-5">
            <RadioCards
              label="How strictly should it answer?"
              columns={3}
              value={strictness}
              onChange={setStrictness}
              items={[
                { value: 'strict', label: 'Strict', description: 'Only from your documents. Anything else gets a handoff.' },
                { value: 'balanced', label: 'Balanced', description: 'Fills small gaps from general knowledge, and says when it did.' },
                {
                  value: 'open',
                  label: 'Open',
                  description: 'Answers freely.',
                  badge: <Badge tone="plan">Professional</Badge>,
                  disabled: true,
                },
              ]}
            />
            <RadioCards
              label="Billing period"
              columns={2}
              value="year"
              onChange={() => {}}
              items={[
                { value: 'month', label: 'Monthly', description: '₹8,400 a month, cancel any time.' },
                { value: 'year', label: 'Yearly', description: 'Two months free.', badge: <Badge tone="success">Save 17%</Badge> },
              ]}
            />
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Status, quantity and identity"
        description="Four tones, always with a word. Progress is motion, never a hue."
      >
        <Card>
          <CardBody className="flex flex-wrap items-center gap-3">
            {BADGE_TONES.map((tone) => (
              <Badge key={tone} tone={tone} dot={tone !== 'ink' && tone !== 'plan'}>
                {tone}
              </Badge>
            ))}
            <Badge tone="neutral" size="sm">
              small
            </Badge>
            <Separator orientation="vertical" className="h-5" />
            <span className="flex items-center gap-1.5 text-sm">
              <StatusDot tone="success" pulse label="Operator online" /> Online
            </span>
            <span className="flex items-center gap-1.5 text-sm">
              <StatusDot tone="warning" label="Away" size="sm" /> Away
            </span>
            <span className="flex items-center gap-1.5 text-sm text-text-secondary">
              <WorkingDots label="Training in progress" /> Training
            </span>
            <Separator orientation="vertical" className="h-5" />
            <span className="flex items-center gap-1.5 text-xs text-text-secondary">
              Press <Kbd>{modifierKey()}</Kbd> <Kbd>K</Kbd>
              {isMacPlatform() ? ' (this browser reports macOS)' : ' (this browser reports a PC)'}
            </span>
          </CardBody>

          <CardSection className="grid gap-4 sm:grid-cols-2">
            {/* `hideLabel` now defaults to FALSE on both. A required `label`
                that rendered nothing unless a second prop was found and unset
                was the trap; `Meter` never had it and the two disagreed. */}
            <Progress value={64} label="Crawling acme.com" />
            <Progress value={null} label="Waiting for the crawler" />
            <Progress value={92} label="Nearly done" tone="success" size="sm" />
            <Demo label="Progress hideLabel · 6px of chrome">
              <Progress value={38} label="Retrying" tone="warning" hideLabel />
            </Demo>
            <Meter label="Documents" used={412} limit={500} />
            <Meter label="Credits" used={9800} limit={10000} />
            <Meter label="Seats" used={4} limit={-1} unlimitedNote="No limit on this plan" />
            <Meter
              label="Knowledge"
              used={500}
              limit={500}
              tone="plan"
              unit="pages"
              hint="A full allowance on a plan that includes this much is a price, not a fault."
            />
            <Demo label="Meter hideLabel · the figure survives">
              <Meter hideLabel label="Budget" used={3} limit={5} />
            </Demo>
            <Demo label="Meter · named, for comparison">
              <Meter label="Budget" used={3} limit={5} />
            </Demo>
          </CardSection>

          <CardSection>
            <Eyebrow className="mb-1.5">
              Badge · a tooltip trigger, which needs a forwarded ref
            </Eyebrow>
            <p className="mb-3 max-w-form text-xs text-text-secondary">
              Base UI renders a trigger by cloning its child with a ref and a full set of
              handlers. `Badge` accepted neither, so every one of these clones succeeded
              silently and no tooltip on a badge has ever opened. Hover or focus one.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Tooltip content="Scored 82 on BANT in the last 24 hours.">
                <Badge tone="success" dot tabIndex={0}>
                  qualified
                </Badge>
              </Tooltip>
              <Tooltip content="No reply from the widget for 6 minutes.">
                <Badge tone="warning" dot tabIndex={0}>
                  stalled
                </Badge>
              </Tooltip>
              <Tooltip content="This workspace is on the Professional plan.">
                <StatusDot tone="plan" label="Professional" tabIndex={0} />
              </Tooltip>
            </div>
          </CardSection>

          <CardSection className="flex flex-wrap items-end gap-6">
            <Demo label="Avatar">
              <div className="flex items-end gap-2">
                {AVATAR_SIZES.map((size) => (
                  <Avatar key={size} name="Ana Ruiz" size={size} />
                ))}
                <Avatar name="Bo Chen" shape="rounded" size="lg" />
                <Avatar name="Acme Support" src="/favicon-192.png" size="lg" />
              </div>
            </Demo>
            <Demo label="Spinner">
              <div className="flex items-center gap-4">
                <Spinner size="sm" label="Refreshing leads" />
                <Spinner size="md" label={null} />
                <Spinner size="lg" label={null} />
              </div>
            </Demo>
            <Demo label="Skeleton · SkeletonText" className="min-w-64">
              <Skeleton className="h-8 w-full" />
              <div className="mt-3">
                <SkeletonText lines={3} />
              </div>
              <div className="mt-3">
                <SkeletonText lines={2} variant="prose" />
              </div>
            </Demo>
            <Demo label="Separator">
              <div className="flex items-center gap-3">
                <span className="text-xs text-text-secondary">left</span>
                <Separator orientation="vertical" className="h-5" />
                <span className="text-xs text-text-secondary">right</span>
              </div>
              <Separator className="mt-3 w-40" />
              <Separator size="sm" className="mt-3 w-40" />
            </Demo>
          </CardSection>
        </Card>
      </Section>

      <Section
        title="Escape hatches"
        description="Exported so a one-off never becomes a ninth Toggle — and rendered so the exports are trusted."
      >
        <EscapeHatches />
      </Section>
    </Stack>
  );
}

/* ---------------------------------------------------------------- layout */

const MEASURE_WIDTHS: MeasureWidth[] = ['form', 'reading', 'full'];

/** The five facts that broke `PropertyGrid` in an aside: two long, three short. */
const NARROW_FACTS = [
  { label: 'First seen', value: '2 Jun 2026, 10:00' },
  { label: 'Source', value: 'https://acme.com/pricing' },
  { label: 'Company', value: 'Northwind' },
  { label: 'Conversations', value: <span className="figure">6</span> },
  { label: 'Referrer', value: undefined },
];

function LayoutPanel() {
  const [quietHours, setQuietHours] = useState(false);
  const [paneSelected, setPaneSelected] = useState(true);
  const [paneQuery, setPaneQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  return (
    <Stack>
      <Section
        title="Grid"
        description="Two or more cards answering the same question at the same altitude. Container-queried, so a grid inside a 320px pane stays one column on a 1920px screen."
      >
        <Stack gap="card">
          <Grid cols={4}>
            {['Conversations', 'Leads', 'Credits', 'Rating'].map((label) => (
              <Card key={label}>
                <CardHeader size="sm" title={label} titleAs="h3" />
                <CardBody>
                  <p className="figure text-2xl font-semibold text-text-primary">
                    {label === 'Rating' ? '4.6' : '1,284'}
                  </p>
                </CardBody>
              </Card>
            ))}
          </Grid>
          <Grid cols={2}>
            <Card>
              <CardHeader size="sm" title="Most asked" titleAs="h3" />
              <CardBody className="text-sm text-text-secondary">
                A widget card: 40px of header, no eyebrow, no hairline.
              </CardBody>
            </Card>
            <Card>
              <CardHeader
                title="Knowledge"
                titleAs="h3"
                description="A section card keeps the heavier header — and only when the title cannot carry the meaning."
                actions={<Button size="sm" variant="secondary">Retrain</Button>}
              />
              <CardBody className="text-sm text-text-secondary">Body.</CardBody>
            </Card>
          </Grid>
          <Grid cols={3} gap="section" align="start" as="ul" label="Three at the start edge">
            {['One', 'Two', 'Three'].map((label) => (
              <li key={label}>
                <Card>
                  <CardBody className="text-sm text-text-secondary">{label}</CardBody>
                </Card>
              </li>
            ))}
          </Grid>
        </Stack>
      </Section>

      <Section
        title="Columns"
        description="Main plus aside. One column is the work; the other comments on it."
      >
        <Columns
          asideWidth="sm"
          asideLabel="Summary"
          stickyAside
          main={
            <Card>
              <CardHeader title="Invoice INV-2026-0041" titleAs="h3" />
              <CardBody className="text-sm text-text-secondary">The work.</CardBody>
            </Card>
          }
          aside={
            <Card>
              <CardHeader size="sm" title="Summary" titleAs="h3" />
              <CardBody flush className="px-cell py-2">
                <PropertyGrid
                  items={[
                    { label: 'Subtotal', value: <span className="figure">₹12,400</span> },
                    { label: 'Tax', value: <span className="figure">₹2,232</span> },
                    { label: 'Due', value: <span className="figure">₹14,632</span> },
                  ]}
                />
              </CardBody>
            </Card>
          }
        />
      </Section>

      <Section
        title="Measure"
        description="A reading measure inside a full-width page. Never centred — the page keeps one left edge on every route. (It is `Measure`, not `Column`: in a console, a column is a table column.)"
      >
        <Stack gap="card">
          {MEASURE_WIDTHS.map((width) => (
            <Measure key={width} width={width}>
              <Card>
                <CardHeader size="sm" title={`width="${width}"`} titleAs="h3" />
                <CardBody className="text-sm text-text-secondary">
                  {width === 'form'
                    ? '672px, anchored left — a form.'
                    : width === 'reading'
                      ? 'A prose measure, for a page that is mostly words.'
                      : 'No cap at all: the page decides.'}
                </CardBody>
              </Card>
            </Measure>
          ))}
        </Stack>
      </Section>

      <Section
        title="The card, band by band"
        description="A header, bodies, hairline-separated sections and a footer — the dividers belong to the card, not to whoever remembers to add them."
      >
        <Grid cols={2} align="start">
          <Card>
            <CardHeader
              eyebrow="Install"
              title="Every band"
              titleAs="h3"
              description="Header, body, section, footer."
              actions={<Badge tone="success" dot>Live</Badge>}
            />
            <CardBody className="text-sm text-text-secondary">A body.</CardBody>
            <CardSection className="text-sm text-text-secondary">
              A section — a second band under its own hairline.
            </CardSection>
            <CardSection tone="sunken" className="text-sm text-text-secondary">
              tone=&quot;sunken&quot; — for a band that is <em>about</em> the one above it. Three
              call sites were hand-writing the background, which is a colour decision escaping
              into a feature.
            </CardSection>
            <CardFooter>
              <Button size="sm" variant="ghost">Cancel</Button>
              <Button size="sm" variant="primary">Save</Button>
            </CardFooter>
          </Card>
          <div className="space-y-4">
            <Card interactive as="article">
              <CardHeader size="sm" title="An interactive card" titleAs="h3" description="The whole surface is the target; hover it." />
              <CardBody className="text-sm text-text-secondary">
                `interactive` raises the border on hover. It never adds a shadow — a card is paper,
                not a button.
              </CardBody>
            </Card>
            <Card>
              <CardHeader size="sm" title="A flush body" titleAs="h3" />
              <CardBody flush>
                <LoadingBars rows={2} />
              </CardBody>
              <SaveBar
                variant="footer"
                dirty={dirty}
                saving={saving}
                summary="the greeting"
                onSave={() => {
                  setSaving(true);
                  window.setTimeout(() => {
                    setSaving(false);
                    setDirty(false);
                  }, 700);
                }}
                onDiscard={() => setDirty(false)}
              />
            </Card>
            <Button size="sm" variant="secondary" onClick={() => setDirty((value) => !value)}>
              {dirty ? 'Mark clean' : 'Mark dirty'}
            </Button>
          </div>
        </Grid>
      </Section>

      <Section
        title="SaveBar"
        description="Unsaved work has to be visible, undoable, and hard to walk away from. Every state it can be in, at once."
      >
        <Grid cols={2}>
          <Card>
            <CardHeader size="sm" title="Sticky · dirty" titleAs="h3" />
            <CardBody>
              <SaveBar dirty summary="brand colour" onSave={() => {}} onDiscard={() => {}} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Sticky · saving" titleAs="h3" />
            <CardBody>
              <SaveBar dirty saving summary="brand colour" onSave={() => {}} onDiscard={() => {}} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Sticky · saved" titleAs="h3" />
            <CardBody>
              <SaveBar dirty={false} saved onSave={() => {}} onDiscard={() => {}} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Footer · failed, and blocked" titleAs="h3" />
            <CardBody className="text-sm text-text-secondary">
              A failed save leaves the draft dirty, so the reason belongs beside the button that
              produced it — never in a toast that has already gone.
            </CardBody>
            <SaveBar
              variant="footer"
              dirty
              saveError="We could not reach the API. Your changes are still here."
              onSave={() => {}}
              onDiscard={() => {}}
            />
            <SaveBar
              variant="footer"
              dirty
              blockedReason="Only an owner can change billing details."
              onSave={() => {}}
              onDiscard={() => {}}
            />
          </Card>
        </Grid>
      </Section>

      <Section
        title="SidebarLayout · SettingGroup · SettingRow"
        description="Secondary nav beside its content. A vertical column above the breakpoint, a horizontal scroller below it."
      >
        <SidebarLayout
          navLabel="Workspace settings (demo)"
          nav={
            <>
              {['General', 'Members', 'Billing', 'API keys'].map((label, index) => (
                <a
                  key={label}
                  href="/dev/ui"
                  className={
                    index === 0
                      ? 'flex h-8 items-center rounded-md bg-surface-active px-2.5 text-sm font-medium text-text-primary'
                      : 'flex h-8 items-center rounded-md px-2.5 text-sm font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }
                >
                  {label}
                </a>
              ))}
            </>
          }
        >
          <SettingGroup
            title="General"
            titleAs="h3"
            description="One row per decision, with the control on the right and its consequence under the label."
            actions={<Button size="sm" variant="ghost">Reset</Button>}
          >
            <SettingRow label="Name" htmlFor="gallery-ws-name" description="Shown in the workspace switcher.">
              <Input id="gallery-ws-name" defaultValue="Acme" />
            </SettingRow>
            <SettingRow label="Quiet hours" badge={<Badge tone="neutral">22:00–07:00</Badge>}>
              <Switch checked={quietHours} onCheckedChange={setQuietHours} label="Quiet hours" hideLabel />
            </SettingRow>
            <SettingRow
              label="Accept timeout"
              htmlFor="gallery-ws-timeout"
              description="Then it returns to the queue."
              controlWidth="sm"
              error="Must be between 10 and 120 seconds."
            >
              <Input id="gallery-ws-timeout" defaultValue="500" />
            </SettingRow>
            <SettingRow label="Welcome message" htmlFor="gallery-ws-welcome" stacked>
              <Textarea id="gallery-ws-welcome" rows={2} defaultValue="Hi — ask me anything about our pricing." />
            </SettingRow>
            <SettingRow
              label="Reply-to"
              description="Empty uses the owner's address."
              stacked
              required
            >
              {/* No `htmlFor`: the row publishes the field's wiring but does not
                  claim the control's name, so the tag list keeps its own. */}
              <TagInput
                label="Reply-to address"
                values={['support@acme.com']}
                maxValues={1}
                onValuesChange={() => {}}
              />
            </SettingRow>
            <SettingRow label="Custom domain" badge={<Badge tone="plan">Professional</Badge>} disabled>
              {/* `disabled` dims the row's own type in tokens. It deliberately
                  does not disable what is inside: a locked row very often holds
                  the control that unlocks it. */}
              <Button size="sm" variant="secondary">
                Upgrade
              </Button>
            </SettingRow>
            <SettingBand>
              <Alert tone="neutral">
                A <code className="font-mono text-xs">SettingBand</code> is the group&rsquo;s
                own <code className="font-mono text-xs">CardBody</code>: anything that is not
                a row, standing on the same 20px gutter, hairline-separated like the rows
                above it. Eight surfaces were hand-writing this padding.
              </Alert>
            </SettingBand>
          </SettingGroup>
        </SidebarLayout>
      </Section>

      <Section
        title="Well"
        description="A bordered recess inside a card — a quoted value, a preview, a summary of what is about to happen. Not a nested Card, which is a doubled hairline and two radii a pixel apart."
      >
        <Grid cols={2}>
          <Card>
            <CardHeader size="sm" title="tone=&quot;sunken&quot;" titleAs="h3" />
            <CardBody className="space-y-3">
              <Well>
                <Eyebrow>What the visitor sees</Eyebrow>
                <p className="mt-1 text-prose text-text-primary">
                  Hi — ask me anything about our pricing.
                </p>
              </Well>
              <Well>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-text-secondary">Estimated cost</span>
                  <span className="figure text-sm font-medium text-text-primary">412 credits</span>
                </div>
              </Well>
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="tone=&quot;plain&quot;" titleAs="h3" />
            <CardBody className="space-y-3">
              <Well tone="plain">
                <div className="flex items-center gap-3">
                  <span className="h-6 w-6 rounded-xs bg-accent-500" />
                  <span className="figure text-sm text-text-primary">#3a6ae6</span>
                </div>
              </Well>
              <p className="text-xs text-text-secondary">
                Plain keeps the card&rsquo;s white: two greys one L* apart behind a filled
                swatch look like a rendering fault rather than a recess.
              </p>
            </CardBody>
          </Card>
        </Grid>
      </Section>

      <Section
        title="PropertyGrid"
        description="A record as facts. Label left, value right, hairline between — and an em dash wherever a value is absent."
      >
        <Grid cols={2}>
          <Card>
            <CardHeader size="sm" title="Rows" titleAs="h3" />
            <CardBody>
              <PropertyGrid
                label="Visitor"
                items={[
                  { label: 'Email', value: 'ana@northwind.com', action: <Button size="sm" variant="ghost">Copy</Button> },
                  { label: 'Company', value: 'Northwind' },
                  { label: 'Referrer', value: undefined },
                  { label: 'Tier', value: 'Warm', note: 'Set by BANT scoring after each reply.' },
                  { label: 'Session', value: <span className="figure">sess_9f2c41</span> },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Two columns, compact — and stacked" titleAs="h3" />
            <CardBody className="space-y-4">
              <PropertyGrid
                columns={2}
                density="compact"
                items={[
                  { label: 'Plan', value: 'Professional' },
                  { label: 'Seats', value: <span className="figure">4</span> },
                  { label: 'Renews', value: '1 September 2026' },
                  { label: 'Method', value: 'UPI' },
                  { label: 'Country', value: 'India' },
                  { label: 'VAT', value: undefined },
                ]}
              />
              <PropertyGrid
                layout="stacked"
                columns={2}
                items={[
                  { label: 'Bot key', value: <span className="figure">bot-6a42…29b9</span> },
                  { label: 'Created', value: '12 August 2026' },
                ]}
              />
            </CardBody>
          </Card>
        </Grid>

        <div className="mt-4 grid gap-4 sm:grid-cols-[18rem_minmax(0,1fr)]">
          <Card>
            <CardHeader size="sm" title="In an 18rem aside" titleAs="h3" />
            <CardBody>
              <PropertyGrid items={NARROW_FACTS} />
              <p className="mt-3 border-t border-border pt-3 text-2xs text-text-tertiary">
                density=&quot;compact&quot;, the inspector density — a narrower label track, because
                the names in an inspector are short and the values are not.
              </p>
              <PropertyGrid
                density="compact"
                items={[
                  { label: 'Email', value: 'amara@example.com' },
                  { label: 'Device', value: 'macOS · Chrome' },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="The same grid, given room" titleAs="h3" />
            <CardBody>
              <PropertyGrid items={NARROW_FACTS} />
            </CardBody>
          </Card>
        </div>
        <p className="mt-2 max-w-reading text-xs text-text-secondary">
          One component, no prop, two shapes. The label column was
          <code className="mx-1 font-mono text-2xs">minmax(7rem,10rem)</code>
          at every width, so in the aside a 112px label left about 120px for the value:
          &ldquo;2 Jun 2026, 10:00&rdquo; wrapped onto three lines and the URL broke
          mid-word. Below 24rem of <em>container</em> — not viewport — it stacks, which is
          what <code className="font-mono text-2xs">layout=&quot;stacked&quot;</code> was
          already documented as being for.
        </p>
      </Section>

      <Section
        title="PaneHeader and SplitPane"
        description="One header contract for every pane, and a list/detail split whose panes both stay mounted. Drag the separator, or focus it and use the arrow keys."
      >
        <Card className="h-96 overflow-hidden">
          <SplitPane
            resizable
            storageKey="dev:gallery-split"
            selected={paneSelected}
            onBack={() => setPaneSelected(false)}
            backLabel="All conversations"
            listLabel="Conversations"
            detailLabel="Conversation"
            list={
              <>
                <PaneHeader
                  title="Conversations"
                  titleAs="h3"
                  actions={<Badge tone="success" dot>3 live</Badge>}
                >
                  <SearchField
                    value={paneQuery}
                    onValueChange={setPaneQuery}
                    label="Search conversations"
                    placeholder="Search"
                    size="sm"
                  />
                </PaneHeader>
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {LEADS.map((lead) => (
                    <li key={lead.id}>
                      <button
                        type="button"
                        onClick={() => setPaneSelected(true)}
                        className="flex h-row w-full items-center gap-2 border-b border-border px-cell text-left text-sm hover:bg-surface-hover"
                      >
                        <Avatar name={lead.name} size="sm" />
                        <span className="min-w-0 truncate">{lead.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            }
            detail={
              <>
                <PaneHeader
                  eyebrow="Northwind"
                  title="Ana Ruiz"
                  titleAs="h3"
                  actions={<Button size="sm" variant="secondary">Take over</Button>}
                />
                <div className="min-h-0 flex-1 overflow-y-auto px-cell py-4 text-sm text-text-secondary">
                  The transcript. Both panes stay mounted when the layout stacks, so a half-typed
                  reply survives going back to the queue.
                </div>
              </>
            }
          />
        </Card>
      </Section>

      <Section
        title="RailFrame"
        description="One frame for both consoles' rails: a 56px header, 36px rows, and every leading glyph in the same 16px optical box."
      >
        <Grid cols={2}>
          <div className="h-96 w-rail overflow-hidden rounded-lg">
            <RailFrame
              navLabel="Gallery rail"
              header={<span className="px-2.5 text-sm font-semibold text-rail-text">Acme</span>}
              footer={<span className="px-2.5 text-sm text-rail-text-muted">Account</span>}
            >
              <RailBackLink to="/dev/ui">All chatbots</RailBackLink>
              <RailItem
                to="/dev/ui"
                label="Inbox"
                glyph={<Inbox aria-hidden className="h-icon-md w-icon-md" />}
                trailing={<Badge tone="neutral">12</Badge>}
                active
              />
              <RailItem
                to="/dev/ui#analytics"
                label="Analytics"
                glyph={<BarChart3 aria-hidden className="h-icon-md w-icon-md" />}
                active={false}
              />
              <RailGroupLabel>Money</RailGroupLabel>
              <RailItem
                to="/dev/ui#billing"
                label="Billing"
                glyph={<CreditCard aria-hidden className="h-icon-md w-icon-md" />}
                active={false}
              />
              <RailItem
                to="/dev/ui#chatbots"
                label="Chatbots"
                glyph={<Bot aria-hidden className="h-icon-md w-icon-md" />}
                active={false}
              />
            </RailFrame>
          </div>
          <div className="h-96 w-rail-collapsed overflow-hidden rounded-lg">
            <RailFrame
              navLabel="Gallery rail, collapsed"
              header={
                <span className="flex h-icon-md w-icon-md items-center justify-center text-sm font-semibold text-rail-text">
                  A
                </span>
              }
            >
              <RailItem
                collapsed
                to="/dev/ui"
                label="Inbox"
                glyph={<Inbox aria-hidden className="h-icon-md w-icon-md" />}
                active
              />
              <RailItem
                collapsed
                to="/dev/ui#analytics"
                label="Analytics"
                glyph={<BarChart3 aria-hidden className="h-icon-md w-icon-md" />}
                active={false}
              />
              <RailGroupLabel collapsed>Money</RailGroupLabel>
              <RailItem
                collapsed
                to="/dev/ui#billing"
                label="Billing"
                glyph={<CreditCard aria-hidden className="h-icon-md w-icon-md" />}
                active={false}
              />
            </RailFrame>
          </div>
        </Grid>
      </Section>

      <Section
        title="Toolbar"
        description="The controls that decide what a table shows, kept on screen while the table scrolls under them."
      >
        <Card>
          <CardBody className="h-56 overflow-y-auto">
            <Toolbar sticky>
              <Slot className="w-56">
                <SearchField size="sm" label="Search leads" value="" onValueChange={() => {}} placeholder="Search" />
              </Slot>
              <SegmentedControl
                size="sm"
                label="Tier"
                value="all"
                onChange={() => {}}
                items={[
                  { value: 'all', label: 'All', count: 128 },
                  { value: 'sql', label: 'Sales-qualified', count: 12 },
                ]}
              />
              <Separator orientation="vertical" className="h-5" />
              <Link to="/dev/ui" className={buttonClass('secondary', 'sm')}>
                Open docs
              </Link>
              <Spinner size="sm" label="Refreshing leads" />
            </Toolbar>
            <div className="pt-3">
              <LoadingRows rows={6} />
            </div>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Show more, on request"
        description="A button with aria-expanded over a labelled region. Optionally a heading, so a log of them is navigable by heading."
      >
        <Card>
          <CardBody className="space-y-3">
            <Disclosure summary="Why this answer was unhelpful" headingLevel={3}>
              <p className="text-prose text-text-secondary">
                The panel is unmounted when closed, not hidden — a hidden subtree keeps its
                focusable children in the tab order.
              </p>
            </Disclosure>
            <Disclosure
              summary="Advanced retrieval"
              defaultOpen
              trailing={<Badge tone="plan">Professional</Badge>}
              divider={false}
              regionLabel="Advanced retrieval settings"
            >
              <p className="text-prose text-text-secondary">
                Open by default, with a trailing badge and no divider — the three knobs a disclosure
                is allowed to have.
              </p>
            </Disclosure>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Routed tabs"
        description="Tabs whose tabs are links. A tablist promises every tab controls a panel in the document; a routed surface only ever has the current one."
      >
        <Stack gap="card">
          <NavTabs
            label="Example section views"
            items={[
              { to: '/dev/ui', label: 'Overview', end: true },
              { to: '/dev/ui/invoices', label: 'Invoices', badge: <Badge tone="neutral">4</Badge> },
              { to: '/dev/ui/credits', label: 'Credits', locked: true },
            ]}
          />
          <p className="text-xs text-text-secondary">
            Only the first destination exists — the other two are here so an idle tab and a locked
            one can be seen beside the current one. Activeness comes from the path, so a row of
            hash-only links would render every tab active at once, which is what this example used
            to do.
          </p>
        </Stack>
      </Section>
    </Stack>
  );
}

/* ------------------------------------------------------------------ data */

function DataPanel() {
  const [selected, setSelected] = useState<Set<string>>(new Set(['1']));
  const [sort, setSort] = useState<SortState | null>({ key: 'score', direction: 'desc' });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rankedSelection, setRankedSelection] = useState('1');

  return (
    <Stack>
      <Section
        title="Table"
        description="Sortable, selectable, a pinned first column that survives a horizontal scroll, and a row count that does not depend on a pager."
      >
        <DataTable
          caption="Leads"
          rowNoun="lead"
          columns={LEAD_COLUMNS}
          rows={LEADS}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.name}
          selectedKeys={selected}
          onSelectionChange={setSelected}
          sort={sort}
          onSortChange={setSort}
          onRowClick={() => setDrawerOpen(true)}
          pageSize={3}
          bulkActions={
            <>
              <Button size="sm" variant="secondary">Export</Button>
              <Button size="sm" variant="danger">Delete</Button>
            </>
          }
        />
      </Section>

      <Section
        title="Table in a narrow column — fit, not scroll"
        description="min-w-max plus a scrolling wrapper is right for a wide table and wrong for one in a two-up grid: the last cell is clipped at the card's right edge, behind a scroll affordance nobody finds."
      >
        <Grid cols={2}>
          <Card>
            <CardHeader size="sm" title="Default · the action column is cut off" titleAs="h3" />
            <CardBody flush>
              <DataTable seated caption="Chatbots, scrolling" rowNoun="chatbot" {...NARROW_TABLE} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="fit · the table gives instead" titleAs="h3" />
            <CardBody flush>
              <DataTable seated fit caption="Chatbots, fitted" rowNoun="chatbot" {...NARROW_TABLE} />
            </CardBody>
          </Card>
        </Grid>
      </Section>

      <Section
        title="Table, seated in a card"
        description="A table inside a card draws no border of its own — two rounded boxes one pixel apart is the card-in-card defect, in the place it is most visible."
      >
        <Card>
          <CardHeader title="Invoices" titleAs="h3" description="Issued by OyeChats, newest first." />
          <CardBody flush>
            <DataTable
              seated
              caption="Invoices"
              rowNoun="invoice"
              rowKey={(row) => row.id}
              rows={[
                { id: 'in_1', number: 'INV-0042', period: 'Aug 2026', amount: '₹8,400' },
                { id: 'in_2', number: 'INV-0041', period: 'Jul 2026', amount: '₹8,400' },
                { id: 'in_3', number: 'INV-0040', period: 'Jun 2026', amount: '₹6,200' },
              ]}
              columns={[
                { key: 'number', header: 'Invoice', type: 'id', rowHeader: true, render: (row) => row.number },
                { key: 'period', header: 'Period', render: (row) => row.period },
                {
                  key: 'amount',
                  header: 'Amount',
                  type: 'number',
                  render: (row) => row.amount,
                  sortable: (a, b) => a.amount.localeCompare(b.amount),
                },
                {
                  key: 'pdf',
                  header: 'Document',
                  align: 'right',
                  render: () => (
                    <Button size="sm" variant="ghost">
                      PDF
                    </Button>
                  ),
                },
              ]}
              footer={
                <tr>
                  <th scope="row">Total</th>
                  <td />
                  <td className="figure text-right">₹23,000</td>
                  <td />
                </tr>
              }
            />
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Table — the other four states"
        description="Inline, left-aligned, at row scale. A table that returned no rows is not a poster."
      >
        <Grid cols={4}>
          <Card>
            <CardHeader size="sm" title="Loading" titleAs="h3" />
            <CardBody flush>
              <DataTable
                seated
                loading
                caption="Loading leads"
                rowKey={(row: { id: string }) => row.id}
                rows={[]}
                columns={[{ key: 'name', header: 'Name', render: () => null }]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Empty" titleAs="h3" />
            <CardBody flush>
              <DataTable
                seated
                caption="Empty leads"
                rowKey={(row: { id: string }) => row.id}
                rows={[]}
                columns={[{ key: 'name', header: 'Name', render: () => null }]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Error" titleAs="h3" />
            <CardBody flush>
              <DataTable
                seated
                caption="Failed leads"
                rowKey={(row: { id: string }) => row.id}
                rows={[]}
                columns={[{ key: 'name', header: 'Name', render: () => null }]}
                error="We could not reach the billing service."
                onRetry={() => toast.info('Retrying…')}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Forbidden" titleAs="h3" />
            <CardBody flush>
              <DataTable
                seated
                caption="Forbidden leads"
                rowKey={(row: { id: string }) => row.id}
                rows={[]}
                columns={[{ key: 'name', header: 'Name', render: () => null }]}
                forbidden={{
                  title: 'Billing is not yours to see',
                  description: 'An owner or an admin of this workspace can open it for you.',
                }}
              />
            </CardBody>
          </Card>
        </Grid>
      </Section>

      <Section
        title="Figures"
        description="Every number is mono and tabular, so a column cannot jitter. One strip, hairline-divided, with the window stated once."
      >
        <Stack gap="card">
          <Card>
            <CardHeader title="This chatbot" titleAs="h3" />
            <CardBody flush>
              <StatRow
                period="Last 30 days"
                columns={4}
                label="Chatbot figures"
                items={[
                  { label: 'Conversations', value: '412', delta: { value: '12%', direction: 'up', label: 'vs previous 30 days' } },
                  { label: 'Messages', value: '3,180', delta: { value: '4%', direction: 'down', label: 'vs previous 30 days' } },
                  { label: 'Visitors now', value: '7', period: 'Right now' },
                  { label: 'Avg rating', value: undefined, empty: 'Not rated yet', period: 'All time' },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader size="sm" title="StatTile · sizes, tones and the two non-answers" titleAs="h3" />
            <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-5">
              <StatTile size="hero" label="Conversations" value="1,204" period="Last 30 days" delta={{ value: '12%', direction: 'up' }} />
              <StatTile size="lg" label="Qualified leads" value="86" period="Last 30 days" delta={{ value: '4%', direction: 'down' }} tone="success" />
              <StatTile label="Avg. first reply" value="1m 30s" period="Last 30 days" delta={{ value: '18%', direction: 'up' }} invertTrend hint="Lower is better, so an increase is the bad direction." />
              <StatTile label="Credits left" value={formatMoney(980000, 'INR')} period="Resets 1 Sep" tone="warning" />
              <StatTile label="Rating" value={undefined} empty="Not rated yet" period="All time" />
              <StatTile label="Loading" value={undefined} period="Last 30 days" loading />
              <StatTile label="Flat" value="120" period="Last 30 days" delta={{ value: '0%', direction: 'flat' }} />
              <StatTile label="Failed sends" value="3" period="Last 7 days" tone="danger" />
            </CardBody>
          </Card>

          <Grid cols={2}>
            <Card>
              <CardHeader size="sm" title="FigureList · FigureRow" titleAs="h3" />
              <CardBody>
                <FigureList>
                  <FigureRow label="Plan" value="Professional" />
                  <FigureRow label="Included credits" value="10,000" />
                  <FigureRow label="Top-ups" value="2,500" hint="Expires 30 Nov" />
                  <FigureRow label="Overage" value="−400" tone="danger" />
                  <FigureRow label="Total available" value="12,500" emphasis />
                </FigureList>
              </CardBody>
            </Card>
            <Card>
              <CardHeader eyebrow="Visitor" title="Ana Ruiz" titleAs="h3" description="First seen 12 August 2026" />
              <CardBody className="space-y-4">
                <Demo label="DefinitionList · inline">
                  <DefinitionList
                    layout="inline"
                    items={[
                      { label: 'Email', value: 'ana@northwind.com' },
                      { label: 'Company', value: 'Northwind' },
                      { label: 'First seen', value: '12 Aug 2026' },
                      { label: 'Conversations', value: <span className="figure">6</span> },
                    ]}
                  />
                </Demo>
                <Demo label="DefinitionList · stacked, two columns">
                  <DefinitionList
                    columns={2}
                    items={[
                      { label: 'Location', value: 'Lisbon, PT' },
                      { label: 'Device', value: 'macOS · Chrome' },
                    ]}
                  />
                </Demo>
              </CardBody>
              <CardFooter>
                <Button size="sm" variant="ghost">View conversation</Button>
                <Button size="sm" variant="primary">Follow up</Button>
              </CardFooter>
            </Card>
          </Grid>
        </Stack>
      </Section>

      <Section
        title="Keys, and the snippet"
        description="A value the customer has to move somewhere else. Copying is the whole purpose, so the control is the copy button."
      >
        <Grid cols={2}>
          <Card>
            <CardHeader eyebrow="Install" title="Keys" titleAs="h3" />
            <CardBody className="flex flex-col gap-2">
              <CopyField label="Chatbot key" value="bot-6a427d4529b9" />
              <CopyField compact secret label="API key" value="sk_live_51NcXf2K9mPqR" />
              <CopyField
                label="Webhook secret"
                value="whsec_9f2c41aa77"
                secret
                maskedValue="whsec_••••••••"
                onCopy={(ok) => (ok ? toast.success('Copied') : toast.error('Copy failed'))}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader eyebrow="Install" title="Embed snippet" titleAs="h3" />
            <CardBody className="space-y-3">
              <CodeBlock
                caption="Paste before </body>"
                code={'<script src="https://cdn.oyechats.com/oyechats-widget.js"\n        data-bot-key="bot-6a427d4529b9"></script>'}
              />
              <CodeBlock label="curl" code={'curl -H "X-API-Key: $KEY" https://api.oyechats.com/bots'} />
            </CardBody>
          </Card>
        </Grid>
      </Section>

      <Section
        title="Ranked bars"
        description="A label, a proportional bar, a figure. Not a Progress and not a Meter — this is a comparison between peers, not a quantity against a ceiling."
      >
        <Stack gap="card">
          <Card>
            <CardHeader size="sm" title="Most asked · one row selected" titleAs="h3" description="Click a row: selecting a bar is how a panel filters the table beside it." />
            <CardBody flush>
              <RankedBars
                label="Most asked questions"
                items={[
                  { id: '1', label: 'How much does it cost?', value: 412, display: '412', meta: '31% of all questions', onSelect: () => setRankedSelection('1'), selected: rankedSelection === '1' },
                  { id: '2', label: 'Do you integrate with Shopify?', value: 268, display: '268', meta: '20%', onSelect: () => setRankedSelection('2'), selected: rankedSelection === '2' },
                  { id: '3', label: 'Where are you based?', value: 97, display: '97', meta: '7%', onSelect: () => setRankedSelection('3'), selected: rankedSelection === '3' },
                  { id: '4', label: 'Can I get a refund?', value: 41, display: '41', meta: '3%', onSelect: () => setRankedSelection('4'), selected: rankedSelection === '4' },
                ]}
              />
            </CardBody>
          </Card>
          <Grid cols={2}>
            <Card>
              <CardHeader size="sm" title="Loading" titleAs="h3" />
              <CardBody flush>
                <RankedBars label="Most asked questions" items={[]} loading loadingRows={4} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader size="sm" title="Empty" titleAs="h3" />
              <CardBody flush>
                <RankedBars
                  label="Most asked questions"
                  items={[]}
                  emptyTitle="No questions yet"
                  emptyDescription="Ask your chatbot something from the preview and it will appear here."
                />
              </CardBody>
            </Card>
          </Grid>
        <Card>
          <CardHeader
            size="sm"
            title="Four digits, and a compound display"
            titleAs="h3"
            description="The figure column was a fixed w-16 — 64px — so it held 412 and ran out of its own box at anything longer."
          />
          <CardBody flush>
            <RankedBars
              label="Pages that send the most visitors"
              items={[
                { id: 'a', label: '/pricing', value: 12480, display: '12,480 · 45%' },
                { id: 'b', label: '/docs/getting-started', value: 8021, display: '8,021 · 29%' },
                { id: 'c', label: '/integrations/shopify', value: 4310, display: '4,310 · 16%' },
                { id: 'd', label: '/blog/why-rag', value: 2790, display: formatMoney(279000, 'INR') },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader size="sm" title="Tones" titleAs="h3" description="Blue is interactive; the ramp is data. A bar fill is never accent." />
          <CardBody flush>
            <RankedBars
              label="Handoff outcomes"
              max={500}
              tone="success"
              items={[
                { id: 'a', label: 'Answered by the bot', value: 412, display: '412' },
                { id: 'b', label: 'Handed to a human', value: 68, display: '68' },
                { id: 'c', label: 'Abandoned', value: 20, display: '20' },
              ]}
            />
          </CardBody>
        </Card>
        </Stack>
      </Section>

      <Section
        title="Zoom and pan canvas"
        description="A pannable, zoomable SVG viewport with keyboard navigation (arrow keys pan, +/- zoom, 0 resets) and accessible toolbar controls."
      >
        <Card>
          <CardHeader title="Interactive diagram viewport" titleAs="h3" description="Click and drag to pan, scroll wheel or +/- keys to zoom." />
          <CardBody>
            <ZoomPanCanvas label="Demo diagram" viewBoxWidth={800} viewBoxHeight={300}>
              <rect x={100} y={100} width={120} height={60} rx={8} fill="var(--color-surface)" stroke="var(--color-border-strong)" strokeWidth={1.5} />
              <text x={160} y={135} textAnchor="middle" fill="var(--color-text-primary)" fontSize={13} fontFamily="sans-serif">Node A</text>
              <circle cx={400} cy={130} r={40} fill="var(--color-surface)" stroke="var(--color-border-strong)" strokeWidth={1.5} />
              <text x={400} y={135} textAnchor="middle" fill="var(--color-text-primary)" fontSize={13} fontFamily="sans-serif">Node B</text>
              <rect x={580} y={100} width={120} height={60} rx={8} fill="var(--color-surface)" stroke="var(--color-border-strong)" strokeWidth={1.5} />
              <text x={640} y={135} textAnchor="middle" fill="var(--color-text-primary)" fontSize={13} fontFamily="sans-serif">Node C</text>
              <path d="M 220 130 C 290 130, 310 130, 360 130" fill="none" stroke="var(--color-accent-500)" strokeWidth={2} />
              <path d="M 440 130 C 490 130, 510 130, 580 130" fill="none" stroke="var(--color-accent-500)" strokeWidth={2} />
            </ZoomPanCanvas>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Charts"
        description="One frame, one palette, one tooltip, and the same numbers as a table underneath — because a chart is a picture, and a picture on its own is unreadable to half its audience."
      >
        <Stack gap="card">
          <Card>
            <CardHeader title="Messages and conversations" titleAs="h3" description="Last 7 days." />
            <CardBody>
              <ChartFrame
                height={240}
                summary="Messages rose from 318 on 10 August to a peak of 412 on 12 August, dipped to 291 on 14 August and recovered to 381 on 16 August. Conversations tracked them at roughly a quarter of the volume throughout."
                legend={
                  <ChartLegend
                    items={[
                      { label: 'Messages', seriesIndex: 0, value: '2,514' },
                      { label: 'Conversations', seriesIndex: 1, value: '575' },
                      // A reference line, drawn as a line. The marker was
                      // always a filled dot, so an average or a plan limit had
                      // no legal entry at all.
                      { label: 'Average', seriesIndex: 7, marker: 'dash', value: '359' },
                    ]}
                  />
                }
                dataTable={
                  <ChartDataTable
                    caption="Messages and conversations per day"
                    columns={[
                      { key: 'day', header: 'Day' },
                      { key: 'messages', header: 'Messages', numeric: true },
                      { key: 'conversations', header: 'Conversations', numeric: true },
                    ]}
                    rows={TRAFFIC.map((point) => ({
                      day: point.day,
                      messages: formatNumber(point.messages),
                      conversations: formatNumber(point.conversations),
                    }))}
                  />
                }
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={TRAFFIC} margin={CHART_MARGIN}>
                    <CartesianGrid {...CHART_GRID} />
                    <XAxis dataKey="day" minTickGap={16} {...CHART_AXIS} />
                    <YAxis width={36} allowDecimals={false} {...CHART_AXIS} />
                    <RechartsTooltip cursor={CHART_CURSOR} content={<SeriesTooltip />} />
                    <Line
                      type="monotone"
                      name="Messages"
                      dataKey="messages"
                      stroke={seriesColor(0)}
                      strokeDasharray={seriesDash(0)}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      name="Conversations"
                      dataKey="conversations"
                      stroke={seriesColor(1)}
                      strokeDasharray={seriesDash(1)}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartFrame>
            </CardBody>
          </Card>

          <Grid cols={3}>
            <Card>
              <CardHeader size="sm" title="Chart · loading" titleAs="h3" />
              <CardBody>
                <ChartFrame height={140} loading summary="Messages per day, loading.">
                  <div />
                </ChartFrame>
              </CardBody>
            </Card>
            <Card>
              <CardHeader size="sm" title="Chart · error" titleAs="h3" />
              <CardBody>
                <ChartFrame
                  height={140}
                  error="We could not reach the analytics service."
                  onRetry={() => toast.info('Retrying…')}
                  summary="Messages per day, unavailable."
                >
                  <div />
                </ChartFrame>
              </CardBody>
            </Card>
            <Card>
              <CardHeader size="sm" title="Chart · empty" titleAs="h3" />
              <CardBody>
                <ChartFrame
                  height={140}
                  empty
                  emptyTitle="No messages in this period"
                  emptyDescription="Try a longer range."
                  summary="No messages in this period."
                >
                  <div />
                </ChartFrame>
              </CardBody>
            </Card>
          </Grid>

          <Grid cols={2}>
            <Card>
              <CardHeader size="sm" title="ChartTooltip, on its own" titleAs="h3" description="Two features had written this character for character." />
              <CardBody>
                <ChartTooltip
                  label="12 Aug 2026"
                  rows={[
                    { name: 'Messages', value: '412', seriesIndex: 0 },
                    { name: 'Conversations', value: '96', seriesIndex: 1 },
                    { name: 'Handed over', value: ABSENT },
                  ]}
                />
              </CardBody>
            </Card>
            <Card>
              <CardHeader size="sm" title="ChartDataTable" titleAs="h3" description="The chart, as the table it is always also available as." />
              <CardBody>
                <ChartDataTable
                  caption="Messages per day"
                  columns={[
                    { key: 'day', header: 'Day' },
                    { key: 'messages', header: 'Messages', numeric: true },
                  ]}
                  rows={TRAFFIC.slice(0, 3).map((point) => ({
                    day: point.day,
                    messages: formatNumber(point.messages),
                  }))}
                  rowKey={(row) => String(row.day)}
                />
              </CardBody>
            </Card>
          </Grid>
        </Stack>
      </Section>

      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        eyebrow="Lead"
        title="Ana Ruiz"
        description="Northwind · Lisbon, PT"
        footer={<Button variant="primary" block>Follow up</Button>}
      >
        <Stack>
          <DefinitionList
            items={[
              { label: 'Email', value: 'ana@northwind.com' },
              { label: 'First seen', value: formatDateTime('2026-08-12T10:00:00Z') },
              { label: 'Conversations', value: '4' },
            ]}
          />
          <Section title="Qualification">
            <div className="space-y-3">
              <Meter label="Budget" used={4} limit={5} />
              <Meter label="Authority" used={5} limit={5} />
              <Meter label="Need" used={3} limit={5} />
              <Meter label="Timing" used={2} limit={5} />
            </div>
          </Section>
        </Stack>
      </Drawer>
    </Stack>
  );
}

/* -------------------------------------------------------------- overlays */

const DIALOG_SIZES: DialogSize[] = ['sm', 'md', 'lg', 'xl'];
/** Four columns in a half-width card — the shape that lost its last cell. */
const NARROW_TABLE = {
  rowKey: (row: { id: string }) => row.id,
  rows: [
    { id: 'b1', name: 'Acme Support — Production EU', status: 'Live', documents: '412' },
    { id: 'b2', name: 'Northwind Sales — EMEA', status: 'Live', documents: '1,204' },
    { id: 'b3', name: 'Beacon Health — staging', status: 'Not installed', documents: '0' },
  ],
  columns: [
    {
      key: 'name',
      header: 'Chatbot',
      rowHeader: true,
      render: (row: { name: string }) => row.name,
    },
    {
      key: 'status',
      header: 'Status',
      width: '7rem',
      truncate: false,
      render: (row: { status: string }) => (
        <Badge tone={row.status === 'Live' ? 'success' : 'neutral'} dot>
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'documents',
      header: 'Documents',
      type: 'number' as const,
      width: '5.5rem',
      render: (row: { documents: string }) => row.documents,
    },
    {
      key: 'actions',
      header: '',
      align: 'right' as const,
      width: '6rem',
      truncate: false,
      render: () => (
        <Button size="sm" variant="ghost">
          Open
        </Button>
      ),
    },
  ],
};

const DRAWER_WIDTHS: DrawerWidth[] = ['xs', 'sm', 'md', 'lg', 'xl'];

function OverlaysPanel() {
  const [dialogSize, setDialogSize] = useState<DialogSize | null>(null);
  const [drawerWidth, setDrawerWidth] = useState<DrawerWidth | null>(null);
  const [flushDrawer, setFlushDrawer] = useState(false);
  const [stubbornOpen, setStubbornOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [simpleConfirmOpen, setSimpleConfirmOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchasePhase, setPurchasePhase] = useState<PurchasePhase>('confirm');
  const [columns, setColumns] = useState({ status: true, owner: false });
  const [onlyQualified, setOnlyQualified] = useState(false);

  return (
    <Stack>
      <Section
        title="Dialogs and drawers"
        description="All on Base UI, so focus, scroll lock and dismissal are correct by construction. Open every one of them — that is what this tab is for."
      >
        <Card>
          <CardBody className="space-y-4">
            <Demo label="Dialog · four sizes">
              <div className="flex flex-wrap gap-2">
                {DIALOG_SIZES.map((size) => (
                  <Button key={size} variant="secondary" onClick={() => setDialogSize(size)}>
                    Dialog {size}
                  </Button>
                ))}
                <Button variant="ghost" onClick={() => setStubbornOpen(true)}>
                  Not dismissible
                </Button>
              </div>
            </Demo>
            <Demo label="Drawer · five widths, and a flush body">
              <div className="flex flex-wrap gap-2">
                {DRAWER_WIDTHS.map((width) => (
                  <Button key={width} variant="secondary" onClick={() => setDrawerWidth(width)}>
                    Drawer {width}
                  </Button>
                ))}
                <Button variant="secondary" onClick={() => setFlushDrawer(true)}>
                  Drawer flush
                </Button>
              </div>
            </Demo>
            <Demo label="ConfirmDialog">
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" onClick={() => setConfirmOpen(true)}>
                  Delete chatbot… (typed phrase)
                </Button>
                <Button variant="secondary" onClick={() => setSimpleConfirmOpen(true)}>
                  Discard draft…
                </Button>
              </div>
            </Demo>
            <Demo label="PurchaseDialog">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    setPurchasePhase('confirm');
                    setPurchaseOpen(true);
                  }}
                >
                  Buy branding removal…
                </Button>
                <p className="text-xs text-text-tertiary">
                  Cycle confirm → processing → activating → done with the footer inside.
                </p>
              </div>
            </Demo>
            <Demo label="PurchaseSuccess">
              {/* The shared celebration, also used by the plan picker's settled
                  state. Shown here without a dialog around it. */}
              <div className="max-w-xs rounded-lg border border-border bg-surface p-5">
                <PurchaseSuccess
                  greetingName="Priya"
                  message="You’re on Standard. Your new credits and limits are available now."
                />
              </div>
            </Demo>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Menus"
        description="Every part in one menu — including a group label, which is the part that took the whole route down when it rendered without its group."
      >
        <Card>
          <CardBody className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <Demo label="Every part">
              <MenuRoot>
                <MenuTrigger render={<Button variant="secondary">Row actions</Button>} />
                <MenuContent>
                  <MenuGroup label="Chatbot">
                    <MenuItem icon={<MessageSquare aria-hidden className="h-icon-sm w-icon-sm" />} onSelect={() => toast.info('Open')}>
                      Open
                    </MenuItem>
                    <MenuItem
                      icon={<Globe aria-hidden className="h-icon-sm w-icon-sm" />}
                      shortcut={`${modifierKey()} D`}
                      onSelect={() => toast.info('Demo')}
                    >
                      View demo
                    </MenuItem>
                    <MenuItem disabled icon={<Settings aria-hidden className="h-icon-sm w-icon-sm" />}>
                      Transfer ownership
                    </MenuItem>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup label="Sort">
                    <MenuItem selected onSelect={() => {}}>
                      Newest first
                    </MenuItem>
                    <MenuItem onSelect={() => {}}>Highest score</MenuItem>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup label="Columns">
                    <MenuCheckboxItem
                      checked={columns.status}
                      onCheckedChange={(next) => setColumns((state) => ({ ...state, status: next }))}
                    >
                      Status
                    </MenuCheckboxItem>
                    <MenuCheckboxItem
                      checked={columns.owner}
                      onCheckedChange={(next) => setColumns((state) => ({ ...state, owner: next }))}
                      shortcut="⇧O"
                    >
                      Owner
                    </MenuCheckboxItem>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuSub>
                    <MenuSubTrigger icon={<FileText aria-hidden className="h-icon-sm w-icon-sm" />}>
                      Move to
                    </MenuSubTrigger>
                    <MenuSubContent>
                      <MenuItem onSelect={() => {}}>Archive</MenuItem>
                      <MenuItem onSelect={() => {}}>Trash</MenuItem>
                    </MenuSubContent>
                  </MenuSub>
                  <MenuSeparator />
                  <MenuItem destructive icon={<Trash2 aria-hidden className="h-icon-sm w-icon-sm" />} onSelect={() => {}}>
                    Delete…
                  </MenuItem>
                </MenuContent>
              </MenuRoot>
            </Demo>

            <Demo label="MenuLabel · a heading with loose rows under it">
              <MenuRoot>
                <MenuTrigger render={<Button variant="ghost">Bare label</Button>} />
                <MenuContent align="start" side="bottom">
                  <MenuLabel>Chatbot</MenuLabel>
                  <MenuItem onSelect={() => {}}>Rename</MenuItem>
                  <MenuItem onSelect={() => {}}>Duplicate</MenuItem>
                </MenuContent>
              </MenuRoot>
            </Demo>

            <Demo label="Popover · header, body, footer, close">
              <PopoverRoot>
                <PopoverTrigger render={<Button variant="secondary">Filters</Button>} />
                <PopoverContent className="w-72" align="start">
                  <PopoverHeader>Filter leads</PopoverHeader>
                  <PopoverBody>
                    <Stack gap="card">
                      <SearchField label="Search leads" value="" onValueChange={() => {}} placeholder="Search" />
                      <Checkbox
                        checked={onlyQualified}
                        onCheckedChange={(next) => setOnlyQualified(next === true)}
                        label="Only sales-qualified"
                      />
                      <Checkbox label="Has a meeting booked" />
                    </Stack>
                  </PopoverBody>
                  <PopoverFooter>
                    <PopoverClose render={<Button size="sm" variant="ghost">Reset</Button>} />
                    <Button size="sm" variant="primary">
                      Apply
                    </Button>
                  </PopoverFooter>
                </PopoverContent>
              </PopoverRoot>
            </Demo>

            <Demo label="Tooltip · four sides, and disabled">
              <div className="flex flex-wrap items-center gap-2">
                {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                  <Tooltip key={side} content={`Opens on the ${side}`} side={side}>
                    <Button size="sm" variant="ghost">
                      {side}
                    </Button>
                  </Tooltip>
                ))}
                <Tooltip content="Never shown" disabled>
                  <Button size="sm" variant="ghost">
                    disabled
                  </Button>
                </Tooltip>
                <Tooltip content="Instant" delay={0} align="start">
                  <Button size="sm" variant="ghost">
                    no delay
                  </Button>
                </Tooltip>
              </div>
            </Demo>

            <Demo label="Toasts">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => toast.success('Knowledge base updated', { description: '12 pages re-indexed.' })}
                >
                  Success
                </Button>
                <Button size="sm" variant="secondary" onClick={() => toast.error('That upload failed')}>
                  Error
                </Button>
                <Button size="sm" variant="secondary" onClick={() => toast.info('Retrying…')}>
                  Info
                </Button>
                <Button size="sm" variant="secondary" onClick={() => toast.warning('You are close to your credit limit')}>
                  Warning
                </Button>
              </div>
            </Demo>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Alerts"
        description="Anything the user must read to proceed stays on the page. A toast is for what has already happened."
      >
        <div className="space-y-3">
          <Alert tone="neutral" title="Your chatbot is not live yet">
            Install the widget on your website and we will confirm it here automatically.
          </Alert>
          <Alert tone="success">Training finished. 412 pages indexed.</Alert>
          <Alert
            tone="warning"
            title="You are close to your credit limit"
            action={<Button size="sm" variant="secondary">Buy credits</Button>}
          >
            At the current rate you will run out in about four days, and your chatbot stops
            answering.
          </Alert>
          <Alert
            tone="danger"
            title="Your last payment failed"
            live
            action={<Button size="sm" variant="secondary">Update card</Button>}
          >
            We will retry on 21 August. Until then your chatbot keeps answering.
          </Alert>
          <Alert tone="plan" title="Qualification is on Professional">
            Score every conversation against BANT and route the hot ones to a human.
          </Alert>
          <Alert tone="neutral" icon={<Search aria-hidden className="h-icon-md w-icon-md" />}>
            An alert with its own glyph and no title — one clause, one line.
          </Alert>
        </div>
      </Section>

      {DIALOG_SIZES.map((size) => (
        <Dialog
          key={size}
          open={dialogSize === size}
          onOpenChange={(open) => setDialogSize(open ? size : null)}
          eyebrow={size === 'lg' ? 'Workspace' : undefined}
          size={size}
          title="Invite a teammate"
          description="They will get an email with a link to join this workspace."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialogSize(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialogSize(null)}>
                Send invite
              </Button>
            </>
          }
        >
          <Stack>
            {/* `Grid cols="pairs"`, not `sm:grid-cols-2`. The overlay body
                declares `@container/page`, so this asks the DIALOG how wide it
                is — and `pairs` is a step a dialog can actually reach: the card
                ramp's two-up starts at 48rem and a dialog body is 408–856px
                after its padding, so `cols={2}` could never fire inside one.
                Open `sm` and then `xl`. */}
            <Grid cols="pairs">
              <Field label="Email" required>
                <Input type="email" placeholder="teammate@acme.com" />
              </Field>
              <Field label="Role" hint="Operators can answer conversations but cannot change billing.">
                <Select
                  label="Role"
                  options={[
                    { value: 'operator', label: 'Operator' },
                    { value: 'admin', label: 'Admin' },
                  ]}
                  defaultValue="operator"
                />
              </Field>
            </Grid>
            <PropertyGrid
              columns={2}
              density="compact"
              items={[
                { label: 'Workspace', value: 'Acme Inc' },
                { label: 'Seats left', value: <span className="figure">1</span> },
              ]}
            />
          </Stack>
        </Dialog>
      ))}

      <Dialog
        open={stubbornOpen}
        onOpenChange={setStubbornOpen}
        dismissible={false}
        title="Finish setting up billing"
        description="Neither Escape nor a click outside closes this one — the only way out is a control inside it."
        footer={
          <Button variant="primary" onClick={() => setStubbornOpen(false)}>
            Done
          </Button>
        }
      >
        <p className="text-prose text-text-secondary">
          Reserved for a decision that cannot be deferred. Everything else is dismissible.
        </p>
      </Dialog>

      {DRAWER_WIDTHS.map((width) => (
        <Drawer
          key={width}
          open={drawerWidth === width}
          onOpenChange={(open) => setDrawerWidth(open ? width : null)}
          width={width}
          eyebrow="Lead"
          title="Ana Ruiz"
          description={`Northwind · width="${width}"`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDrawerWidth(null)}>
                Close
              </Button>
              <Button variant="primary">Follow up</Button>
            </>
          }
        >
          <Stack>
            <PropertyGrid
              items={[
                { label: 'Email', value: 'ana@northwind.com' },
                { label: 'First seen', value: '2 Jun 2026, 10:00' },
                { label: 'Source', value: 'https://acme.com/pricing' },
                { label: 'Tier', value: 'Warm' },
              ]}
            />
            <p className="text-prose text-text-secondary">
              A drawer is square against the three edges it is anchored to and rounded on the one
              edge that is a boundary between the panel and the page it covers. At{' '}
              <code className="font-mono text-xs">xs</code> the facts stack, because the grid
              asks its own container and 320px is not room for a label column.
            </p>
          </Stack>
        </Drawer>
      ))}

      <Drawer
        open={flushDrawer}
        onOpenChange={setFlushDrawer}
        width="lg"
        flush
        title="Columns"
        description='flush drops the body padding for a child that owns its own edges.'
        footer={
          <Button variant="ghost" onClick={() => setFlushDrawer(false)}>
            Close
          </Button>
        }
      >
        <SettingGroup>
          <SettingRow label="Status" description="Shown as a badge in the first cell.">
            <Switch checked label="Status column" hideLabel onCheckedChange={() => {}} />
          </SettingRow>
          <SettingRow label="Owner" description="Hidden below md.">
            <Switch checked={false} label="Owner column" hideLabel onCheckedChange={() => {}} />
          </SettingRow>
          <SettingBand>
            <p className="text-xs text-text-secondary">
              Without <code className="font-mono text-2xs">flush</code> this list is inset 20px
              from a panel it was built to reach, and its hairlines stop short of the border.
            </p>
          </SettingBand>
        </SettingGroup>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete Acme Support?"
        description="Its knowledge base, every conversation and every lead it captured are deleted with it. This cannot be undone."
        confirmLabel="Delete chatbot"
        destructive
        confirmPhrase="Acme Support"
        onConfirm={() => {
          setConfirmOpen(false);
          toast.success('Chatbot deleted');
        }}
      >
        {/* `AlertDialog.Description` renders a `<p>`, so an `Alert` — a `<div>`
            — could not go in the body at all, and two surfaces put the warning
            outside the dialog instead. */}
        <Alert tone="danger" title="412 documents and 1,204 conversations">
          Deleting the chatbot deletes its knowledge base. Export the conversations first if
          you need them.
        </Alert>
      </ConfirmDialog>

      <ConfirmDialog
        open={simpleConfirmOpen}
        onOpenChange={setSimpleConfirmOpen}
        title="Discard this draft?"
        description="Your unsaved changes to the greeting will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => setSimpleConfirmOpen(false)}
      />

      <PurchaseDialog
        open={purchaseOpen}
        onOpenChange={setPurchaseOpen}
        phase={purchasePhase}
        title="Remove OyeChats branding"
        summary={
          <div className="space-y-2 text-prose text-text-secondary">
            <p>
              Hides the “Powered by OyeChats” badge on your widget. A recurring charge on your
              subscription until you cancel.
            </p>
            <p className="font-medium text-text-primary">₹499/mo</p>
            <p className="text-xs text-text-tertiary">Excludes GST. 18% GST is added at checkout.</p>
          </div>
        }
        confirmLabel="Continue to secure checkout"
        onConfirm={() => {
          // Walk the real sequence a paid purchase produces, so the demo shows
          // the activation gap rather than jumping straight to success.
          setPurchasePhase('processing');
          window.setTimeout(() => setPurchasePhase('activating'), 800);
          window.setTimeout(() => setPurchasePhase('done'), 1800);
        }}
        activatingMessage="Payment received. Switching branding removal on…"
        doneTitle="Branding removed"
        doneMessage="The “Powered by OyeChats” badge is gone from your widget."
        greetingName="Priya"
      />
    </Stack>
  );
}

/* -------------------------------------------------------------- the four states */

const STATE_SIZES: StateSize[] = ['page', 'panel', 'inline'];

function StatesPanel() {
  return (
    <Stack>
      <Section
        title="The four states every surface owes its user"
        description="Loading, empty, error, and forbidden — at the scale of the thing they are standing in for. A state seated in a card is not a poster."
      >
        <Grid cols={3}>
          {STATE_SIZES.map((size) => (
            <Card key={size}>
              <CardHeader size="sm" title={`Empty · ${size}`} titleAs="h3" />
              <CardBody flush>
                <EmptyState
                  size={size}
                  icon={Inbox}
                  title="No conversations yet"
                  description="Once your chatbot is live, everything a visitor asks lands here."
                  action={<Button size="sm" variant="primary">Install the widget</Button>}
                />
              </CardBody>
            </Card>
          ))}
          {STATE_SIZES.map((size) => (
            <Card key={size}>
              <CardHeader size="sm" title={`Error · ${size}`} titleAs="h3" />
              <CardBody flush>
                <ErrorState
                  size={size}
                  description="We could not reach the analytics service."
                  onRetry={() => toast.info('Retrying…')}
                  polite={size !== 'page'}
                />
              </CardBody>
            </Card>
          ))}
        </Grid>
      </Section>

      <Section
        title="flush · a state seated in a padded body"
        description="A state carries its own 20px gutter. Inside a CardBody that already draws one they add up, and the state's copy sits 20px inside every label around it — worked around twice with a negative margin before this prop existed."
      >
        <Grid cols={2}>
          <Card>
            <CardHeader size="sm" title="Double-padded" titleAs="h3" />
            <CardBody>
              <p className="mb-2 text-xs text-text-secondary">A label on the body's gutter.</p>
              <EmptyState
                size="inline"
                title="No conversations yet"
                description="Once your chatbot is live, everything a visitor asks lands here."
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="flush" titleAs="h3" />
            <CardBody>
              <p className="mb-2 text-xs text-text-secondary">A label on the body's gutter.</p>
              <EmptyState
                flush
                size="inline"
                title="No conversations yet"
                description="Once your chatbot is live, everything a visitor asks lands here."
              />
            </CardBody>
          </Card>
        </Grid>
      </Section>

      <Section
        title="Aligned to the start, and framed"
        description="Centred copy is for a page that is nothing but the state. Inside a list or a table the state is left-aligned, on the same gutter as the rows it replaced."
      >
        <Grid cols={2}>
          <Card>
            <CardHeader size="sm" title="align=start" titleAs="h3" />
            <CardBody flush>
              <EmptyState
                size="inline"
                align="start"
                title="No documents match “refund”"
                description="Clear the search to see all 412."
                action={<Button size="sm" variant="ghost">Clear search</Button>}
              />
            </CardBody>
          </Card>
          <div>
            <Eyebrow className="mb-1.5">framed · a state that is the whole route</Eyebrow>
            <ErrorState
              framed
              title="This page did not load"
              description="Nothing was lost. Your chatbots keep answering while this screen is up."
              onRetry={() => toast.info('Retrying…')}
              retryLabel="Try again"
            />
          </div>
        </Grid>
      </Section>

      <Section
        title="Locked"
        description="A capability the plan does not include is not an error. It shows what is behind it, and where to get it."
      >
        <Grid cols={2}>
          <LockedState
            title="Visitor journey is on Professional"
            description="See the pages a visitor read before they started a conversation, and which of them lead to qualified leads."
            action={<Button size="sm" variant="primary">Compare plans</Button>}
            preview={
              <div className="space-y-2 p-5">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-24 w-full" />
              </div>
            }
          />
          <Card>
            <CardHeader size="sm" title="Seated · size=panel" titleAs="h3" />
            <CardBody flush>
              <LockedState
                size="panel"
                title="Qualification is on Professional"
                description="Score every conversation against BANT."
                action={<Button size="sm" variant="secondary">Compare plans</Button>}
              />
            </CardBody>
          </Card>
        </Grid>
      </Section>

      <Section
        title="Loading shapes"
        description="A skeleton that does not match what arrives causes a layout jump on every load. `LoadingRows` was for a while the only shape in the system."
      >
        <Grid cols={3}>
          <Card>
            <CardHeader size="sm" title="Rows" titleAs="h3" />
            <CardBody>
              <LoadingRows rows={3} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Bars" titleAs="h3" />
            <CardBody flush>
              <LoadingBars rows={3} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Conversations" titleAs="h3" />
            <CardBody flush>
              <LoadingConversations rows={3} />
            </CardBody>
          </Card>
        </Grid>
      </Section>

      <Section
        title="FullPageState"
        description="The whole window is the state: a crash, a 403 on a route, the bootstrap. Shown here inside a clipped frame, because in production it owns the viewport and there is no shell to anchor to."
      >
        <Grid cols={2}>
          <div className="h-96 overflow-hidden rounded-lg border border-border">
            <FullPageState
              className="min-h-full"
              tone="danger"
              icon={TriangleAlert}
              title="The console did not start"
              description="Your chatbots keep answering visitors while this screen is up."
              actions={
                <>
                  <Button variant="primary" onClick={() => toast.info('Reload')}>
                    Reload
                  </Button>
                  <Link to="/dev/ui" className={buttonClass('secondary', 'md')}>
                    Go to Home
                  </Link>
                </>
              }
              footnote="developer@oyechats.com"
            />
          </div>
          <div className="h-96 overflow-hidden rounded-lg border border-border">
            <FullPageState
              className="min-h-full"
              busy
              title="Starting the console"
              description="Loading your workspace. This announces politely rather than as an alert, because it is often the first thing rendered."
            />
          </div>
        </Grid>
      </Section>
    </Stack>
  );
}

/* ---------------------------------------------------------------- tokens */

const NOW = new Date('2026-08-20T10:30:00Z');

function TokensPanel() {
  const wide = useMediaQuery('(min-width: 64rem)');
  const { state, copy } = useClipboard();

  const formatters: { call: string; result: string }[] = [
    { call: 'formatNumber(1204)', result: formatNumber(1204) },
    { call: 'formatNumber(null)', result: formatNumber(null) },
    { call: 'formatCompact(1284000)', result: formatCompact(1284000) },
    { call: "formatMoney(980000,'INR')", result: formatMoney(980000, 'INR') },
    { call: 'formatPercent(0.317, 1)', result: formatPercent(0.317, 1) },
    { call: 'formatBytes(10485760)', result: formatBytes(10485760) },
    { call: 'formatDate(…)', result: formatDate('2026-08-19T09:12:00Z') },
    { call: 'formatDateTime(…)', result: formatDateTime('2026-08-19T09:12:00Z') },
    { call: 'formatTime(…)', result: formatTime('2026-08-19T09:12:00Z') },
    { call: 'formatRelative(…, NOW)', result: formatRelative('2026-08-19T09:12:00Z', NOW) },
    { call: 'formatDuration(90)', result: formatDuration(90) },
    { call: 'truncateId(botKey)', result: truncateId('bot-6a427d4529b9') },
    // Moved out of `src/shell/badgeCount.ts`: a badge count is a formatter, and
    // a table cell or a tab capping one may not import from the shell.
    { call: 'formatBadgeCount(14)', result: formatBadgeCount(14) },
    { call: 'formatBadgeCount(140)', result: formatBadgeCount(140) },
    { call: 'formatBadgeCount(0)', result: formatBadgeCount(0) },
    { call: 'ABSENT', result: ABSENT },
  ];

  const validators: { call: string; result: string }[] = [
    { call: 'validateEmail(valid)', result: String(validateEmail('ana@northwind.com')) },
    { call: 'validateEmail("ana@")', result: String(validateEmail('ana@')) },
    { call: 'validateUrl("acme.com")', result: String(validateUrl('acme.com')) },
    { call: 'normalizeUrl("acme.com")', result: normalizeUrl('acme.com') },
    { call: 'isHexColor("#2b54c8")', result: String(isHexColor('#2b54c8')) },
    { call: 'isHexColor("blue")', result: String(isHexColor('blue')) },
  ];

  return (
    <Stack>
      <Section title="Ground and ink" description="Spaced by measured lightness, not by eye.">
        <Card>
          <CardBody className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            <Swatch name="surface" className="bg-surface" />
            <Swatch name="surface-hover" className="bg-surface-hover" />
            <Swatch name="surface-sunken" className="bg-surface-sunken" />
            <Swatch name="canvas" className="bg-canvas" />
            <Swatch name="surface-active" className="bg-surface-active" />
            <Swatch name="ink" className="bg-ink" />
          </CardBody>
        </Card>
      </Section>

      <Section title="Signal and status">
        <Card>
          <CardBody className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            <Swatch name="accent-500" className="bg-accent-500" />
            <Swatch name="accent-50" className="bg-accent-50" />
            <Swatch name="success" className="bg-success-fill" />
            <Swatch name="warning" className="bg-warning-fill" />
            <Swatch name="danger" className="bg-danger-fill" />
            <Swatch name="plan" className="bg-plan" />
          </CardBody>
          <CardSection className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            <Swatch name="control-disabled" className="bg-control-disabled" />
            <Swatch name="control-disabled-on" className="bg-control-disabled-on" />
          </CardSection>
        </Card>
      </Section>

      <Section
        title="The data ramp"
        description="Eight series, in order, distinguishable without colour: after the fourth, a line takes a dash instead. The first series sits beside accent-500 on purpose — it used to be one step from it, so the default fill of every ranked bar read as interactive."
      >
        <Card>
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-end gap-6">
              <Demo label="chart-1 · the default data fill">
                <div className="h-12 w-32 rounded-md border border-border bg-chart-1" />
              </Demo>
              <Demo label="accent-500 · interactive, and nothing else">
                <div className="h-12 w-32 rounded-md border border-border bg-accent-500" />
              </Demo>
              <p className="max-w-form text-xs text-text-secondary">
                10.0 on the canvas against the accent&rsquo;s 4.09 — twice as dark and far
                less saturated. A bar in the left colour cannot be mistaken for a link.
              </p>
            </div>
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
              {CHART_SERIES.map((color, index) => (
                <div key={color} className="min-w-0">
                  <div
                    className="h-12 rounded-md border border-border"
                    style={{ backgroundColor: seriesColor(index) }}
                  />
                  <p className="mt-1.5 truncate font-mono text-2xs text-text-tertiary">
                    {index}
                    {seriesDash(index) ? ` · ${seriesDash(index)}` : ''}
                  </p>
                </div>
              ))}
            </div>
            <PropertyGrid
              columns={2}
              density="compact"
              items={[
                { label: 'CHART_TICK_PX', value: <span className="figure">{CHART_TICK_PX}</span> },
                {
                  label: 'CHART_DASH',
                  value: (
                    <span className="figure">
                      {CHART_DASH.map((dash) => dash ?? '—').join(' · ')}
                    </span>
                  ),
                  note: 'Applied from the fifth series on, so hue is never the only channel.',
                },
                { label: 'CHART_MARGIN', value: <span className="figure">{JSON.stringify(CHART_MARGIN)}</span> },
                { label: 'CHART_AXIS.stroke', value: <span className="figure">{CHART_AXIS.stroke}</span> },
                { label: 'CHART_GRID.stroke', value: <span className="figure">{CHART_GRID.stroke}</span> },
                { label: 'CHART_CURSOR.stroke', value: <span className="figure">{CHART_CURSOR.stroke}</span> },
              ]}
            />
          </CardBody>
        </Card>
      </Section>

      <Section title="Type">
        <Card>
          <CardBody className="space-y-3">
            <Eyebrow>Mono eyebrow · 11</Eyebrow>
            <p className="text-2xl font-semibold">Headline figure · 28</p>
            <p className="text-xl font-semibold">Page title · 20</p>
            <p className="text-lg font-semibold">Section heading · 18</p>
            <p className="text-base">Body and controls · 14</p>
            <p className="text-prose text-text-secondary">Prose · 14 with looser leading</p>
            <p className="text-sm text-text-secondary">Table cells and dense UI · 13</p>
            <p className="text-xs text-text-tertiary">Meta and captions · 12</p>
            <p className="figure text-base">1,204 · ₹9,800.50 · bot-6a42…29b9 · 1m 30s</p>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Formatters"
        description="One place decides what a number, a date and an absent value look like — which is why a missing figure is an em dash everywhere rather than 'N/A', '—', 'null' and blank."
      >
        <Grid cols={2}>
          <Card>
            <CardHeader size="sm" title="Numbers, money and time" titleAs="h3" />
            <CardBody>
              <PropertyGrid
                density="compact"
                items={formatters.map((row) => ({
                  label: row.call,
                  value: <span className="figure">{row.result}</span>,
                }))}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader size="sm" title="Validators and platform" titleAs="h3" />
            <CardBody className="space-y-4">
              <PropertyGrid
                density="compact"
                items={validators.map((row) => ({
                  label: row.call,
                  value: <span className="figure">{row.result}</span>,
                }))}
              />
              <PropertyGrid
                density="compact"
                items={[
                  { label: 'isMacPlatform()', value: <span className="figure">{String(isMacPlatform())}</span> },
                  { label: 'modifierKey()', value: <Kbd>{modifierKey()}</Kbd> },
                  {
                    label: 'useMediaQuery(64rem)',
                    value: <span className="figure">{String(wide)}</span>,
                    note: 'Resize the window — this cell re-renders.',
                  },
                  {
                    label: 'useClipboard()',
                    value: (
                      <span className="flex items-center gap-2">
                        <span className="figure">{state}</span>
                        <Button size="sm" variant="secondary" onClick={() => void copy('bot-6a427d4529b9')}>
                          Copy a key
                        </Button>
                      </span>
                    ),
                    note: 'It reports a failure rather than silently doing nothing on an insecure origin.',
                  },
                ]}
              />
            </CardBody>
          </Card>
        </Grid>
      </Section>
    </Stack>
  );
}

/* ----------------------------------------------------------------- page */

export function UiGallery() {
  const [tab, setTab] = useState('primitives');

  return (
    <TooltipProvider>
      <Toaster />
      <Page width="full">
        <PageHeader
          eyebrow="Design system"
          title="Console components"
          description="Every primitive in the system, at every size and in every state it actually ships in. If a component is not on this page, it is not in the system."
          actions={
            <>
              <Button variant="secondary" iconLeft={<Download aria-hidden />}>
                Export
              </Button>
              <Button variant="primary" iconLeft={<Plus aria-hidden />}>
                New chatbot
              </Button>
            </>
          }
          toolbar={
            <Tabs
              label="Gallery sections"
              value={tab}
              onValueChange={setTab}
              items={[
                { value: 'primitives', label: 'Primitives' },
                { value: 'layout', label: 'Layout' },
                { value: 'data', label: 'Data' },
                { value: 'overlays', label: 'Overlays' },
                { value: 'states', label: 'States' },
                { value: 'tokens', label: 'Tokens' },
              ]}
            >
              <TabPanel value="primitives">
                <PrimitivesPanel />
              </TabPanel>
              <TabPanel value="layout">
                <LayoutPanel />
              </TabPanel>
              <TabPanel value="data">
                <DataPanel />
              </TabPanel>
              <TabPanel value="overlays">
                <OverlaysPanel />
              </TabPanel>
              <TabPanel value="states">
                <StatesPanel />
              </TabPanel>
              <TabPanel value="tokens">
                <TokensPanel />
              </TabPanel>
            </Tabs>
          }
        />
      </Page>
    </TooltipProvider>
  );
}
