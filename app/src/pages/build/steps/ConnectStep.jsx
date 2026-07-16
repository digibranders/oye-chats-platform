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

// Light client-side check so an obvious typo ("acme", "htp://…") is caught
// inline before we spend a full create+discover round-trip on the backend.
// Intentionally permissive: any host with a dot passes; the crawler does the
// authoritative reachability check.
function websiteError(raw) {
    const value = (raw || '').trim();
    if (!value) return 'Enter your website address.';
    let host;
    try {
        host = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname;
    } catch {
        return 'That doesn’t look like a valid website — try something like acme.com';
    }
    if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) {
        return 'That doesn’t look like a valid website — try something like acme.com';
    }
    return '';
}

export default function ConnectStep({ onConnected }) {
    const { bots, selectBot, refreshBots } = useBotContext();
    const { showToast } = useToast();
    const [website, setWebsite] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // On the resume path a bot already exists — prefill its stored website so the
    // returning user isn't forced to re-type a URL they already gave us. `bots`
    // can load after mount, so we use React's "adjust state during render"
    // pattern (not an effect): it fires once, before the user has typed, and the
    // `prefilledFrom` guard stops it from clobbering later edits or a cleared field.
    const [prefilledFrom, setPrefilledFrom] = useState(null);
    const existingSite = bots?.[0]?.website || '';
    if (existingSite && !website && prefilledFrom !== existingSite) {
        setPrefilledFrom(existingSite);
        setWebsite(existingSite);
    }

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
        const validationError = websiteError(website);
        if (validationError) {
            setError(validationError);
            return;
        }
        setError('');
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
            // create now returns the full bot object, so we can select it
            // directly — no fragile re-fetch-and-find. Still refresh the list so
            // the sidebar/bot switcher reflects the new bot.
            const bot = await createBot({ name: placeholderNameFromUrl(url), website: url });
            recordActivationEvent('bot_created', { botId: bot.id });
            await refreshBots();
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
                        onChange={(e) => {
                            setWebsite(e.target.value);
                            if (error) setError('');
                        }}
                        onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                        placeholder="acme.com"
                        aria-label="Website URL"
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? 'connect-website-error' : undefined}
                        className="font-mono pl-10"
                    />
                </div>
                {error ? (
                    <p id="connect-website-error" role="alert" className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">
                        {error}
                    </p>
                ) : (
                    <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                        That&rsquo;s all I need — I&rsquo;ll read your site, learn your brand, and suggest a name. You can
                        rename it later.
                    </p>
                )}
            </div>

            <Button size="lg" className="self-start" onClick={handleConnect} disabled={!canSubmit} loading={submitting}>
                {submitting ? 'Connecting…' : 'Build my agent'}
                {!submitting && <ArrowRight size={16} />}
            </Button>
        </div>
    );
}
