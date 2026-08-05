import { type Bot } from '../../../types/domain';

/**
 * Overall health of an agent, worst-first:
 * - `critical` - something is actively broken (last training failed).
 * - `setup`    - the agent can't work yet (it has learned nothing).
 * - `attention`- it works but isn't delivering value yet (trained, not live).
 * - `training` - a crawl is in progress; check back shortly.
 * - `healthy`  - trained and live on a website.
 */
export type HealthLevel = 'healthy' | 'training' | 'attention' | 'setup' | 'critical';

/** Status of a single health check row. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'pending';

export interface HealthCheck {
  /** Stable key for React lists. */
  readonly id: string;
  /** Human label, e.g. "Knowledge". */
  readonly label: string;
  /** Outcome of the check. */
  readonly status: CheckStatus;
  /** One-line plain-language detail. */
  readonly detail: string;
}

export interface AgentHealth {
  readonly level: HealthLevel;
  /** Headline answer to "Is my AI healthy?". */
  readonly title: string;
  /** Supporting sentence. */
  readonly description: string;
  /** Per-area breakdown shown under the headline. */
  readonly checks: readonly HealthCheck[];
  /**
   * The single most useful next step, when one exists. `to` is a route relative
   * to the agent, e.g. `knowledge` → `/agents/:id/knowledge`.
   */
  readonly nextStep: { readonly label: string; readonly to: string } | null;
}

/** True when the agent has indexed at least one chunk of knowledge. */
function isTrained(agent: Bot): boolean {
  return (agent.indexed_chunk_count ?? 0) > 0;
}

/** True when the embed script has been detected on the customer's site. */
function isDeployed(agent: Bot): boolean {
  return Boolean(agent.widget_installed_at);
}

/**
 * Builds the Knowledge check row from the agent's crawl/index state.
 *
 * Order matters. `indexed_chunk_count` is what the agent CURRENTLY knows;
 * `last_crawl_status` only describes the last training ATTEMPT. Checking the
 * attempt first made a single failed recrawl report "Nothing learned yet" on an
 * agent holding thousands of passages, so a trained agent is reported as
 * trained and a failed attempt is demoted to a warning about that attempt.
 */
function knowledgeCheck(agent: Bot): HealthCheck {
  const chunks = agent.indexed_chunk_count ?? 0;
  const trained = chunks > 0;

  if (agent.last_crawl_status === 'running') {
    return {
      id: 'knowledge',
      label: 'Knowledge',
      status: 'pending',
      detail: trained
        ? `Trained on ${formatPassages(chunks)} - learning more right now.`
        : 'Learning from your website right now.',
    };
  }

  if (trained) {
    return {
      id: 'knowledge',
      label: 'Knowledge',
      status: agent.last_crawl_status === 'failed' ? 'warn' : 'pass',
      detail:
        agent.last_crawl_status === 'failed'
          ? `Trained on ${formatPassages(chunks)}, but the last training run failed.`
          : `Trained on ${formatPassages(chunks)}.`,
    };
  }

  if (agent.last_crawl_status === 'failed') {
    return {
      id: 'knowledge',
      label: 'Knowledge',
      status: 'fail',
      detail: 'The last training run failed. Try training again.',
    };
  }

  return {
    id: 'knowledge',
    label: 'Knowledge',
    status: 'fail',
    detail: 'Nothing learned yet - add a website or documents.',
  };
}

/** "1 passage" / "1,204 passages" - shared so every knowledge string agrees. */
function formatPassages(chunks: number): string {
  return `${chunks.toLocaleString()} ${chunks === 1 ? 'passage' : 'passages'}`;
}

/** Builds the Deployment check row from the widget-install signal. */
function deploymentCheck(agent: Bot): HealthCheck {
  if (isDeployed(agent)) {
    return {
      id: 'deployment',
      label: 'Live on your site',
      status: 'pass',
      detail: 'The chat widget is installed and answering visitors.',
    };
  }

  return {
    id: 'deployment',
    label: 'Live on your site',
    status: 'warn',
    detail: 'Not installed yet - add the widget to start conversations.',
  };
}

/**
 * Derives an agent's health entirely from its own fields (no network). Pure and
 * synchronous so it can run on every render without an effect.
 */
export function deriveAgentHealth(agent: Bot): AgentHealth {
  const knowledge = knowledgeCheck(agent);
  const deployment = deploymentCheck(agent);
  const checks: readonly HealthCheck[] = [knowledge, deployment];

  // Worst-first: a failed crawl is the loudest problem.
  if (knowledge.status === 'fail' && agent.last_crawl_status === 'failed') {
    return {
      level: 'critical',
      title: 'Training needs attention',
      description: 'Your AI’s last training run failed, so its answers may be out of date.',
      checks,
      nextStep: { label: 'Retry training', to: 'knowledge' },
    };
  }

  // Still learning - nothing is wrong, just not ready.
  if (knowledge.status === 'pending') {
    return {
      level: 'training',
      title: 'Your AI is learning',
      description: 'Training is in progress. This usually takes a few minutes.',
      checks,
      nextStep: { label: 'View progress', to: 'knowledge' },
    };
  }

  // Untrained - the agent can't answer anything useful.
  if (!isTrained(agent)) {
    return {
      level: 'setup',
      title: 'Your AI needs knowledge',
      description: 'Teach your AI about your business so it can answer visitor questions.',
      checks,
      nextStep: { label: 'Add knowledge', to: 'knowledge' },
    };
  }

  // Trained but nobody can reach it.
  if (!isDeployed(agent)) {
    return {
      level: 'attention',
      title: 'Ready to go live',
      description: 'Your AI is trained and answering well - add it to your website to meet visitors.',
      checks,
      nextStep: { label: 'Install widget', to: 'channels' },
    };
  }

  // Trained and live.
  return {
    level: 'healthy',
    title: 'Your AI is healthy',
    description: 'It’s trained, live on your website, and answering visitors.',
    checks,
    nextStep: null,
  };
}
