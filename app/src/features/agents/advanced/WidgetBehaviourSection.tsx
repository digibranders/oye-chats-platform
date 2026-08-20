import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Badge, SettingRow, Switch } from '../../../ui';
import { agentPath } from '../../../shell/nav';
import { FEATURE_FLAGS } from './behaviour.config';

export interface WidgetBehaviourSectionProps {
  flags: Record<string, boolean>;
  onToggle: (key: string, next: boolean) => void;
  agentId: number;
  /** True when this chatbot's plan includes live chat. */
  liveChatAllowed: boolean;
}

/**
 * Widget behaviour — the per-chatbot feature switches, bound to
 * `Bot.feature_flags`.
 *
 * Five settings, five rows. They used to be five `Switch`es inside a card with
 * its own eyebrow, title and description, and the "no effect" caveat on queue
 * position was a sibling paragraph *below* the whole switch rather than part of
 * the setting — two 12px lines about one control, starting at two different left
 * edges.
 *
 * Two honesty problems in the surface this replaces, both kept.
 *
 * **The Free plan overrides every one of these to off.**
 * `get_bot_settings_public` rewrites the whole map for `plan_slug == "free"`
 * before the widget ever sees it, so a Free workspace could switch five things
 * on, save successfully, and watch none of them happen. The stored values are
 * shown as stored — flipping them here would misreport the record — with the
 * override stated once, on the group above.
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
  liveChatAllowed,
}: WidgetBehaviourSectionProps) {
  return (
    <>
      {FEATURE_FLAGS.map((flag) => {
        const inert = flag.needsLiveChat && !liveChatAllowed;
        return (
          <SettingRow
            key={flag.key}
            label={flag.label}
            badge={inert ? <Badge tone="neutral">No effect</Badge> : undefined}
            description={
              inert ? (
                <>
                  There is no queue without live chat.{' '}
                  <Link
                    to={agentPath(agentId, 'experience')}
                    className="text-accent-600 underline underline-offset-2"
                  >
                    Turn live chat on
                  </Link>
                  .
                </>
              ) : (
                flag.desc
              )
            }
            controlWidth="auto"
          >
            <Switch
              checked={flags[flag.key] ?? flag.default}
              onCheckedChange={(next) => onToggle(flag.key, next)}
              label={flag.label}
              hideLabel
            />
          </SettingRow>
        );
      })}
    </>
  );
}

/*
 * Memoised. The page is one draft object, so every keystroke anywhere on it
 * produces a new draft and re-renders the tree. A rubric with six dimensions and
 * five answers each is around sixty controls, and typing a digit into a
 * threshold should not touch any of them.
 */
export const WidgetBehaviourSection = memo(WidgetBehaviourSectionInner);
