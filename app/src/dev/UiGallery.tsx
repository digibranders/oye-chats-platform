import { useState } from 'react';
import { Download, Globe, Inbox, MessageSquare, Plus, Settings, Trash2 } from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardSection,
  Checkbox,
  CodeBlock,
  Combobox,
  ConfirmDialog,
  CopyField,
  DataTable,
  DefinitionList,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  Eyebrow,
  Field,
  FieldSet,
  FileDrop,
  FigureRow,
  Input,
  Kbd,
  LoadingRows,
  LockedState,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Meter,
  Page,
  PageHeader,
  Progress,
  Section,
  SearchField,
  SegmentedControl,
  Select,
  Separator,
  Skeleton,
  Stack,
  StatTile,
  StatusDot,
  Switch,
  TabPanel,
  Tabs,
  TagInput,
  Textarea,
  Toaster,
  Tooltip,
  TooltipProvider,
  formatDateTime,
  formatMoney,
  toast,
  validateEmail,
  type Column,
} from '../ui';
import { WorkingDots } from '../ui/primitives/Badge';

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
 */

interface Lead {
  id: string;
  name: string;
  company: string;
  score: number;
  status: 'new' | 'qualified' | 'lost';
  lastSeen: string;
}

const LEADS: Lead[] = [
  { id: '1', name: 'Ana Ruiz', company: 'Northwind', score: 82, status: 'qualified', lastSeen: '2026-08-19T09:12:00Z' },
  { id: '2', name: 'Bo Chen', company: 'Acme Logistics', score: 45, status: 'new', lastSeen: '2026-08-19T08:40:00Z' },
  { id: '3', name: 'Cyrus Mehta', company: 'Fynix', score: 12, status: 'lost', lastSeen: '2026-08-18T17:05:00Z' },
  { id: '4', name: 'Dara Okafor', company: 'Beacon Health', score: 67, status: 'qualified', lastSeen: '2026-08-18T11:30:00Z' },
];

const STATUS_TONE = { new: 'neutral', qualified: 'success', lost: 'danger' } as const;

const LEAD_COLUMNS: Column<Lead>[] = [
  {
    key: 'name',
    header: 'Lead',
    pinned: true,
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
    key: 'score',
    header: 'Score',
    align: 'right',
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

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="min-w-0">
      <div className={`h-12 rounded-md border border-border ${className}`} />
      <p className="mt-1.5 truncate font-mono text-2xs text-text-tertiary">{name}</p>
    </div>
  );
}

