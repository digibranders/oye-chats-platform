import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Badge, SettingRow, buttonClass } from '../../../ui';
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
 *
 * The locked case is the same row with a plan badge where the control goes. It
 * used to be a centred 96px `LockedState` hero dropped into a column of
 * left-aligned settings cards, which reads as an error rather than as "your plan
 * does not include this".
 */
function OperatorResponseSectionInner({
  value,
  onChange,
  liveChatAllowed,
}: OperatorResponseSectionProps) {
  if (!liveChatAllowed) {
    return (
      <SettingRow
        label="Time to accept"
        badge={<Badge tone="plan">Starter and above</Badge>}
        description="Live chat is not included on this chatbot’s plan."
        controlWidth="auto"
      >
        <Link to="/billing" className={buttonClass('secondary', 'sm')}>
          See plans
        </Link>
      </SettingRow>
    );
  }

  return (
    <SettingRow
      label="Time to accept"
      description={`Then it goes back to the queue. Default ${OPERATOR_TIMEOUT.default}.`}
      stacked
    >
      <NumberField
        // The visible row label is "Time to accept"; the control's own name adds
        // the unit, so the two agree (SC 2.5.3) without printing it twice.
        hideLabel
        label="Time to accept"
        unitLabel="seconds"
        error={operatorTimeoutError(value)}
        value={value}
        min={OPERATOR_TIMEOUT.min}
        max={OPERATOR_TIMEOUT.max}
        step={5}
        className="w-40"
        onChange={(raw) => {
          const parsed = Math.round(Number(raw));
          onChange(Number.isFinite(parsed) ? parsed : value);
        }}
      />
    </SettingRow>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const OperatorResponseSection = memo(OperatorResponseSectionInner);
