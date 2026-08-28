import { useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Columns,
  ErrorState,
  EmptyState,
  Eyebrow,
  Field,
  LockedState,
  Measure,
  Page,
  PageHeader,
  PropertyGrid,
  SaveBar,
  Select,
  Skeleton,
  Stack,
  Switch,
  Button,
  buttonClass,
} from '../../../ui';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { planIncludesQuotations } from '../../../lib/planGates';
import { getQuotationCatalog, putQuotationCatalog } from '../../../services/api';
import { useSettingsDraft } from '../advanced/useSettingsDraft';
import { ServiceEditor } from './ServiceEditor';
import {
  BANT_DIMENSIONS,
  CURRENCIES,
  MAX_SERVICES,
  type BantDimension,
  type QuotationCatalog,
  type Service,
  blockedReason,
  newServiceId,
  parseCatalog,
  thresholdCeiling,
  toPayload,
} from './quotation.model';

const TITLE = 'Quotation';

function QuotationSkeleton() {
  return (
    <Page>
      <PageHeader title={TITLE} />
      <Stack>
        {[0, 1, 2].map((index) => (
          <Card key={index}>
            <CardBody className="space-y-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-20 w-full" />
            </CardBody>
          </Card>
        ))}
      </Stack>
    </Page>
  );
}

function QuotationContent({ agentId }: { agentId: number }) {
  const load = useCallback(
    async (id: number): Promise<QuotationCatalog> => parseCatalog(await getQuotationCatalog(id)),
    [],
  );
  const save = useCallback(async (id: number, next: QuotationCatalog) => {
    await putQuotationCatalog(id, toPayload(next));
  }, []);

  const state = useSettingsDraft<QuotationCatalog>({ agentId, load, save });
  const { update } = state;
  const catalog = state.draft;

  const patchService = useCallback(
    (index: number, patch: Partial<Service>) =>
      update((previous) => ({
        ...previous,
        services: previous.services.map((service, i) => (i === index ? { ...service, ...patch } : service)),
      })),
    [update],
  );

  const blocked = useMemo(() => (catalog ? blockedReason(catalog) : null), [catalog]);

  if (state.loadError) {
    return (
      <Page>
        <PageHeader title={TITLE} />
        <ErrorState
          framed
          title="We could not load this chatbot's quotation catalog"
          description={state.loadError}
          onRetry={state.retry}
        />
      </Page>
    );
  }

  if (!catalog) return <QuotationSkeleton />;

  const ceiling = thresholdCeiling(catalog.required_categories);
  // The catalog stays readable with quoting switched off — the reader is about
  // to decide whether to turn it on, and an inert page tells them nothing about
  // what they would be turning on. Editing is what is blocked, not reading.
  const configDisabled = !catalog.enabled;

  return (
    <Page>
      <PageHeader
        title={TITLE}
        description={
          catalog.enabled
            ? undefined
            : 'Quoting is off. The chatbot will not offer to price anything, even when asked.'
        }
        actions={
          <>
            {catalog.enabled ? null : <Badge tone="neutral">Quoting off</Badge>}
            <span className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">{catalog.enabled ? 'On' : 'Off'}</span>
              <Switch
                checked={catalog.enabled}
                onCheckedChange={(next) => update((previous) => ({ ...previous, enabled: next }))}
                label="Let this chatbot build quotes"
              />
            </span>
          </>
        }
      />

      <Stack>
        <Columns
          asideWidth="sm"
          stickyAside
          asideLabel="When a quote is offered"
          main={
            <Stack>
              <Card>
                <CardHeader
                  title="Services"
                  titleAs="h2"
                  description="The line items this chatbot can price. Visitors pick from these."
                  actions={
                    <span className="figure text-xs text-text-tertiary">
                      {catalog.services.length} of {MAX_SERVICES}
                    </span>
                  }
                />
                <CardBody className="space-y-4">
                  {catalog.services.length === 0 ? (
                    <EmptyState
                      size="panel"
                      title="No services yet"
                      description="A quote is a list of priced things. Add the first one, and the chatbot can start building estimates from it."
                    />
                  ) : (
                    catalog.services.map((service, index) => (
                      <ServiceEditor
                        key={service.id}
                        service={service}
                        index={index}
                        currency={catalog.currency}
                        disabled={configDisabled || state.saving}
                        onChange={(patch) => patchService(index, patch)}
                        onRemove={() =>
                          update((previous) => ({
                            ...previous,
                            services: previous.services.filter((_, i) => i !== index),
                          }))
                        }
                      />
                    ))
                  )}

                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={configDisabled || state.saving || catalog.services.length >= MAX_SERVICES}
                    iconLeft={<Plus aria-hidden />}
                    onClick={() =>
                      update((previous) => ({
                        ...previous,
                        services: [
                          ...previous.services,
                          {
                            id: newServiceId(previous.services),
                            name: '',
                            description: '',
                            // No price here: it lives on the service's lines.
                            requirements: [],
                          },
                        ],
                      }))
                    }
                  >
                    Add service
                  </Button>
                </CardBody>
              </Card>
            </Stack>
          }
          aside={
            <Stack>
              <Card>
                <CardHeader title="Currency" titleAs="h2" />
                <CardBody>
                  <Field
                    label="Quote in"
                    disabled={configDisabled}
                    hint="Every service price is stored and quoted in this currency."
                  >
                    <Select
                      label="Currency"
                      value={catalog.currency}
                      options={CURRENCIES}
                      disabled={configDisabled}
                      onValueChange={(currency) => update((previous) => ({ ...previous, currency }))}
                    />
                  </Field>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="When to offer a quote"
                  titleAs="h2"
                  description="Quoting an unqualified visitor wastes the number. These are the signals that have to land first."
                />
                <CardBody className="space-y-4">
                  <fieldset>
                    <legend className="text-sm font-medium text-text-primary">Signals that count</legend>
                    <p className="mt-1 text-xs text-text-secondary">
                      Leave all four unticked to count any of them.
                    </p>
                    <div className="mt-2 space-y-2">
                      {BANT_DIMENSIONS.map((dimension) => (
                        <Checkbox
                          key={dimension.key}
                          checked={catalog.required_categories.includes(dimension.key)}
                          disabled={configDisabled}
                          label={dimension.label}
                          description={dimension.help}
                          onCheckedChange={(checked) =>
                            update((previous) => {
                              const next: BantDimension[] = checked === true
                                ? [...previous.required_categories, dimension.key]
                                : previous.required_categories.filter((key) => key !== dimension.key);
                              return {
                                ...previous,
                                required_categories: next,
                                // A threshold above the number of signals in
                                // play can never be met, so it follows them down.
                                threshold: Math.min(previous.threshold, thresholdCeiling(next)),
                              };
                            })
                          }
                        />
                      ))}
                    </div>
                  </fieldset>

                  <Field
                    label="How many must land"
                    disabled={configDisabled}
                    hint={
                      catalog.required_categories.length === 0
                        ? 'Counted across all four signals.'
                        : `Counted across ${catalog.required_categories
                            .map((key) => BANT_DIMENSIONS.find((d) => d.key === key)?.label ?? key)
                            .join(', ')}.`
                    }
                  >
                    <Select
                      label="How many signals must land"
                      value={String(catalog.threshold)}
                      disabled={configDisabled}
                      options={Array.from({ length: ceiling }, (_, index) => ({
                        value: String(index + 1),
                        label: `${index + 1} of ${ceiling}`,
                      }))}
                      onValueChange={(value) =>
                        update((previous) => ({
                          ...previous,
                          threshold: Math.max(
                            1,
                            Math.min(thresholdCeiling(previous.required_categories), Number(value) || 1),
                          ),
                        }))
                      }
                    />
                  </Field>
                </CardBody>
              </Card>
            </Stack>
          }
        />

        <SaveBar
          dirty={state.dirty}
          saving={state.saving}
          saved={state.saved}
          saveError={state.saveError}
          blockedReason={blocked}
          onSave={() => void state.commit()}
          onDiscard={state.discard}
          guard="this chatbot’s quotation catalog"
        />
      </Stack>
    </Page>
  );
}

