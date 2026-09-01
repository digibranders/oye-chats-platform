import { Combobox } from '../ui';
import { useBotContext } from '../context/BotContext';
import { useTranslation } from '../i18n/useTranslation';

/** The sentinel the combobox uses for "no chatbot scoped". */
const ALL = '__all__';

/**
 * Which chatbot the WORKSPACE pages are showing.
 *
 * Not the same control as `AgentSwitcher`, and the difference is the whole
 * point. That one NAVIGATES: the chatbot pages read their subject from the URL,
 * so switching there has to change the address. This one is a pure STATE write.
 * Leads, Inbox, Journey and Analytics read `BotContext.selectedBot`, so the URL
 * is left alone and only the data changes. The two never appear together, since
 * the rail renders agent scope or workspace scope, never both.
 *
 * It restores something the redesign dropped. The legacy shell had a
 * `BotSwitcher`; `AgentContext` still documents it as "the sole writer of that
 * scope". It was not rebuilt, which left `selectBot` with no caller at all — so
 * `selectedBot` could only ever be null, and those four pages were permanently
 * aggregating every chatbot with no way to narrow and nothing on screen saying
 * that was what you were looking at.
 *
 * **Hidden below two chatbots**, which is not a micro-optimisation. Every plan
 * except Enterprise allows exactly ONE chatbot, so for almost every account
 * there is no choice to make and this would be chrome that never does anything.
 * Legacy gated it the same way, and that gate is why nobody noticed it had gone.
 *
 * "All chatbots" is offered because these four surfaces can aggregate
 * truthfully. Billing and Usage deliberately do not use this control: a plan and
 * a credit balance belong to one chatbot, so a combined view there would be a
 * figure that does not exist.
 */
export function BotScopeSwitcher() {
  const { t } = useTranslation();
  const { bots, selectedBot, selectBot, loading } = useBotContext();

  if (loading || bots.length < 2) return null;

  const allLabel = t('shell.allChatbots') || 'All chatbots';

  return (
    <Combobox
      size="sm"
      // Named for what it does to the page, not for what it contains. "Chatbot"
      // would read as a second navigation control beside the rail's chatbot
      // list, which is what this is most likely to be confused with.
      label={t('shell.showing') || 'Showing'}
      value={selectedBot ? String(selectedBot.id) : ALL}
      searchPlaceholder={t('shell.findAChatbot') || 'Find a chatbot…'}
      emptyMessage={t('shell.noChatbotsMatch') || 'No chatbots match'}
      options={[
        { value: ALL, label: allLabel },
        ...bots.map((bot) => ({
          value: String(bot.id),
          label: bot.name ?? `${t('shell.chatbot') || 'Chatbot'} ${bot.id}`,
          description: bot.bot_key ?? undefined,
        })),
      ]}
      onValueChange={(next) => {
        if (!next) return;
        if (next === ALL) {
          selectBot(null);
          return;
        }
        selectBot(bots.find((bot) => String(bot.id) === next) ?? null);
      }}
      className="border-rail-border bg-rail-hover text-rail-text hover:border-rail-text-muted"
    />
  );
}
