import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardBody, CardHeader, CardSection, LockedState, buttonClass } from '../../../ui';
import { NumberField } from './NumberField';
import { OPERATOR_TIMEOUT, operatorTimeoutError } from './behaviour.config';

export interface OperatorResponseSectionProps {
  value: number;
  onChange: (next: number) => void;
  /** True when this chatbot's plan includes live chat. */
  liveChatAllowed: boolean;
}

/**
 * The operator response window — `Bot.operator_timeout_seconds`.
 *
 * Written on every handoff request and every department transfer
 * (api/app/api/operator_routes.py:777 and :1365) and passed to the connection
 * manager as the deadline an operator has to pick a chat up. It has been
 * writable through `PATCH /bots/{id}` the whole time and has never had a
 * control, so every workspace in the product runs on the 120-second default.
 *
 * It lives on Behaviour rather than Experience because it is a reliability
 * deadline rather than something a visitor sees, and because Experience already
 * owns the visitor-facing half of the queue — the wait message, the queue
 * timeout and the queue cap.
 */
function OperatorResponseSectionInner({
  value,
  onChange,
  liveChatAllowed,
}: OperatorResponseSectionProps) {
  if (!liveChatAllowed) {
    return (
      <LockedState
        title="Live chat is not included on this chatbot's plan"
        description="The operator response window decides how long a person has to pick up a chat before it is offered to someone else. It only applies once live chat is available."
        action={
          <Link to="/billing" className={buttonClass('primary', 'md')}>
            See plans
          </Link>
        }
      />
    );
  }

  return (
    <Card>
      <CardHeader
        title="Operator response window"
        titleAs="h2"
        description="How long an operator has to accept a chat that has been handed to them."
      />
      <CardBody>
        <NumberField
          className="max-w-xs"
          label="Time to accept"
          unitLabel="seconds"
          hint={`What happens after it expires is decided by your routing strategy. The default is ${OPERATOR_TIMEOUT.default} seconds.`}
          error={operatorTimeoutError(value)}
          value={value}
          min={OPERATOR_TIMEOUT.min}
          max={OPERATOR_TIMEOUT.max}
          step={5}
          onChange={(raw) => {
            const parsed = Math.round(Number(raw));
            onChange(Number.isFinite(parsed) ? parsed : value);
          }}
        />
      </CardBody>
      <CardSection className="bg-surface-sunken">
        <p className="text-xs leading-relaxed text-text-secondary">
          The visitor-facing side of the queue — how long they wait before the chatbot takes over
          again, how many people can queue at once, and what they are told while they wait — is on
          the Experience page, beside the rest of what a visitor sees.
        </p>
      </CardSection>
    </Card>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const OperatorResponseSection = memo(OperatorResponseSectionInner);
