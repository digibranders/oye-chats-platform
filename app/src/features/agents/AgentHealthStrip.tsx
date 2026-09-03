// `severityWord` belongs beside the health it describes, in
// `features/home/agentHealth.ts`; that file is outside this pass's scope, so it
// lives with its only two consumers instead. That is the one reason fast
// refresh's single-export rule is off here.
/* eslint-disable react-refresh/only-export-components */
import { type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Badge, Card, CardBody, buttonClass } from '../../ui';
import { agentPath } from '../../shell/nav';
import type { AgentHealth } from '../home/agentHealth';
import type { Bot } from '../../types/domain';
import { t as translateNow } from '../../i18n/i18n';

/**
 * The severity word beside the specific state, so colour is never the signal.
 *
 * It existed twice: as a `Record` on Overview and as a three-deep ternary on
 * Knowledge, which is how the same chatbot could be described two ways on two
 * pages of the same console. One map, one importer.
 */
/** The severity word in the reader's language. */
function severityLabel(tone: AgentHealth['tone']): string {
  return translateNow(`agents.healthSeverity.${tone}`) || SEVERITY[tone];
}

// @i18n-exempt: fallbacks, read through severityLabel above.
const SEVERITY: Record<AgentHealth['tone'], string> = {
  success: 'Healthy',
  warning: 'Needs you',
  danger: 'Not working',
  neutral: 'In progress',
};

export function severityWord(tone: AgentHealth['tone']): string {
  return severityLabel(tone);
}

export interface AgentHealthStripProps {
  agent: Bot;
  health: AgentHealth;
  /**
   * A figure that belongs beside the verdict rather than inside a windowed
   * card — "Visitors chatting · right now" is the only one so far.
   */
  aside?: ReactNode;
}

/**
 * One chatbot's verdict, as a band rather than as a card of prose.
 *
 * Overview and Knowledge both led with this block and each had written it
 * separately: a `CardBody` with an `Eyebrow`, an 18px heading, a badge and a
 * paragraph on a reading measure — about 140px of chrome to say one sentence,
 * and only one of the two copies offered the action the verdict asks for. So a
 * chatbot whose training had failed offered "Fix training" on Overview and
 * nothing at all on Knowledge.
 *
 * It is one line now: badge, verdict, why, and the way to fix it on the right.
 * The detail sentence is the only prose, and it sits on the same optical line as
 * everything else rather than under a heading of its own.
 */
export function AgentHealthStrip({ agent, health, aside }: AgentHealthStripProps) {
  const { pathname } = useLocation();

  // A verdict's action is a pointer to where the work is done, and four of the
  // six point at Knowledge. On Knowledge itself that made "Add knowledge" a
  // button to the page you are already reading — directly above an empty state
  // saying the same thing and the panel that actually does it. Suppressed by
  // comparing destinations rather than by naming a page, so this stays true for
  // any verdict added later and on any surface that adopts this band.
  const target = health.action ? agentPath(agent.id, health.action.segment) : null;
  const actionLeadsElsewhere = target !== null && target !== pathname;

  return (
    <Card>
      <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone={health.tone} dot>
          {severityWord(health.tone)}
        </Badge>
        <h2 className="text-base font-semibold text-text-primary">{health.label}</h2>
        <p className="min-w-0 flex-1 text-xs text-text-secondary">{health.detail}</p>
        {aside}
        {health.action && actionLeadsElsewhere ? (
          <Link to={target as string} className={buttonClass('secondary', 'sm')}>
            {health.action.label}
          </Link>
        ) : null}
      </CardBody>
    </Card>
  );
}
