import { useState } from 'react';
import { ArrowRight, Globe } from 'lucide-react';
import { createBot, updateBot, recordActivationEvent } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';
import { useToast } from '../../../context/ToastContext';
import { Input } from '../../../components/ui/Input';
import { Button } from '../../../components/ui/Button';

/**
 * Connect milestone (Prove-it-first step 1): the website is the only thing we
 * ask for — it's the fuel for everything else. The agent name is deferred to the
 * Personalize step, pre-filled from the company name the crawl extracts, so the
 * user never faces a blank-page "name it" tax up front.
 *
 * We still create the bot here (the crawl needs something to attach to), using a
 * placeholder name derived from the domain (acme.com -> "Acme"). The Prove step
 * then auto-starts discovery + crawl; Personalize renames from the extracted
 * company name. New bots default to the BANT framework (Bot model server
 * default); framework is changed later on the Qualification page.
 */
function placeholderNameFromUrl(url) {
    try {
        const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
        const label = (host.split('.')[0] || '').trim();
        if (!label) return 'My Agent';
        return label.charAt(0).toUpperCase() + label.slice(1);
    } catch {
        return 'My Agent';
    }
}

export default function ConnectStep({ onConnected }) {
    const { bots, selectBot, refreshBots } = useBotContext();
    const { showToast } = useToast();
    const [website, setWebsite] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const canSubmit = website.trim() && !submitting;

    // Resolve the just-created/reused bot to its full object before selecting —
    // BotContext.selectBot expects a bot OBJECT (it reads bot.id); passing a bare
    // id corrupts selectedBot so every downstream `selectedBot?.website/.id` is
    // undefined, which is what bounced the flow back to a blank Connect step.
    const advanceWith = (bot) => {
        selectBot(bot);
        onConnected?.(bot.id);
    };

    const handleConnect = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            const url = website.trim();
            // Idempotent create. The /build onboarding is entered botless, but a
            // prior attempt (or an earlier bounce) can leave a bot already made.
            // Reuse it instead of creating a second one — free trials cap at one
            // bot, so a blind re-create 402s ("additional chatbot needs a paid
            // plan"). We only backfill a missing website; we never clobber an
            // existing one, and ProveStep skips re-crawling an already-trained bot.
            const existing = bots?.[0];
            if (existing) {
                if (!existing.website && url) {
                    await updateBot(existing.id, { website: url });
                }
                const fresh = await refreshBots();
                advanceWith(fresh.find((b) => b.id === existing.id) || existing);
                return;
            }
            const result = await createBot({ name: placeholderNameFromUrl(url), website: url });
            recordActivationEvent('bot_created', { botId: result.bot_id });
            const fresh = await refreshBots();
            const bot = fresh.find((b) => b.id === result.bot_id);
            if (!bot) {
                throw new Error('Your agent was created but could not be loaded. Refresh and try again.');
            }
            advanceWith(bot);
        } catch (err) {
            showToast('error', err?.message || 'Could not connect your site. Please try again.');
            setSubmitting(false);
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <div>
                <label className="block text-sm font-medium text-[var(--text)] mb-1.5">Your website</label>
                <div className="relative">
                    <Globe
                        size={16}
                        className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none"
                    />
                    <Input
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                        placeholder="acme.com"
                        aria-label="Website URL"
                        className="font-mono pl-10"
                    />
                </div>
                <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                    That&rsquo;s all I need — I&rsquo;ll read your site, learn your brand, and suggest a name. You can
                    rename it later.
                </p>
            </div>

            <Button size="lg" className="self-start" onClick={handleConnect} disabled={!canSubmit} loading={submitting}>
                {submitting ? 'Connecting…' : 'Build my agent'}
                {!submitting && <ArrowRight size={16} />}
            </Button>
        </div>
    );
}
