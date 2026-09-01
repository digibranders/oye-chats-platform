import { memo, useState } from 'react';
import { ChevronDown, Plus, Trash2, X } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Grid,
  Input,
  Select,
  formatMoney,
  formatNumber,
} from '../../../ui';
import { NumberField } from '../advanced/NumberField';
import {
  MAX_OPTIONS_PER_REQUIREMENT,
  MAX_REQUIREMENTS_PER_SERVICE,
  QUANTITY_MODES,
  REQUIREMENT_TYPES,
  type QuantityMode,
  type Requirement,
  type RequirementType,
  type Service,
  newOptionId,
  newRequirementId,
} from './quotation.model';
import { useTranslation } from '../../../i18n/useTranslation';

export interface ServiceEditorProps {
  service: Service;
  index: number;
  currency: string;
  disabled?: boolean;
  /** Controlled collapse, so a catalog-level "Collapse all" can drive every row. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  onChange: (patch: Partial<Service>) => void;
  onRemove: () => void;
}

/** Catalog prices are whole currency; `formatMoney` takes minor units. */
function money(currency: string, majorUnits: number): string {
  return formatMoney(Math.round(majorUnits * 100), currency, {
    showDecimals: !Number.isInteger(majorUnits),
  });
}

/**
 * What this service adds to a quote if the visitor takes every line.
 *
 * A `choice` contributes its dearest option, because that is the ceiling, and a
 * ceiling is the only figure that is true for every visitor. Quoting a floor
 * next to a service the visitor will price higher reads as a bait.
 */
function lineCeiling(requirement: Requirement): number {
  if (requirement.type === 'choice') {
    return requirement.options.reduce(
      (max, option) => Math.max(max, option.price * option.quantity),
      0,
    );
  }
  const quantity = requirement.quantity_mode === 'none' ? 1 : requirement.quantity;
  return requirement.price * quantity;
}

function ceilingFor(service: Service): number {
  // Sums the same per-line figure a collapsed line shows, so a line's summary
  // and the service total can never disagree about what that line costs.
  return service.requirements.reduce((total, requirement) => total + lineCeiling(requirement), 0);
}

/**
 * One service and the priced lines that make it up.
 *
 * Pricing lives on the LINES, not the service: a service is a named grouping,
 * and "Photography" is not a price, whereas "Second shooter" and "Drone" are.
 * That is the server's model (`Requirement` in `quotation_routes.py`) and
 * matching it here is what stops the editor writing a catalog the API silently
 * discards.
 *
 * Lines are edited inline rather than behind a second dialog: a dialog inside
 * an expanded row inside a list is three levels of nesting for a label and a
 * number.
 *
 * Memoised because a catalog at its ceiling is twenty of these, each holding up
 * to twenty lines with up to twelve options: a keystroke in one price field
 * should re-render one service, not the whole catalog.
 */
function ServiceEditorInner({
  service,
  index,
  currency,
  disabled = false,
  collapsed,
  onToggleCollapse,
  onChange,
  onRemove,
}: ServiceEditorProps) {
  const { t } = useTranslation();
  const requirements = service.requirements;
  // Collapsed hides only this service's body; the header keeps its name and the
  // "N lines · up to X" summary, so a long catalog stays scannable. State lives
  // in the parent so a catalog-level "Collapse all" can drive every row at once.

  const patchRequirement = (requirementIndex: number, patch: Partial<Requirement>) =>
    onChange({
      requirements: requirements.map((requirement, i) =>
        i === requirementIndex ? { ...requirement, ...patch } : requirement,
      ),
    });

  /**
   * Which LINES are collapsed, by id.
   *
   * A line's editor is a question, a type, a price, a quantity mode and up to
   * twelve priced options — some thirty rows each, and twenty lines are allowed
   * per requirement. Expanded by default that is a wall you scroll past rather
   * than read, which is the same reason the requirement above it collapses.
   *
   * Local, not lifted to the catalog: "collapse all" here means this
   * requirement's lines. A catalog-level control reaching inside every
   * requirement would fold up work the reader is in the middle of.
   */
  const [collapsedLineIds, setCollapsedLineIds] = useState<ReadonlySet<string>>(
    // Existing lines start collapsed, so opening a saved requirement gives you
    // something scannable. A line added below opens expanded — you added it to
    // fill it in.
    () => new Set(service.requirements.map((requirement) => requirement.id)),
  );
  const toggleLine = (id: string) =>
    setCollapsedLineIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allLinesCollapsed =
    requirements.length > 0 && requirements.every((r) => collapsedLineIds.has(r.id));

  return (
    <Card>
      <CardHeader
        eyebrow={`Requirement ${index + 1}`}
        title={service.name.trim() || t('agents.untitledService') || 'Untitled requirement'}
        titleAs="h3"
        description={`${
          requirements.length === 1 ? '1 line' : `${formatNumber(requirements.length)} lines`
        } · up to ${money(currency, ceilingFor(service))}`}
        actions={
          <>
            <Button
              variant="danger"
              size="sm"
              disabled={disabled}
              onClick={onRemove}
              iconLeft={<Trash2 aria-hidden />}
            >
              {t('agents.remove') || 'Remove'}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-expanded={!collapsed}
              aria-label={collapsed ? t('agents.expand') || 'Expand' : t('agents.collapse') || 'Collapse'}
              onClick={onToggleCollapse}
            >
              <ChevronDown
                aria-hidden
                className={`transition-transform ${collapsed ? '' : 'rotate-180'}`}
              />
            </Button>
          </>
        }
      />
      {!collapsed && (
      <CardBody className="space-y-4">
        {/* Paired, not stacked. Both hold one short line, and full-width each
            spent a whole row per requirement on two values that fit side by
            side — with the hint under Name repeating what the card already
            says. The placeholders carry the example; the hints carry only what
            is NOT inferable, which for Description is where it shows up. */}
        <Grid cols={2}>
          <Field label={t('agents.name') || 'Name'} required>
            <Input
              value={service.name}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder={t('agents.landingPageDesign') || 'Landing page design'}
              disabled={disabled}
            />
          </Field>

          <Field
            label={t('agents.description') || 'Description'}
            optional
            hint={t('agents.shownWhileQuoting') || 'Shown under the name while quoting.'}
          >
            <Input
              value={service.description}
              onChange={(event) => onChange({ description: event.target.value })}
              placeholder={t('agents.includesThreeConceptsAndTwo') || 'Includes three concepts and two revision rounds.'}
              disabled={disabled}
            />
          </Field>
        </Grid>

        <section className="border-t border-border pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-base font-semibold text-text-primary">{t('agents.lines') || 'Lines'}</h4>
            <div className="flex items-center gap-3">
              {requirements.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    setCollapsedLineIds(
                      allLinesCollapsed ? new Set() : new Set(requirements.map((r) => r.id)),
                    )
                  }
                >
                  {allLinesCollapsed
                    ? t('agents.expandAll') || 'Expand all'
                    : t('agents.collapseAll') || 'Collapse all'}
                </Button>
              ) : null}
              <span className="figure text-xs text-text-tertiary">
                {formatNumber(requirements.length)} of {formatNumber(MAX_REQUIREMENTS_PER_SERVICE)}
              </span>
            </div>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Every line the visitor can take, and what each one costs.
          </p>

          {requirements.length === 0 ? null : (
            <ul className="mt-2 divide-y divide-border border-t border-border">
              {requirements.map((requirement, requirementIndex) => {
                const lineCollapsed = collapsedLineIds.has(requirement.id);
                // A ROW, not a box. A rounded border per line made each look
                // like an independent object of the same RANK as the
                // requirement containing it, which is a lie about hierarchy:
                // a line belongs to its requirement. A hairline and padding
                // read as a list, which is what this is.
                return (
                <li key={requirement.id} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    {/* The name stays editable while collapsed: it is how you
                        tell one line from another, so folding it away would
                        make the collapsed list unreadable — the very thing
                        collapsing is for. The ceiling joins it as a hint, so a
                        closed line still answers "what does this cost?". */}
                    <Field
                      label={`Line ${requirementIndex + 1}`}
                      required
                      className="min-w-0 flex-1"
                      hint={
                        lineCollapsed ? `Up to ${money(currency, lineCeiling(requirement))}` : undefined
                      }
                    >
                      <Input
                        value={requirement.label}
                        onChange={(event) =>
                          patchRequirement(requirementIndex, { label: event.target.value })
                        }
                        placeholder={t('agents.secondShooter') || 'Second shooter'}
                        disabled={disabled}
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="mt-6"
                      aria-expanded={!lineCollapsed}
                      aria-label={
                        lineCollapsed
                          ? `${t('agents.expand') || 'Expand'} line ${requirementIndex + 1}`
                          : `${t('agents.collapse') || 'Collapse'} line ${requirementIndex + 1}`
                      }
                      onClick={() => toggleLine(requirement.id)}
                    >
                      <ChevronDown
                        aria-hidden
                        className={`transition-transform ${lineCollapsed ? '' : 'rotate-180'}`}
                      />
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      className="mt-6"
                      disabled={disabled}
                      aria-label={`Remove line ${requirementIndex + 1}`}
                      onClick={() =>
                        onChange({
                          requirements: requirements.filter((_, i) => i !== requirementIndex),
                        })
                      }
                      iconLeft={<Trash2 aria-hidden />}
                    />
                  </div>

                  {!lineCollapsed && (
                  <>

                  <Field
                    label={t('agents.question') || 'Question'}
                    optional
                    hint={t('agents.whatTheChatbotAsksFalls') || 'What the chatbot asks. Falls back to the label when blank.'}
                    className="mt-3"
                  >
                    <Input
                      value={requirement.question}
                      onChange={(event) =>
                        patchRequirement(requirementIndex, { question: event.target.value })
                      }
                      placeholder={t('agents.doYouWantASecond') || 'Do you want a second shooter?'}
                      disabled={disabled}
                    />
                  </Field>

                  <Grid cols={2} className="mt-3">
                    {/* The item-vs-choice distinction used to sit in the Lines
                        intro, two lines of prose above every requirement,
                        explaining a decision made here. It reads once, where
                        the decision is. */}
                    <Field
                      label={t('agents.type') || 'Type'}
                      hint={
                        requirement.type === 'choice'
                          ? t('agents.visitorPicksOneOption') || 'The visitor picks one option, each with its own price.'
                          : t('agents.visitorTicksItOnOrOff') || 'The visitor ticks it on or off.'
                      }
                    >
                      <Select
                        label={t('agents.type') || 'Type'}
                        value={requirement.type}
                        options={REQUIREMENT_TYPES}
                        disabled={disabled}
                        onValueChange={(value) => {
                          const type = value as RequirementType;
                          patchRequirement(requirementIndex, {
                            type,
                            // The API rejects a choice with no options, so
                            // switching to it seeds the first blank row rather
                            // than letting the reader save into a 422.
                            options:
                              type === 'choice' && requirement.options.length === 0
                                ? [{ id: newOptionId([]), label: '', price: 0, quantity: 1 }]
                                : requirement.options,
                          });
                        }}
                      />
                    </Field>
                    {/* "How the quantity is set", not "Quantity".
                        This selector and the number field beside it were both
                        labelled "Quantity", adjacent, in the same editor: one
                        decides HOW the quantity is arrived at, the other IS the
                        quantity. Two controls under one name is a naming
                        collision, and the reader has to click one to find out
                        which is which. */}
                    <Field
                      label={t('agents.howTheQuantityIsSet') || 'How the quantity is set'}
                      hint={QUANTITY_MODES.find((mode) => mode.value === requirement.quantity_mode)?.help}
                    >
                      <Select
                        label={t('agents.howTheQuantityIsSet') || 'How the quantity is set'}
                        value={requirement.quantity_mode}
                        options={QUANTITY_MODES}
                        disabled={disabled}
                        onValueChange={(value) =>
                          patchRequirement(requirementIndex, { quantity_mode: value as QuantityMode })
                        }
                      />
                    </Field>
                  </Grid>

                  {/* Price, quantity and unit are ONE row.
                      They were three cells across two grids: quantity and unit
                      on a row of their own, then Price alone on the next beside
                      a derived figure sitting on a different baseline. They
                      answer the same question, what this line costs, so they
                      read as one row; the ramp folds them to a single column
                      when the card is narrow. Each cell keeps its own
                      condition. */}
                  {requirement.type === 'item' || requirement.quantity_mode !== 'none' ? (
                    <Grid cols={2} className="mt-3">
                      {requirement.type !== 'item' ? null : (
                        <NumberField
                          label={t('agents.price') || 'Price'}
                          value={requirement.price}
                          step={0.01}
                          min={0}
                          disabled={disabled}
                          // The running total, as this field's own hint. It was
                          // a second grid cell carrying a label of its own,
                          // which is what left Price stranded on a half-row. It
                          // is DERIVED from the number directly above it, so it
                          // belongs under it.
                          hint={`${t('agents.addsToTheQuote') || 'Adds to the quote'} ${money(
                            currency,
                            requirement.price *
                              (requirement.quantity_mode === 'none' ? 1 : requirement.quantity),
                          )}`}
                          onChange={(raw) =>
                            patchRequirement(requirementIndex, { price: Math.max(0, Number(raw) || 0) })
                          }
                        />
                      )}
                      {requirement.quantity_mode === 'none' ? null : (
                        <div className="flex items-start gap-3">
                          <NumberField
                            className="w-28 shrink-0"
                            label={requirement.quantity_mode === 'ask' ? t('agents.defaultQuantity') || 'Default quantity' : t('agents.quantity') || 'Quantity'}
                            value={requirement.quantity}
                            step={1}
                            min={1}
                            disabled={disabled}
                            onChange={(raw) =>
                              patchRequirement(requirementIndex, {
                                quantity: Math.max(1, Math.floor(Number(raw) || 1)),
                              })
                            }
                          />
                          <Field label={t('agents.unit') || 'Unit'} className="min-w-0 flex-1">
                            <Input
                              value={requirement.unit_label}
                              onChange={(event) =>
                                patchRequirement(requirementIndex, { unit_label: event.target.value })
                              }
                              placeholder={t('agents.hourPageSeat') || 'hour, page, seat'}
                              disabled={disabled}
                            />
                          </Field>
                        </div>
                      )}
                    </Grid>
                  ) : null}

                  {requirement.type === 'item' ? null : (
                    <div className="mt-3 border-t border-border pt-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-sm font-medium text-text-primary">{t('agents.options') || 'Options'}</p>
                        <span className="figure text-xs text-text-tertiary">
                          {formatNumber(requirement.options.length)} of{' '}
                          {formatNumber(MAX_OPTIONS_PER_REQUIREMENT)}
                        </span>
                      </div>
                      <ul className="mt-2 space-y-2">
                        {requirement.options.map((option, optionIndex) => (
                          <li key={option.id} className="flex items-start gap-2">
                            <Field
                              label={`Option ${optionIndex + 1}`}
                              required
                              className="min-w-0 flex-1"
                            >
                              <Input
                                value={option.label}
                                placeholder={t('agents.nextJs') || 'Next.js'}
                                disabled={disabled}
                                onChange={(event) =>
                                  patchRequirement(requirementIndex, {
                                    options: requirement.options.map((existing, i) =>
                                      i === optionIndex
                                        ? { ...existing, label: event.target.value }
                                        : existing,
                                    ),
                                  })
                                }
                              />
                            </Field>
                            <NumberField
                              label={t('agents.price') || 'Price'}
                              value={option.price}
                              step={0.01}
                              min={0}
                              disabled={disabled}
                              onChange={(raw) =>
                                patchRequirement(requirementIndex, {
                                  options: requirement.options.map((existing, i) =>
                                    i === optionIndex
                                      ? { ...existing, price: Math.max(0, Number(raw) || 0) }
                                      : existing,
                                  ),
                                })
                              }
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="mt-6"
                              disabled={disabled}
                              aria-label={`Remove option ${optionIndex + 1}`}
                              onClick={() =>
                                patchRequirement(requirementIndex, {
                                  options: requirement.options.filter((_, i) => i !== optionIndex),
                                })
                              }
                              iconLeft={<X aria-hidden />}
                            />
                          </li>
                        ))}
                      </ul>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2"
                        disabled={disabled || requirement.options.length >= MAX_OPTIONS_PER_REQUIREMENT}
                        onClick={() =>
                          patchRequirement(requirementIndex, {
                            options: [
                              ...requirement.options,
                              {
                                id: newOptionId(requirement.options),
                                label: '',
                                price: 0,
                                quantity: 1,
                              },
                            ],
                          })
                        }
                        iconLeft={<Plus aria-hidden />}
                      >
                        {t('agents.addOption') || 'Add option'}
                      </Button>
                    </div>
                  )}
                  </>
                  )}
                </li>
                  );
                })}
            </ul>
          )}

          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={disabled || requirements.length >= MAX_REQUIREMENTS_PER_SERVICE}
            onClick={() =>
              onChange({
                requirements: [
                  ...requirements,
                  {
                    id: newRequirementId(requirements),
                    label: '',
                    question: '',
                    type: 'item',
                    price: 0,
                    quantity_mode: 'fixed',
                    unit_label: 'unit',
                    quantity: 1,
                    options: [],
                  },
                ],
              })
            }
            iconLeft={<Plus aria-hidden />}
          >
            {t('agents.addLine') || 'Add line'}
          </Button>
        </section>
      </CardBody>
      )}
    </Card>
  );
}

export const ServiceEditor = memo(ServiceEditorInner);
