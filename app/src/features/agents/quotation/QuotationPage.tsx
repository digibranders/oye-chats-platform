import { useCallback, useMemo, useState } from 'react';
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
import { useTranslation } from '../../../i18n/useTranslation';

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
  const { t } = useTranslation();
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

  // Which services are collapsed, by id — lifted here (not in each ServiceEditor)
  // so the catalog-level "Collapse all / Expand all" can drive every row. A
  // stale id from a removed service is harmless: it matches no row.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const blocked = useMemo(() => (catalog ? blockedReason(catalog) : null), [catalog]);

  if (state.loadError) {
    return (
      <Page>
        <PageHeader title={TITLE} />
        <ErrorState
          framed
          title={t('agents.weCouldNotLoadThis5') || 'We could not load this chatbot\'s quotation catalog'}
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
  const allCollapsed =
    catalog.services.length > 0 && catalog.services.every((service) => collapsedIds.has(service.id));
  const setAllCollapsed = (collapsed: boolean) =>
    setCollapsedIds(collapsed ? new Set(catalog.services.map((service) => service.id)) : new Set());

  return (
    <Page>
      <PageHeader
        title={TITLE}
        description={
          catalog.enabled
            ? undefined
            : t('agents.quotingIsOffTheChatbot') || 'Quoting is off. The chatbot will not offer to price anything, even when asked.'
        }
        actions={
          <>
            {catalog.enabled ? null : <Badge tone="neutral">Quoting off</Badge>}
            <span className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">{catalog.enabled ? 'On' : t('agents.off') || 'Off'}</span>
              <Switch
                checked={catalog.enabled}
                onCheckedChange={(next) => update((previous) => ({ ...previous, enabled: next }))}
                label={t('agents.letThisChatbotBuildQuotes') || 'Let this chatbot build quotes'}
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
              {/* A SECTION, not a Card.
                  It wrapped a heading and a list of cards: a border drawn
                  around borders, saying "this is a group" where the heading
                  already said it. Three concentric rounded boxes (catalog then
                  requirement then line) repeats containment at every level
                  instead of expressing hierarchy once. The requirement card is
                  the only one that earns a border, because it is the discrete
                  thing you can collapse and remove. */}
              <section aria-labelledby="requirements-heading">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <h2 id="requirements-heading" className="text-lg font-semibold text-text-primary">
                      {t('agents.services') || 'Requirements'}
                    </h2>
                    <p className="mt-0.5 text-sm text-text-secondary">
                      {t('agents.theLineItemsThisChatbot') || 'The line items this chatbot can price. Visitors pick from these.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {catalog.services.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAllCollapsed(!allCollapsed)}
                      >
                        {allCollapsed
                          ? t('agents.expandAll') || 'Expand all'
                          : t('agents.collapseAll') || 'Collapse all'}
                      </Button>
                    ) : null}
                    <span className="figure text-xs text-text-tertiary">
                      {catalog.services.length} of {MAX_SERVICES}
                    </span>
                  </div>
                </div>
                <div className="mt-4 space-y-4">
                  {catalog.services.length === 0 ? (
                    <EmptyState
                      size="panel"
                      title={t('agents.noServicesYet') || 'No requirements yet'}
                      description={t('agents.aQuoteIsAList') || 'A quote is a list of priced things. Add the first one, and the chatbot can start building estimates from it.'}
                    />
                  ) : (
                    catalog.services.map((service, index) => (
                      <ServiceEditor
                        key={service.id}
                        service={service}
                        index={index}
                        currency={catalog.currency}
                        disabled={configDisabled || state.saving}
                        collapsed={collapsedIds.has(service.id)}
                        onToggleCollapse={() => toggleCollapse(service.id)}
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
                    {t('agents.addService') || 'Add requirement'}
                  </Button>
                </div>
              </section>
            </Stack>
          }
          aside={
            <Stack>
              <Card>
                <CardHeader title={t('agents.currency') || 'Currency'} titleAs="h2" />
                <CardBody>
                  <Field
                    label={t('agents.quoteIn') || 'Quote in'}
                    disabled={configDisabled}
                    hint={t('agents.everyServicePriceIsStored') || 'Every requirement price is stored and quoted in this currency.'}
                  >
                    <Select
                      label={t('agents.currency') || 'Currency'}
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
                  title={t('agents.whenToOfferAQuote') || 'When to offer a quote'}
                  titleAs="h2"
                  description={t('agents.quotingAnUnqualifiedVisitorWastes') || 'Quoting an unqualified visitor wastes the number. These are the signals that have to land first.'}
                />
                <CardBody className="space-y-4">
                  <fieldset>
                    <legend className="text-sm font-medium text-text-primary">{t('agents.signalsThatCount') || 'Signals that count'}</legend>
                    <p className="mt-1 text-xs text-text-secondary">
                      {t('agents.leaveAllFourUntickedTo') || 'Leave all four unticked to count any of them.'}
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
                    label={t('agents.howManyMustLand') || 'How many must land'}
                    disabled={configDisabled}
                    hint={
                      catalog.required_categories.length === 0
                        ? t('agents.countedAcrossAllFourSignals') || 'Counted across all four signals.'
                        : `Counted across ${catalog.required_categories
                            .map((key) => BANT_DIMENSIONS.find((d) => d.key === key)?.label ?? key)
                            .join(', ')}.`
                    }
                  >
                    <Select
                      label={t('agents.howManySignalsMustLand') || 'How many signals must land'}
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
  const { t } = useTranslation();
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
          title={error ? t('agents.weCouldNotLoadThis') || 'We could not load this chatbot' : t('agents.chatbotNotFound') || 'Chatbot not found'}
          description={
            error
              ? error.message || t('agents.somethingWentWrongWhileLoading') || 'Something went wrong while loading this workspace.'
              : t('agents.thisChatbotDoesNotExist3') || 'This chatbot does not exist, or it belongs to a workspace you cannot see.'
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
            title={t('agents.quotationsAreNotIncludedOn') || 'Quotations are not included on your plan'}
            description={`Your workspace is on ${planName || 'a plan'} without the quotation flow. On Professional and above, the chatbot prices a visitor's request in the conversation and hands you the itemised quote with the lead.`}
            action={
              <Link to="/billing" className={buttonClass('primary', 'sm')}>
                {t('agents.seePlans') || 'See plans'}
              </Link>
            }
            preview={
              <div className="px-cell pb-1 pt-5">
                <Eyebrow>{t('agents.whatYouWouldConfigure') || 'What you would configure'}</Eyebrow>
                <PropertyGrid
                  className="mt-2"
                  items={[
                    { label: t('agents.services') || 'Requirements', value: t('agents.whatYouSellPricedPer') || 'What you sell, priced per unit' },
                    { label: t('agents.questions') || 'Questions', value: t('agents.whatTheChatbotAsksTo') || 'What the chatbot asks to scope each one' },
                    { label: t('agents.trigger') || 'Trigger', value: t('agents.howQualifiedAVisitorMust') || 'How qualified a visitor must be before it quotes' },
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
