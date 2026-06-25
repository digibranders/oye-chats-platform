/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import UpgradeModal from '../components/UpgradeModal';

/**
 * UpgradeModalContext — the global trigger for the premium upsell dialog.
 *
 * Components anywhere in the admin tree get a one-line API:
 *
 *   const { requestUpgrade } = useUpgradeModal();
 *   requestUpgrade('add_bot', { current: bots.length, limit: 1 });
 *
 * All copy lives in the {@link UPGRADE_INTENTS} registry below so wording is
 * consistent across the dashboard and marketing can retune messaging in one
 * place. Callers that need bespoke copy can pass a full payload object
 * instead of an intent key.
 *
 * The provider keeps a single piece of state (`payload`) — non-null means
 * the modal is open. We deliberately do NOT queue: only one upsell is shown
 * at a time, the most recent request wins. Free-tier users hit two gates in
 * the same flow shouldn't see a back-to-back modal stack.
 */

const UpgradeModalContext = createContext(null);

/**
 * Preset payloads for every gated capability in the dashboard. Add a new
 * key here and the modal automatically gets the right copy when callers
 * pass that key. Functions receive optional params so callers can surface
 * the live "X of Y used" counter where it makes sense.
 */
export const UPGRADE_INTENTS = {
    add_bot: ({ current, planName } = {}) => {
        const plan = planName || 'Free';
        // Per-bot billing: every chatbot needs its own subscription, so
        // the modal narrative is uniform regardless of current plan —
        // "subscribe again to add another bot".
        return {
            intentKey: 'add_bot',
            eyebrow: `You already have ${current ?? 1} chatbot${(current ?? 1) === 1 ? '' : 's'} on ${plan}`,
            title: 'Subscribe again to add another bot',
            description:
                'Each chatbot is its own subscription with its own credits, knowledge base, and branding. ' +
                'Pick a plan for this new bot to spin it up.',
            highlights: [
                'Isolated credits per bot — a busy bot never drains a quieter one',
                'Per-bot knowledge base, branding, and embed key',
                'Separate analytics and billing for every chatbot',
            ],
            recommendedPlan: 'Starter',
        };
    },
    add_operator: () => ({
        intentKey: 'add_operator',
        eyebrow: 'Live chat is a paid feature',
        title: 'Invite your team to live chat',
        description:
            "Free plans focus on the bot. Upgrade to invite operators, hand off conversations in real time, and never miss a hot lead.",
        highlights: [
            'Real-time human handoff from any chat',
            'Up to 5 operators on Starter',
            'Per-operator concurrent chat limits',
        ],
        recommendedPlan: 'Starter',
    }),
    add_department: () => ({
        intentKey: 'add_department',
        eyebrow: 'Departments power smart routing',
        title: 'Organize teams with departments',
        description:
            'Group operators by team — Sales, Support, Billing — and route visitors to the right people. Available on plans with live chat.',
        highlights: [
            'Route visitors to the right team',
            'Per-department business hours',
            'Cleaner reports broken down by team',
        ],
        recommendedPlan: 'Starter',
    }),
    add_canned_response: () => ({
        intentKey: 'add_canned_response',
        eyebrow: 'Quick replies are a Starter feature',
        title: 'Reply faster with canned responses',
        description:
            'Save common answers as one-click snippets your team can drop into any conversation. Frees up time for the questions that matter.',
        highlights: [
            'Unlimited reusable responses',
            '/shortcut keyboard triggers',
            'Shared across the whole team',
        ],
        recommendedPlan: 'Starter',
    }),
    view_support: () => ({
        intentKey: 'view_support',
        eyebrow: 'Live chat & inbox are paid features',
        title: 'Unlock the support workspace',
        description:
            'Take over conversations from your bot, answer offline messages, and keep a full audit trail of every interaction. Upgrade to flip it on.',
        highlights: [
            'Live operator handoff in real time',
            'Offline message inbox with notifications',
            'Per-conversation audit log',
        ],
        recommendedPlan: 'Starter',
    }),
    view_leads: () => ({
        intentKey: 'view_leads',
        eyebrow: 'Leads dashboard is a paid feature',
        title: 'Capture every visitor as a lead',
        description:
            'Upgrade to unlock the leads dashboard, CSV export, BANT scoring, and webhook delivery.',
        highlights: [
            'Searchable, filterable leads inbox',
            'CSV export & webhook push to your CRM',
            'BANT scoring & conversation qualification',
        ],
        recommendedPlan: 'Starter',
    }),
    leads_form: () => ({
        intentKey: 'leads_form',
        eyebrow: 'Lead capture form is a paid feature',
        title: 'Capture leads inside the chat',
        description:
            'Turn the chat widget into a lead-capture funnel — collect name, email, phone, and custom fields right inside the conversation.',
        highlights: [
            'Required & optional custom fields',
            'Auto-route to your CRM via webhooks',
            'Pairs with live chat handoff',
        ],
        recommendedPlan: 'Starter',
    }),
    view_team: () => ({
        intentKey: 'view_team',
        eyebrow: 'Team management is a paid feature',
        title: 'Bring your team into the chat',
        description:
            'Invite operators, organize them into departments, and stock canned responses for one-click replies. The whole live-chat workspace becomes a team sport.',
        highlights: [
            'Up to 5 operators on Starter, more on Standard',
            'Departments for smart routing & business hours',
            'Quick replies with /shortcut keyboard triggers',
        ],
        recommendedPlan: 'Starter',
    }),
    view_qualification: () => ({
        intentKey: 'view_qualification',
        eyebrow: 'Lead qualification is a paid feature',
        title: 'Score every conversation automatically',
        description:
            'BANT (Budget, Authority, Need, Timeline) scoring runs on every chat so your team sees hot leads first. Configure thresholds, custom tiers, and routing.',
        highlights: [
            'Automatic BANT scoring on every conversation',
            'MQL → SAL → SQL pipeline view',
            'Webhook hand-off when a lead crosses a threshold',
        ],
        recommendedPlan: 'Standard',
    }),
    view_integrations: () => ({
        intentKey: 'view_integrations',
        eyebrow: 'Integrations are a paid feature',
        title: 'Connect your stack',
        description:
            'Push leads to your CRM, book meetings inside the chat, and fire webhooks on every event. Free plans handle email delivery from Settings → Visitor Messages.',
        highlights: [
            'Webhooks to any HTTPS endpoint (HMAC-signed, auto-retry)',
            'Calendly & Zcal meeting booking in the widget',
            'Per-event recipient routing & visitor confirmation emails',
        ],
        recommendedPlan: 'Starter',
    }),
    webhooks_integration: () => ({
        intentKey: 'webhooks_integration',
        eyebrow: 'Webhooks are a paid feature',
        title: 'Push leads & events to your stack',
        description:
            'Forward qualified leads, live-chat handoffs, and offline messages to your CRM, Slack, or any HTTPS endpoint in real time. HMAC-signed and retried up to 5 times.',
        highlights: [
            'Real-time delivery to any HTTPS endpoint',
            'HMAC signing + per-attempt audit log',
            'Auto-retry with backoff (30s → 4h)',
        ],
        recommendedPlan: 'Standard',
    }),
    meetings_integration: () => ({
        intentKey: 'meetings_integration',
        eyebrow: 'Meeting booking is a paid feature',
        title: 'Book meetings inside the chat',
        description:
            'Drop a Calendly or Zcal link into qualifying conversations so visitors book a call without leaving the widget. Booking confirmations sync back to the leads inbox.',
        highlights: [
            'Calendly & Zcal supported out of the box',
            'Auto-trigger on BANT qualification',
            'Bookings logged against the lead',
        ],
        recommendedPlan: 'Starter',
    }),
    advanced_settings: () => ({
        intentKey: 'advanced_settings',
        eyebrow: 'Advanced widget tuning is a paid feature',
        title: 'Fine-tune your widget',
        description:
            'Greeting delays, frustration thresholds, reconnect behavior, typing timeouts — the knobs that take a good chatbot from "works" to "feels right" on your site.',
        highlights: [
            'Custom greeting + handoff timing',
            'Reconnect & heartbeat strategy',
            'Frustration detection thresholds',
        ],
        recommendedPlan: 'Starter',
    }),
    live_chat_appearance: () => ({
        intentKey: 'live_chat_appearance',
        eyebrow: 'Live chat is a paid feature',
        title: 'Configure live chat handoff',
        description:
            'Customize when and how the bot offers a real human, route to the right team, and set wait-time copy — the full visitor request flow.',
        highlights: [
            'Inline "Talk to a human" CTA',
            'Per-bot handoff timing',
            'Department-aware routing',
        ],
        recommendedPlan: 'Starter',
    }),
};