export function UiGallery() {
  const [tab, setTab] = useState('primitives');
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [switched, setSwitched] = useState(true);
  const [checked, setChecked] = useState(true);
  const [query, setQuery] = useState('');
  const [emails, setEmails] = useState<string[]>(['ops@acme.com']);
  const [agent, setAgent] = useState<string | null>('acme');
  const [selected, setSelected] = useState<Set<string>>(new Set(['1']));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <TooltipProvider>
      <Toaster />
      <Page width="wide">
        <PageHeader
          eyebrow="Design system"
          title="Console components"
          description="Every primitive in the system, in the states it actually ships in. If a component is not on this page, it is not in the system."
          actions={
            <>
              <Button variant="secondary" iconLeft={<Download aria-hidden className="h-4 w-4" />}>
                Export
              </Button>
              <Button variant="primary" iconLeft={<Plus aria-hidden className="h-4 w-4" />}>
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
                { value: 'data', label: 'Data' },
                { value: 'overlays', label: 'Overlays' },
                { value: 'states', label: 'States' },
                { value: 'tokens', label: 'Tokens' },
              ]}
            >
              <TabPanel value="primitives">
                <Stack>
                  <Section title="Buttons" description="Intent, not decoration. At most one primary per view.">
                    <Card>
                      <CardBody className="flex flex-wrap items-center gap-2">
                        <Button variant="primary">Primary</Button>
                        <Button variant="accent">Continue</Button>
                        <Button variant="secondary">Secondary</Button>
                        <Button variant="ghost">Ghost</Button>
                        <Button variant="danger" iconLeft={<Trash2 aria-hidden className="h-4 w-4" />}>
                          Delete
                        </Button>
                        <Button variant="link">Inline link</Button>
                        <Button loading>Saving</Button>
                        <Button disabled>Disabled</Button>
                        <Tooltip content="Open settings">
                          <Button size="icon-md" variant="ghost" aria-label="Settings">
                            <Settings aria-hidden className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                      </CardBody>
                      <CardSection className="flex flex-wrap items-center gap-2">
                        <Button size="sm">Small</Button>
                        <Button size="md">Medium</Button>
                        <Button size="lg">Large</Button>
                        <Separator orientation="vertical" className="h-6" />
                        <span className="text-xs text-text-secondary">
                          Heights come from the spacing scale, so a button and an input on one row line up.
                        </span>
                      </CardSection>
                    </Card>
                  </Section>

                  <Section title="Form controls">
                    <Card>
                      <CardBody className="grid gap-5 md:grid-cols-2">
                        <Field label="Chatbot name" required hint="Shown to visitors in the widget header.">
                          <Input defaultValue="Acme Support" />
                        </Field>
                        <Field label="Website" hint="Include https://" error="That address could not be reached.">
                          <Input defaultValue="acme" leading={<Globe aria-hidden className="h-3.5 w-3.5" />} />
                        </Field>
                        <Field label="Plan">
                          <Select
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
                            ]}
                          />
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
                        <Field label="Search">
                          <SearchField label="Search leads" value={query} onValueChange={setQuery} placeholder="Search leads" />
                        </Field>
                        <Field label="System prompt" className="md:col-span-2">
                          <Textarea defaultValue="You are Acme's support assistant. Answer only from the knowledge base." />
                        </Field>
                      </CardBody>
                      <CardSection className="grid gap-5 md:grid-cols-2">
                        <FieldSet legend="Toggles">
                          <div className="space-y-4">
                            <Switch
                              checked={switched}
                              onCheckedChange={setSwitched}
                              label="Live chat"
                              description="Route conversations to a human when your team is online."
                            />
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(next) => setChecked(next === true)}
                              label="Send me a daily summary"
                              description="One email at 09:00 in your workspace timezone."
                            />
                            <Checkbox checked="indeterminate" aria-label="Select all" label="Partially selected" />
                          </div>
                        </FieldSet>
                        <FieldSet legend="Density" hint="A filter, so it is a radiogroup — one tab stop, arrow keys inside.">
                          <SegmentedControl
                            label="Density"
                            value={density}
                            onChange={setDensity}
                            items={[
                              { value: 'comfortable', label: 'Comfortable' },
                              { value: 'compact', label: 'Compact', count: 36 },
                            ]}
                          />
                        </FieldSet>
                      </CardSection>
                      <CardBody className="space-y-4">
                        <FileDrop
                          label="Drop documents to train on"
                          hint="Or click to choose files"
                          accept={['.pdf', '.docx', '.txt']}
                          maxSizeBytes={10 * 1024 * 1024}
                          onFiles={(files) => toast.success(`${files.length} file(s) accepted`)}
                        />
                      </CardBody>
                    </Card>
                  </Section>

                  <Section title="Status" description="Four tones, always with a word. Progress is motion, never a hue.">
                    <Card>
                      <CardBody className="flex flex-wrap items-center gap-3">
                        <Badge tone="success" dot>Live</Badge>
                        <Badge tone="warning" dot>Pending</Badge>
                        <Badge tone="danger" dot>Failed</Badge>
                        <Badge tone="neutral" dot>Draft</Badge>
                        <Badge tone="plan">Professional</Badge>
                        <Separator orientation="vertical" className="h-5" />
                        <span className="flex items-center gap-1.5 text-sm">
                          <StatusDot tone="success" pulse label="Operator online" /> Online
                        </span>
                        <span className="flex items-center gap-1.5 text-sm text-text-secondary">
                          <WorkingDots label="Training in progress" /> Training
                        </span>
                        <Separator orientation="vertical" className="h-5" />
                        <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                          Press <Kbd>⌘</Kbd> <Kbd>K</Kbd>
                        </span>
                      </CardBody>
                      <CardSection className="grid gap-4 sm:grid-cols-2">
                        <Progress value={64} label="Crawling acme.com" hideLabel={false} />
                        <Progress value={null} label="Waiting for the crawler" />
                        <Meter label="Documents" used={412} limit={500} />
                        <Meter label="Credits" used={9800} limit={10000} />
                      </CardSection>
                    </Card>
                  </Section>
                </Stack>
              </TabPanel>

              <TabPanel value="data">
                <Stack>
                  <Section title="Figures" description="Every number is mono and tabular, so a column cannot jitter.">
                    <Card>
                      <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
                        <StatTile label="Conversations" value="1,204" period="Last 30 days" delta={{ value: '12%', direction: 'up' }} />
                        <StatTile label="Qualified leads" value="86" period="Last 30 days" delta={{ value: '4%', direction: 'down' }} tone="success" />
                        <StatTile label="Avg. first reply" value="1m 30s" period="Last 30 days" delta={{ value: '18%', direction: 'up' }} invertTrend />
                        <StatTile label="Credits left" value={formatMoney(980000, 'INR')} period="Resets 1 Sep" tone="warning" />
                      </CardBody>
                      <CardSection>
                        <dl>
                          <FigureRow label="Plan" value="Professional" />
                          <FigureRow label="Included credits" value="10,000" />
                          <FigureRow label="Top-ups" value="2,500" hint="Expires 30 Nov" />
                          <FigureRow label="Total available" value="12,500" emphasis />
                        </dl>
                      </CardSection>
                    </Card>
                  </Section>

                  <Section
                    title="Table"
                    description="Sortable, selectable, pinned first column, and all four states."
                  >
                    <DataTable
                      caption="Leads"
                      columns={LEAD_COLUMNS}
                      rows={LEADS}
                      rowKey={(row) => row.id}
                      rowLabel={(row) => row.name}
                      selectedKeys={selected}
                      onSelectionChange={setSelected}
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

                  <Section title="Record and code">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <Card>
                        <CardHeader eyebrow="Visitor" title="Ana Ruiz" titleAs="h3" description="First seen 12 August 2026" />
                        <CardBody>
                          <DefinitionList
                            columns={2}
                            items={[
                              { label: 'Email', value: 'ana@northwind.com' },
                              { label: 'Company', value: 'Northwind' },
                              { label: 'Location', value: 'Lisbon, PT' },
                              { label: 'Device', value: 'macOS · Chrome' },
                            ]}
                          />
                        </CardBody>
                        <CardFooter>
                          <Button size="sm" variant="ghost">View conversation</Button>
                          <Button size="sm" variant="primary">Follow up</Button>
                        </CardFooter>
                      </Card>
                      <Card>
                        <CardHeader eyebrow="Install" title="Embed snippet" titleAs="h3" />
                        <CardBody className="space-y-3">
                          <CopyField label="bot key" value="bot-6a427d4529b9" secret />
                          <CodeBlock
                            caption="Paste before </body>"
                            code={'<script src="https://cdn.oyechats.com/oyechats-widget.js"\n        data-bot-key="bot-6a427d4529b9"></script>'}
                          />
                        </CardBody>
                      </Card>
                    </div>
                  </Section>
                </Stack>
              </TabPanel>

              <TabPanel value="overlays">
                <Stack>
                  <Section title="Overlays" description="All on Radix, so focus, scroll lock and dismissal are correct by construction.">
                    <Card>
                      <CardBody className="flex flex-wrap gap-2">
                        <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
                        <Button onClick={() => setDrawerOpen(true)}>Open drawer</Button>
                        <Button variant="danger" onClick={() => setConfirmOpen(true)}>Delete chatbot…</Button>
                        <MenuRoot>
                          <MenuTrigger asChild>
                            <Button variant="secondary">Row actions</Button>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuLabel>Chatbot</MenuLabel>
                            <MenuItem icon={<MessageSquare aria-hidden className="h-3.5 w-3.5" />}>Open</MenuItem>
                            <MenuItem icon={<Globe aria-hidden className="h-3.5 w-3.5" />} shortcut="⌘D">View demo</MenuItem>
                            <MenuSeparator />
                            <MenuItem destructive icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}>Delete…</MenuItem>
                          </MenuContent>
                        </MenuRoot>
                        <Button variant="ghost" onClick={() => toast.success('Knowledge base updated', { description: '12 pages re-indexed.' })}>
                          Toast
                        </Button>
                      </CardBody>
                    </Card>
                  </Section>

                  <Section title="Alerts" description="Anything the user must read to proceed stays on the page.">
                    <div className="space-y-3">
                      <Alert tone="neutral" title="Your chatbot is not live yet">
                        Install the widget on your website and we will confirm it here automatically.
                      </Alert>
                      <Alert tone="success">Training finished. 412 pages indexed.</Alert>
                      <Alert tone="warning" title="You are close to your credit limit" action={<Button size="sm" variant="secondary">Buy credits</Button>}>
                        At the current rate you will run out in about four days, and your chatbot stops answering.
                      </Alert>
                      <Alert tone="danger" title="Your last payment failed" action={<Button size="sm" variant="secondary">Update card</Button>}>
                        We will retry on 21 August. Until then your chatbot keeps answering.
                      </Alert>
                      <Alert tone="plan" title="Qualification is on Professional">
                        Score every conversation against BANT and route the hot ones to a human.
                      </Alert>
                    </div>
                  </Section>
                </Stack>
              </TabPanel>

              <TabPanel value="states">
                <Stack>
                  <Section title="The four states every surface owes its user">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <Card>
                        <CardHeader title="Loading" titleAs="h3" />
                        <CardBody><LoadingRows rows={4} /></CardBody>
                      </Card>
                      <Card>
                        <CardHeader title="Empty" titleAs="h3" />
                        <EmptyState
                          icon={Inbox}
                          title="No conversations yet"
                          description="Once your chatbot is live, everything a visitor asks lands here."
                          action={<Button size="sm" variant="primary">Install the widget</Button>}
                        />
                      </Card>
                      <Card>
                        <CardHeader title="Error" titleAs="h3" />
                        <ErrorState
                          description="We could not reach the analytics service."
                          onRetry={() => toast.info('Retrying…')}
                        />
                      </Card>
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
                    </div>
                  </Section>
                </Stack>
              </TabPanel>

              <TabPanel value="tokens">
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
                    </Card>
                  </Section>
                  <Section title="Type">
                    <Card>
                      <CardBody className="space-y-3">
                        <Eyebrow>Mono eyebrow · 11</Eyebrow>
                        <p className="text-2xl font-semibold">Headline figure · 28</p>
                        <p className="text-lg font-semibold">Section heading · 18</p>
                        <p className="text-base">Body and controls · 14</p>
                        <p className="text-sm text-text-secondary">Table cells and dense UI · 13</p>
                        <p className="text-xs text-text-tertiary">Meta and captions · 12</p>
                        <p className="figure text-base">1,204 · ₹9,800.50 · bot-6a42…29b9 · 1m 30s</p>
                      </CardBody>
                    </Card>
                  </Section>
                </Stack>
              </TabPanel>
            </Tabs>
          }
        />

        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="Invite a teammate"
          description="They will get an email with a link to join this workspace."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setDialogOpen(false)}>Send invite</Button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Email" required>
              <Input type="email" placeholder="teammate@acme.com" />
            </Field>
            <Field label="Role" hint="Operators can answer conversations but cannot change billing.">
              <Select
                options={[
                  { value: 'operator', label: 'Operator' },
                  { value: 'admin', label: 'Admin' },
                ]}
                defaultValue="operator"
              />
            </Field>
          </div>
        </Dialog>

        <Drawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
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
        />
      </Page>
    </TooltipProvider>
  );
}