/**
 * Quotation — what this chatbot offers to price, and who it offers it to.
 *
 * Its own tab rather than a section of Advanced because it is a revenue
 * surface: the same argument that promoted Qualification out of the
 * power-user drawer. A customer configuring prices is doing commercial work,
 * not tuning a knob.
 *
 * The plan gate goes through `planIncludesQuotations`, not a bare slug set, so
 * a bespoke enterprise contract sees the editor the server already lets it
 * write — the exact mismatch `planGates` was written to close.
 */
export function QuotationPage() {
  const { agent, loading, error, refresh } = useAgent();
  const { planSlug, planName, loading: entitlementsLoading } = useEntitlements();

  // The plan resolves after first paint and the fallback is restrictive, so a
  // paid workspace deep-linking here must not flash the locked card.
  if (entitlementsLoading || (loading && !agent)) return <QuotationSkeleton />;

  if (!agent) {
    return (
      <Page>
        <PageHeader title={TITLE} />
        <ErrorState
          framed
          title={error ? 'We could not load this chatbot' : 'Chatbot not found'}
          description={
            error
              ? error.message || 'Something went wrong while loading this workspace.'
              : 'This chatbot does not exist, or it belongs to a workspace you cannot see.'
          }
          onRetry={() => void refresh()}
        />
      </Page>
    );
  }

  if (!planIncludesQuotations(planSlug)) {
    return (
      <Page>
        <PageHeader title={TITLE} />
        <Measure width="reading">
          <LockedState
            title="Quotations are not included on your plan"
            description={`Your workspace is on ${planName || 'a plan'} without the quotation flow. On Professional and above, the chatbot prices a visitor's request in the conversation and hands you the itemised quote with the lead.`}
            action={
              <Link to="/billing" className={buttonClass('primary', 'sm')}>
                See plans
              </Link>
            }
            preview={
              <div className="px-cell pb-1 pt-5">
                <Eyebrow>What you would configure</Eyebrow>
                <PropertyGrid
                  className="mt-2"
                  items={[
                    { label: 'Services', value: 'What you sell, priced per unit' },
                    { label: 'Questions', value: 'What the chatbot asks to scope each one' },
                    { label: 'Trigger', value: 'How qualified a visitor must be before it quotes' },
                  ]}
                />
              </div>
            }
          />
        </Measure>
      </Page>
    );
  }

  return <QuotationContent key={agent.id} agentId={agent.id} />;
}
