import { memo } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
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
function ceilingFor(service: Service): number {
  return service.requirements.reduce((total, requirement) => {
    if (requirement.type === 'choice') {
      const dearest = requirement.options.reduce(
        (max, option) => Math.max(max, option.price * option.quantity),
        0,
      );
      return total + dearest;
    }
    const quantity = requirement.quantity_mode === 'none' ? 1 : requirement.quantity;
    return total + requirement.price * quantity;
  }, 0);
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
  onChange,
  onRemove,
}: ServiceEditorProps) {
  const { t } = useTranslation();
  const requirements = service.requirements;

  const patchRequirement = (requirementIndex: number, patch: Partial<Requirement>) =>
    onChange({
      requirements: requirements.map((requirement, i) =>
        i === requirementIndex ? { ...requirement, ...patch } : requirement,
      ),
    });

  return (
    <Card>
      <CardHeader
        eyebrow={`Service ${index + 1}`}
        title={service.name.trim() || t('agents.untitledService') || 'Untitled service'}
        titleAs="h3"
        description={`${
          requirements.length === 1 ? '1 line' : `${formatNumber(requirements.length)} lines`
        } · up to ${money(currency, ceilingFor(service))}`}
        actions={
          <Button
            variant="danger"
            size="sm"
            disabled={disabled}
            onClick={onRemove}
            iconLeft={<Trash2 aria-hidden />}
          >
            {t('agents.remove') || 'Remove'}
          </Button>
        }
      />
      <CardBody className="space-y-4">
        <Field label={t('agents.name') || 'Name'} required hint={t('agents.whatTheVisitorPicksFrom') || 'What the visitor picks from.'}>
          <Input
            value={service.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder={t('agents.landingPageDesign') || 'Landing page design'}
            disabled={disabled}
          />
        </Field>

        <Field label={t('agents.description') || 'Description'} optional hint={t('agents.oneLineShownUnderThe') || 'One line, shown under the name while quoting.'}>
          <Input
            value={service.description}
            onChange={(event) => onChange({ description: event.target.value })}
            placeholder={t('agents.includesThreeConceptsAndTwo') || 'Includes three concepts and two revision rounds.'}
            disabled={disabled}
          />
        </Field>

        <section className="border-t border-border pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-base font-semibold text-text-primary">{t('agents.lines') || 'Lines'}</h4>
            <span className="figure text-xs text-text-tertiary">
              {formatNumber(requirements.length)} of {formatNumber(MAX_REQUIREMENTS_PER_SERVICE)}
            </span>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Every line the visitor can take, and what each one costs. A line item is ticked on or
            off; a priced choice asks them to pick one of several answers, each with its own price.
          </p>

          {requirements.length === 0 ? null : (
            <ul className="mt-3 space-y-3">
              {requirements.map((requirement, requirementIndex) => (
                <li key={requirement.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <Field label={`Line ${requirementIndex + 1}`} required className="min-w-0 flex-1">
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
                    <Field label={t('agents.type') || 'Type'}>
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
                    <Field label={t('agents.quantity') || 'Quantity'} hint={QUANTITY_MODES.find((mode) => mode.value === requirement.quantity_mode)?.help}>
                      <Select
                        label={t('agents.quantity') || 'Quantity'}
                        value={requirement.quantity_mode}
                        options={QUANTITY_MODES}
                        disabled={disabled}
                        onValueChange={(value) =>
                          patchRequirement(requirementIndex, { quantity_mode: value as QuantityMode })
                        }
                      />
                    </Field>
                  </Grid>

                  {requirement.quantity_mode === 'none' ? null : (
                    <Grid cols={2} className="mt-3">
                      <NumberField
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
                      <Field label={t('agents.unit') || 'Unit'} hint={t('agents.whatOneOfItIs') || 'What one of it is counted in.'}>
                        <Input
                          value={requirement.unit_label}
                          onChange={(event) =>
                            patchRequirement(requirementIndex, { unit_label: event.target.value })
                          }
                          placeholder={t('agents.hourPageSeat') || 'hour, page, seat'}
                          disabled={disabled}
                        />
                      </Field>
                    </Grid>
                  )}

                  {requirement.type === 'item' ? (
                    <Grid cols={2} className="mt-3">
                      <NumberField
                        label={t('agents.price') || 'Price'}
                        value={requirement.price}
                        step={0.01}
                        min={0}
                        disabled={disabled}
                        onChange={(raw) =>
                          patchRequirement(requirementIndex, { price: Math.max(0, Number(raw) || 0) })
                        }
                      />
                      <Field label={t('agents.addsToTheQuote') || 'Adds to the quote'} hint={t('agents.whatTheVisitorWouldSee') || 'What the visitor would see.'}>
                        {/* Not an `Input`: it is derived, and a disabled field
                            that looks editable invites the reader to try. */}
                        <p className="figure pt-1.5 text-base text-text-primary">
                          {money(
                            currency,
                            requirement.price *
                              (requirement.quantity_mode === 'none' ? 1 : requirement.quantity),
                          )}
                        </p>
                      </Field>
                    </Grid>
                  ) : (
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
                          <li key={option.id} className="flex items-end gap-2">
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
                              className="mb-1"
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
                </li>
              ))}
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
    </Card>
  );
}

export const ServiceEditor = memo(ServiceEditorInner);
