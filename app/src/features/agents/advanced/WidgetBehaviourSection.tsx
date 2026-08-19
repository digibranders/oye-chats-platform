import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Card, CardBody, CardHeader, CardSection, Switch, buttonClass } from '../../../ui';
import { agentPath } from '../../../shell/nav';
import { FEATURE_FLAGS } from './behaviour.config';

export interface WidgetBehaviourSectionProps {
  flags: Record<string, boolean>;
  onToggle: (key: string, next: boolean) => void;
  agentId: number;
  /** True when the workspace is on the Free plan, where these are all forced off. */
  isFree: boolean;
  /** True when this chatbot's plan includes live chat. */
  liveChatAllowed: boolean;
}

/**
 * Widget behaviour — the per-chatbot feature switches, bound to
 * `Bot.feature_flags`.
 *
 * Two honesty problems in the surface this replaces, both fixed here.
 *
 * **The Free plan overrides every one of these to off.**
 * `get_bot_settings_public` rewrites the whole map for `plan_slug == "free"`
 * before the widget ever sees it, so a Free workspace could switch five things
 * on, save successfully, and watch none of them happen. The stored values are
 * shown as stored — flipping them here would misreport the record — with the
 * override stated once, at the top.
 *
 * **Queue position only means anything with live chat on.** Without it there is
 * no queue, so the switch is a no-op with no explanation.
 *
 * `show_branding` is deliberately not here: it is plan-gated and owned by
 * Experience ▸ Branding, and an ungated copy would be a silent no-op on every
 * plan the server forces it true for.
 */
function WidgetBehaviourSectionInner({
  flags,
  onToggle,
  agentId,
  isFree,
  liveChatAllowed,
}: WidgetBehaviourSectionProps) {
  return (
    <Card>
      <CardHeader
        title="Widget behaviour"
        titleAs="h2"
        description="What the chat widget offers visitors on your site."
      />

      {isFree ? (
        <CardSection>
          <Alert
            tone="plan"
            title="These are switched off for visitors on the Free plan"
            action={
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                See plans
              </Link>
            }
          >
            Your settings are saved and shown here as you left them, but the widget ignores all of
            them until the workspace is on a paid plan.
          </Alert>
        </CardSection>
      ) : null}

      <CardBody className="space-y-5">
        {FEATURE_FLAGS.map((flag) => {
          const inert = flag.needsLiveChat && !liveChatAllowed;
          return (
            <div key={flag.key}>
              <Switch
                checked={flags[flag.key] ?? flag.default}
                onCheckedChange={(next) => onToggle(flag.key, next)}
                label={flag.label}
                description={flag.desc}
              />
              {inert ? (
                <p className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">No effect</Badge>
                  <span className="text-xs text-text-secondary">
                    There is no queue without live chat.{' '}
                    <Link
                      to={agentPath(agentId, 'experience')}
                      className="text-accent-600 underline underline-offset-2"
                    >
                      Turn live chat on
                    </Link>
                    .
                  </span>
                </p>
              ) : null}
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const WidgetBehaviourSection = memo(WidgetBehaviourSectionInner);
