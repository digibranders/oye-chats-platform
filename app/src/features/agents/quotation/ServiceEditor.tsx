import { memo } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Grid,
  Input,
  Select,
  formatMoney,
  formatNumber,
} from '../../../ui';
import { NumberField } from '../advanced/NumberField';
import {
  MAX_OPTIONS,
  MAX_QUESTIONS_PER_SERVICE,
  QUESTION_TYPES,
  type QuestionType,
  type Service,
  type ServiceQuestion,
  newQuestionId,
} from './quotation.model';

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
 * One priced service, with the questions the chatbot asks to scope it.
 *
 * The questions are the part that earns the surface: a price alone is a
 * brochure, whereas "how many pages?" is the answer that makes the quote a
 * number the operator can pick the phone up about. They are edited inline
 * rather than behind a second dialog — a dialog inside an expanded row inside a
 * list is three levels of nesting for a text field and a type.
 *
 * Memoised because a catalog at its ceiling is twenty of these, each holding up
 * to eight questions with up to eight options: a keystroke in one price field
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
  const unit = service.unit_label.trim() || 'unit';
  const subtotal = service.price_per_unit * service.default_quantity;

  const patchQuestion = (questionIndex: number, patch: Partial<ServiceQuestion>) =>
    onChange({
      questions: service.questions.map((question, i) =>
        i === questionIndex ? { ...question, ...patch } : question,
      ),
    });

  return (
    <Card>
      <CardHeader
        eyebrow={`Service ${index + 1}`}
        title={service.name.trim() || 'Untitled service'}
        titleAs="h3"
        description={`${money(currency, service.price_per_unit)} per ${unit} · ${
          service.questions.length === 1 ? '1 question' : `${service.questions.length} questions`
        }`}
        actions={
          <Button
            variant="danger"
            size="sm"
            disabled={disabled}
            onClick={onRemove}
            iconLeft={<Trash2 aria-hidden />}
          >
            Remove
          </Button>
        }
      />
      <CardBody className="space-y-4">
        <Grid cols={2}>
          <Field label="Name" required hint="What the visitor picks from.">
            <Input
              value={service.name}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder="Landing page design"
              disabled={disabled}
            />
          </Field>
          <Field label="Unit" hint="What one of it is billed against.">
            <Input
              value={service.unit_label}
              onChange={(event) => onChange({ unit_label: event.target.value })}
              placeholder="page, hour, seat"
              disabled={disabled}
            />
          </Field>
        </Grid>

        <Field label="Description" optional hint="One line, shown under the name while quoting.">
          <Input
            value={service.description}
            onChange={(event) => onChange({ description: event.target.value })}
            placeholder="Includes three concepts and two revision rounds."
            disabled={disabled}
          />
        </Field>

        <Grid cols={3}>
          <NumberField
            label={`Price per ${unit}`}
            value={service.price_per_unit}
            step={0.01}
            min={0}
            disabled={disabled}
            onChange={(raw) => onChange({ price_per_unit: Math.max(0, Number(raw) || 0) })}
          />
          <NumberField
            label="Default quantity"
            hint="Pre-filled when the chatbot asks."
            value={service.default_quantity}
            step={1}
            min={0}
            disabled={disabled}
            onChange={(raw) => onChange({ default_quantity: Math.max(0, Math.floor(Number(raw) || 0)) })}
          />
          <Field label="Subtotal at that quantity" hint="What the visitor would see.">
            {/* Not an `Input`: it is derived, and a disabled field that looks
                editable invites the reader to try. */}
            <p className="figure pt-1.5 text-base text-text-primary">{money(currency, subtotal)}</p>
          </Field>
        </Grid>

        <section className="border-t border-border pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-base font-semibold text-text-primary">Questions</h4>
            <span className="figure text-xs text-text-tertiary">
              {formatNumber(service.questions.length)} of {formatNumber(MAX_QUESTIONS_PER_SERVICE)}
            </span>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Asked before the quote is locked in. Answers are saved on the lead, so whoever calls has
            the visitor&rsquo;s own words in front of them.
          </p>

          {service.questions.length === 0 ? null : (
            <ul className="mt-3 space-y-3">
              {service.questions.map((question, questionIndex) => (
                <li key={question.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <Field label={`Question ${questionIndex + 1}`} required className="min-w-0 flex-1">
                      <Input
                        value={question.text}
                        onChange={(event) => patchQuestion(questionIndex, { text: event.target.value })}
                        placeholder="How many pages do you need?"
                        disabled={disabled}
                      />
                    </Field>
                    <Button
                      variant="danger"
                      size="sm"
                      className="mt-6"
                      disabled={disabled}
                      aria-label={`Remove question ${questionIndex + 1}`}
                      onClick={() =>
                        onChange({ questions: service.questions.filter((_, i) => i !== questionIndex) })
                      }
                      iconLeft={<Trash2 aria-hidden />}
                    />
                  </div>

                  <Grid cols={2} className="mt-3">
                    <Field label="Answer type">
                      <Select
                        label="Answer type"
                        value={question.type}
                        options={QUESTION_TYPES}
                        disabled={disabled}
                        onValueChange={(value) => {
                          const type = value as QuestionType;
                          patchQuestion(questionIndex, {
                            type,
                            // A choice with no options can never be answered, so
                            // switching to it seeds the first blank row.
                            options: type === 'choice' && question.options.length === 0 ? [''] : question.options,
                          });
                        }}
                      />
                    </Field>
                    <Field label="Requirement" hint="Untick for genuinely optional context.">
                      <Checkbox
                        checked={question.required}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          patchQuestion(questionIndex, { required: checked === true })
                        }
                        label="They must answer this"
                      />
                    </Field>
                  </Grid>

                  {question.type === 'choice' ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <p className="text-sm font-medium text-text-primary">Options</p>
                      <ul className="mt-2 space-y-2">
                        {question.options.map((option, optionIndex) => (
                          <li key={optionIndex} className="flex items-center gap-2">
                            <Input
                              value={option}
                              aria-label={`Option ${optionIndex + 1}`}
                              placeholder={`Option ${optionIndex + 1}`}
                              disabled={disabled}
                              onChange={(event) =>
                                patchQuestion(questionIndex, {
                                  options: question.options.map((existing, i) =>
                                    i === optionIndex ? event.target.value : existing,
                                  ),
                                })
                              }
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={disabled}
                              aria-label={`Remove option ${optionIndex + 1}`}
                              onClick={() =>
                                patchQuestion(questionIndex, {
                                  options: question.options.filter((_, i) => i !== optionIndex),
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
                        disabled={disabled || question.options.length >= MAX_OPTIONS}
                        onClick={() =>
                          patchQuestion(questionIndex, { options: [...question.options, ''] })
                        }
                        iconLeft={<Plus aria-hidden />}
                      >
                        Add option
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={disabled || service.questions.length >= MAX_QUESTIONS_PER_SERVICE}
            onClick={() =>
              onChange({
                questions: [
                  ...service.questions,
                  {
                    id: newQuestionId(service.questions),
                    text: '',
                    type: 'text',
                    options: [],
                    required: true,
                  },
                ],
              })
            }
            iconLeft={<Plus aria-hidden />}
          >
            Add question
          </Button>
        </section>
      </CardBody>
    </Card>
  );
}

export const ServiceEditor = memo(ServiceEditorInner);