export function UpgradeModalProvider({ children }) {
    const [payload, setPayload] = useState(null);

    const close = useCallback(() => setPayload(null), []);

    const requestUpgrade = useCallback((intentOrPayload, params) => {
        // Two call shapes — a known intent key, or a fully-formed payload.
        // The latter is escape-hatch for one-off copy that doesn't justify
        // a registry entry.
        if (typeof intentOrPayload === 'string') {
            const builder = UPGRADE_INTENTS[intentOrPayload];
            if (!builder) {
                // Fail open: still surface SOMETHING rather than silently
                // dropping the click. The fallback copy is generic but
                // honest about being a paid feature.
                if (import.meta.env.DEV) {
                    console.warn(`[UpgradeModal] Unknown intent key: ${intentOrPayload}`);
                }
                setPayload({
                    intentKey: intentOrPayload,
                    title: 'Upgrade your plan',
                    description: 'This feature is available on paid plans.',
                    recommendedPlan: 'Starter',
                });
                return;
            }
            setPayload(builder(params));
            return;
        }
        if (intentOrPayload && typeof intentOrPayload === 'object') {
            setPayload(intentOrPayload);
        }
    }, []);

    // Esc-to-close is conventional for modals and keyboard users expect it.
    useEffect(() => {
        if (!payload) return undefined;
        const handler = (e) => {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [payload, close]);

    return (
        <UpgradeModalContext.Provider value={{ requestUpgrade, close, isOpen: payload !== null }}>
            {children}
            <UpgradeModal payload={payload} onClose={close} />
        </UpgradeModalContext.Provider>
    );
}

export function useUpgradeModal() {
    const ctx = useContext(UpgradeModalContext);
    if (!ctx) {
        throw new Error('useUpgradeModal must be called inside <UpgradeModalProvider>');
    }
    return ctx;
}
