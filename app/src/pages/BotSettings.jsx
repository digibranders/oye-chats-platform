import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getAuthState } from '../utils/auth';
import Cropper from 'react-easy-crop';
import {
    CheckCircle, RefreshCw, Sparkles, Check, AlertCircle, X,
    ZoomIn, ZoomOut, RotateCw, Lock,
} from 'lucide-react';
import { getClientSettings, updateClientSettings, uploadLogo, getBotPreviewUrl, getBotDemoOrigin, getBrandTonePresets, detectBrandTone, previewBrandTone } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { useUpgradeModal } from '../context/UpgradeModalContext';
import useEntitlements from '../hooks/useEntitlements';
import EmptyState from '../components/ui/EmptyState';
import PageHeader from '../components/PageHeader';
import { getCroppedImg } from './bot-settings/cropImage';
import GeneralTab from './bot-settings/GeneralTab';
import PersonalityTab from './bot-settings/PersonalityTab';
import AppearanceTab from './bot-settings/AppearanceTab';
import MessagesTab from './bot-settings/MessagesTab';
import BehaviorTab from './bot-settings/BehaviorTab';
import LeadsTab from './bot-settings/LeadsTab';
import LiveChatTab from './bot-settings/LiveChatTab';
import WidgetChatPreview from '../components/WidgetChatPreview';

/**
 * Default editable bot fields. Keys mirror the bot-model field names so the
 * save payload (built in `handleSave`) is a near-passthrough of `draft`.
 */
const DEFAULT_DRAFT = {
    bot_name: 'AI Assistant',
    bot_logo: null,
    launcher_name: 'Have Questions?',
    launcher_logo: null,
    primary_color: '#ba68c8',
    user_bubble_color: '#DBE9FF',
    recommended_colors: [],
    bant_enabled: true,
    avatar_type: 'upload',
    orb_color: '',
    lead_form_enabled: false,
    lead_form_fields: [
        { field: 'name', required: true },
        { field: 'email', required: true },
    ],
    notification_emails: [],
    email_on_qualified: true,
    email_on_handoff: true,
    live_chat_enabled: true,
    welcome_title: 'Hi there 👋',
    welcome_subtitle: 'How can we help you today?',
    waiting_message: 'Connecting you to support...',
    offline_message: "We'll be right back! Leave a message and we'll follow up shortly.",
    handoff_delay_seconds: 0,
    widget_messages: {},
    widget_config: {},
    relevance_threshold: null,
    branding_text: 'Powered by OyeChats',
    branding_url: 'https://oyechats.com',
    services: [],
    services_url: '',
    // ── Absorbed from old Settings (sub-project 1 gap closure) ──
    system_prompt: '',
    brand_tone: '',
    brand_tone_preset: null,
    company_name: '',
    company_description: '',
    // Server-managed: names of auto-fillable fields the user locked by editing
    // them (see PersonalityTab hints). Read-only in the draft — never sent on save.
    manual_field_overrides: [],
    feature_flags: {},
    // Owned by the Integrations → Meetings tab (saved via updateBot). Mirrored
    // here read-only so the Live Preview can show the booking affordance; it is
    // intentionally NOT part of the BotSettings save payload.
    meeting_booking_enabled: false,
    live_chat_queue_timeout_seconds: 20,
    live_chat_max_queue_size: 10,
};

/**
 * BotSettings — the per-bot editor shell.
 *
 * Owns all shared state lifted from the legacy `Interface.jsx`: the editable
 * bot `draft` + a single `set(field, value)` updater (the "Shell ↔ tab
 * contract"), the Save action + dirty/toast handling, plan entitlements (`ent`)
 * + lock badges / upgrade modals, the live widget preview pane, and inner
 * active-tab state. Each tab under `pages/bot-settings/` is a presentational +
 * field-binding component receiving `{ draft, set, ent, ... }`.
 */
export default function BotSettings() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const { isBotManager } = getAuthState();
    const { requestUpgrade } = useUpgradeModal();
    const { entitlements: ent } = useEntitlements();

    // Free plans don't include lead capture or live chat. Both tabs stay
    // visible with a lock badge so the upsell is discoverable from the surface
    // itself rather than only from the sidebar.
    const liveChatAllowed = ent.hasFeature('live_chat');
    const leadFormLocked = ent.isFree;
    const advancedLocked = ent.isFree;

    // ── Editable bot draft + single-field updater (shell ↔ tab contract) ──
    const [draft, setDraft] = useState(DEFAULT_DRAFT);
    const set = useCallback((field, value) => {
        setDraft((prev) => ({ ...prev, [field]: value }));
    }, []);

    // ── Save / status state ──
    const [isSaving, setIsSaving] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState(null);

    // ── Brand-tone presets + detect/preview state (AI & Personality tab) ──
    const [brandTonePresets, setBrandTonePresets] = useState([]);
    const [detectingTone, setDetectingTone] = useState(false);
    const [previewingTone, setPreviewingTone] = useState(false);
    const [tonePreviewSample, setTonePreviewSample] = useState('');

    // ── Inner active-tab + preview state ──
    // A valid ``?section=`` deep-links to a sub-tab (e.g. Settings → Live Chat
    // links here with ``section=live_chat``); the gate effect below still
    // bounces locked sections back to General on Free plans.
    const [searchParams] = useSearchParams();
    const [activeTab, setActiveTab] = useState(() => {
        const section = searchParams.get('section');
        const known = ['general', 'personality', 'appearance', 'messages', 'behavior', 'leads', 'live_chat'];
        return known.includes(section) ? section : 'general';
    });
    const [previewState, setPreviewState] = useState('chat');

    // ── Live "Preview on my website" panel ──
    const [websitePreviewOpen, setWebsitePreviewOpen] = useState(false);
    const [previewUrlInput, setPreviewUrlInput] = useState('');
    const [loadedPreviewUrl, setLoadedPreviewUrl] = useState('');
    const [previewReady, setPreviewReady] = useState(false);
    const previewIframeRef = useRef(null);

    // ── Avatar crop modal state ──
    const [showCropModal, setShowCropModal] = useState(false);
    const [cropImage, setCropImage] = useState(null);
    const [cropFileName, setCropFileName] = useState('');
    const [crop, setCrop] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

    const onCropComplete = useCallback((_croppedArea, croppedAreaPx) => {
        setCroppedAreaPixels(croppedAreaPx);
    }, []);

    // ── Load bot settings into the draft ──
    const fetchSettings = useCallback(async () => {
            try {
                const settings = await getClientSettings(selectedBot?.id);
                // Load emails: prefer notification_emails.default (multi), fallback to legacy notification_email
                const defaultEmails = settings.notification_emails?.default;
                let notificationEmails = [];
                if (Array.isArray(defaultEmails) && defaultEmails.length > 0) {
                    notificationEmails = defaultEmails;
                } else if (settings.notification_email) {
                    notificationEmails = [settings.notification_email];
                }
                setDraft({
                    bot_name: settings.bot_name || 'AI Assistant',
                    bot_logo: settings.bot_logo || null,
                    launcher_name: settings.launcher_name || 'Have Questions?',
                    launcher_logo: settings.launcher_logo || null,
                    primary_color: settings.primary_color || '#ba68c8',
                    user_bubble_color: settings.user_bubble_color || '#DBE9FF',
                    recommended_colors: settings.recommended_colors || [],
                    bant_enabled: settings.bant_enabled ?? true,
                    avatar_type: settings.avatar_type || 'upload',
                    orb_color: settings.orb_color || '',
                    lead_form_enabled: settings.lead_form_enabled ?? false,
                    lead_form_fields: settings.lead_form_fields || DEFAULT_DRAFT.lead_form_fields,
                    notification_emails: notificationEmails,
                    email_on_qualified: settings.email_on_qualified ?? true,
                    email_on_handoff: settings.email_on_handoff ?? true,
                    live_chat_enabled: settings.live_chat_enabled ?? true,
                    welcome_title: settings.welcome_title || 'Hi there 👋',
                    welcome_subtitle: settings.welcome_subtitle || 'How can we help you today?',
                    waiting_message: settings.waiting_message || 'Connecting you to support...',
                    offline_message: settings.offline_message || "We'll be right back! Leave a message and we'll follow up shortly.",
                    handoff_delay_seconds: settings.handoff_delay_seconds ?? 0,
                    widget_messages: settings.widget_messages || {},
                    widget_config: settings.widget_config || {},
                    relevance_threshold: settings.relevance_threshold ?? null,
                    branding_text: settings.branding_text || 'Powered by OyeChats',
                    branding_url: settings.branding_url || 'https://oyechats.com',
                    services: Array.isArray(settings.services) ? settings.services : [],
                    services_url: settings.services_url || '',
                    // Absorbed configs — the bot GET returns these; company info
                    // + brand tone auto-fill from the website crawl unless locked
                    // (see manual_field_overrides).
                    system_prompt: settings.system_prompt || '',
                    brand_tone: settings.brand_tone || '',
                    brand_tone_preset: settings.brand_tone_preset ?? null,
                    company_name: settings.company_name || '',
                    company_description: settings.company_description || '',
                    manual_field_overrides: Array.isArray(settings.manual_field_overrides)
                        ? settings.manual_field_overrides
                        : [],
                    feature_flags: settings.feature_flags || {},
                    // Read-only mirror of the Integrations → Meetings toggle so the
                    // Live Preview matches the real widget's action bar.
                    meeting_booking_enabled: settings.meeting_booking_enabled ?? false,
                    live_chat_queue_timeout_seconds: settings.live_chat_queue_timeout_seconds ?? 20,
                    live_chat_max_queue_size: settings.live_chat_max_queue_size ?? 10,
                });
            } catch (error) {
                console.error('Error fetching settings:', error);
                showToast('error', error.message || 'Failed to load widget settings');
            }
    }, [selectedBot?.id, showToast]);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    // Load the brand-tone preset catalog once (tolerate failure → no chips).
    useEffect(() => {
        let cancelled = false;
        getBrandTonePresets()
            .then((presets) => {
                if (!cancelled) setBrandTonePresets(presets);
            })
            .catch(() => {
                /* non-fatal: the tab still works as free text without chips */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Reset any stale tone preview when switching bots.
    useEffect(() => {
        setTonePreviewSample('');
    }, [selectedBot?.id]);

    // Re-detect brand tone from the bot's crawled content (no re-crawl). Writes
    // on the server + unlocks the field; mirror that into the local draft.
    const handleDetectTone = useCallback(async () => {
        if (!isBotManager || !selectedBot?.id) return;
        setDetectingTone(true);
        try {
            const result = await detectBrandTone(selectedBot.id);
            setDraft((prev) => ({
                ...prev,
                brand_tone: result.brand_tone || '',
                brand_tone_preset: result.brand_tone_preset ?? null,
                manual_field_overrides: (prev.manual_field_overrides || []).filter((f) => f !== 'brand_tone'),
            }));
            setTonePreviewSample('');
            showToast('success', 'Brand tone detected from your website.');
        } catch (error) {
            const msg = error?.detail || error?.message || 'Failed to detect brand tone';
            showToast(error?.status === 400 ? 'info' : 'error', msg);
        } finally {
            setDetectingTone(false);
        }
    }, [isBotManager, selectedBot?.id, showToast]);

    // Generate a sample bot reply in the current (unsaved) draft tone.
    const handleTonePreview = useCallback(async () => {
        if (!selectedBot?.id) return;
        const tone = (draft.brand_tone || '').trim();
        if (!tone) {
            showToast('info', 'Add some brand tone text first.');
            return;
        }
        setPreviewingTone(true);
        try {
            const result = await previewBrandTone(selectedBot.id, tone);
            setTonePreviewSample(result.sample || '');
        } catch (error) {
            showToast('error', error?.detail || error?.message || 'Preview unavailable, try again.');
        } finally {
            setPreviewingTone(false);
        }
    }, [selectedBot?.id, draft.brand_tone, showToast]);

    // Prefill the preview URL with the bot's configured website.
    useEffect(() => {
        if (selectedBot?.website && !previewUrlInput) {
            setPreviewUrlInput(selectedBot.website);
        }
    }, [selectedBot?.website, previewUrlInput]);

    // Build the current draft payload — same shape the widget expects.
    const buildPreviewPayload = useCallback(() => ({
        bot_name: draft.bot_name,
        bot_logo: draft.bot_logo,
        launcher_name: draft.launcher_name,
        launcher_logo: draft.launcher_logo,
        primary_color: draft.primary_color,
        header_color: draft.primary_color,
        user_bubble_color: draft.user_bubble_color,
        background_color: '#ffffff',
        avatar_type: draft.avatar_type,
        orb_color: draft.orb_color || null,
        welcome_title: draft.welcome_title,
        welcome_subtitle: draft.welcome_subtitle,
        waiting_message: draft.waiting_message,
        offline_message: draft.offline_message,
        branding_text: draft.branding_text,
        branding_url: draft.branding_url,
        widget_messages: draft.widget_messages,
        widget_config: draft.widget_config,
        feature_flags: draft.feature_flags,
        services: draft.services,
    }), [draft]);

    // Listen for the widget's ready signal so we flush the initial draft.
    useEffect(() => {
        if (!websitePreviewOpen) return undefined;
        const apiOrigin = getBotDemoOrigin();
        const handler = (event) => {
            if (event.origin !== apiOrigin) return;
            if (event.data?.type === 'oyechats:preview-ready') {
                setPreviewReady(true);
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [websitePreviewOpen]);

    // Reset readiness when the iframe URL changes.
    useEffect(() => {
        setPreviewReady(false);
    }, [loadedPreviewUrl, websitePreviewOpen]);

    // Push config to the widget (debounced) whenever a relevant field changes
    // and the widget has signaled readiness.
    useEffect(() => {
        if (!websitePreviewOpen || !previewReady) return undefined;
        const iframe = previewIframeRef.current;
        if (!iframe?.contentWindow) return undefined;
        const apiOrigin = getBotDemoOrigin();
        const payload = buildPreviewPayload();
        const timer = setTimeout(() => {
            try {
                iframe.contentWindow.postMessage(
                    { type: 'oyechats:preview-config', payload },
                    apiOrigin,
                );
            } catch (error) {
                console.warn('[BotSettings] Failed to post preview config:', error);
            }
        }, 150);
        return () => clearTimeout(timer);
    }, [websitePreviewOpen, previewReady, buildPreviewPayload]);

    const handleLoadPreview = () => {
        const trimmed = previewUrlInput.trim();
        if (!trimmed) return;
        setLoadedPreviewUrl(trimmed);
    };

    const previewIframeSrc = loadedPreviewUrl && selectedBot?.bot_key
        ? getBotPreviewUrl(selectedBot.bot_key, loadedPreviewUrl, { edit: true })
        : null;

    // ── Tab config (computed per render so plan upgrades take effect live) ──
    const TABS = useMemo(() => [
        { id: 'general', label: 'General' },
        { id: 'personality', label: 'AI & Personality' },
        { id: 'appearance', label: 'Appearance' },
        { id: 'messages', label: 'Messages' },
        { id: 'behavior', label: 'Behavior', locked: advancedLocked, intent: 'widget_behavior' },
        { id: 'leads', label: 'Leads', locked: leadFormLocked, intent: 'leads_form' },
        { id: 'live_chat', label: 'Live Chat', locked: !liveChatAllowed, intent: 'live_chat_appearance' },
    ], [advancedLocked, leadFormLocked, liveChatAllowed]);

    // If the active tab just became locked (Behavior / Leads / Live Chat gate
    // on Free), bounce the user back to General.
    useEffect(() => {
        if ((activeTab === 'behavior' && advancedLocked) ||
            (activeTab === 'leads' && leadFormLocked) ||
            (activeTab === 'live_chat' && !liveChatAllowed)) {
            setActiveTab('general');
        }
    }, [activeTab, advancedLocked, leadFormLocked, liveChatAllowed]);

    const handleTabClick = (tab) => {
        // Locked tabs never become active — they open the upgrade modal so the
        // customer sees a polished upsell rather than a backend 403 on save.
        if (tab.locked) {
            requestUpgrade(tab.intent || 'leads_form');
            return;
        }
        setActiveTab(tab.id);
    };

    // ── Avatar upload handlers (shared by AppearanceTab) ──
    const handleFile = useCallback((file) => {
        if (!isBotManager || !file) return;
        if (!file.type.startsWith('image/')) {
            showToast('error', 'Please upload an image file.');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            setCropImage(reader.result);
            setCropFileName(file.name);
            setCrop({ x: 0, y: 0 });
            setZoom(1);
            setRotation(0);
            setShowCropModal(true);
        };
        reader.readAsDataURL(file);
    }, [isBotManager, showToast]);

    const handleCropConfirm = async () => {
        if (!isBotManager || !croppedAreaPixels || !cropImage) return;
        setShowCropModal(false);
        setIsUploading(true);
        try {
            const croppedBlob = await getCroppedImg(cropImage, croppedAreaPixels, rotation);
            const croppedFile = new File([croppedBlob], cropFileName || 'avatar.png', { type: 'image/png' });
            const result = await uploadLogo(croppedFile);
            setDraft((prev) => ({ ...prev, bot_logo: result.url, launcher_logo: result.url }));
        } catch (error) {
            console.error('Error uploading logo:', error);
            showToast('error', 'Failed to upload logo: ' + (error.detail || error.message || error));
        } finally {
            setIsUploading(false);
            setCropImage(null);
        }
    };

    const handleRemoveLogo = useCallback(() => {
        if (!isBotManager) return;
        setDraft((prev) => ({ ...prev, bot_logo: null, launcher_logo: null }));
    }, [isBotManager]);

    // ── Save ──
    const handleSave = async () => {
        if (!isBotManager) return;
        setIsSaving(true);
        setSaveError(null);
        try {
            const payload = {
                bot_name: draft.bot_name,
                bot_logo: draft.bot_logo,
                launcher_name: draft.launcher_name,
                launcher_logo: draft.launcher_logo,
                primary_color: draft.primary_color,
                user_bubble_color: draft.user_bubble_color,
                background_color: '#ffffff',
                bant_enabled: draft.bant_enabled,
                avatar_type: draft.avatar_type,
                orb_color: draft.orb_color || null,
                lead_form_enabled: draft.lead_form_enabled,
                lead_form_fields: draft.lead_form_fields,
                notification_email: draft.notification_emails[0] || null,
                notification_emails: draft.notification_emails.length > 0 ? { default: draft.notification_emails } : null,
                email_on_qualified: draft.email_on_qualified,
                email_on_handoff: draft.email_on_handoff,
                live_chat_enabled: draft.live_chat_enabled,
                welcome_title: draft.welcome_title,
                welcome_subtitle: draft.welcome_subtitle,
                waiting_message: draft.waiting_message,
                offline_message: draft.offline_message,
                handoff_delay_seconds: draft.handoff_delay_seconds,
                widget_messages: draft.widget_messages,
                widget_config: draft.widget_config,
                relevance_threshold: draft.relevance_threshold,
                branding_text: draft.branding_text,
                branding_url: draft.branding_url,
                // Save services as objects with trimmed name + URL. Drop blank
                // rows so an empty placeholder doesn't end up in the prompt.
                services: draft.services
                    .map((s) => ({
                        name: (s?.name || '').trim(),
                        url: (s?.url || '').trim() || null,
                    }))
                    .filter((s) => s.name !== ''),
                services_url: (draft.services_url || '').trim() || null,
                // ── Absorbed configs (sub-project 1 gap closure) ──
                system_prompt: draft.system_prompt || null,
                brand_tone: draft.brand_tone || null,
                brand_tone_preset: draft.brand_tone_preset || null,
                company_name: draft.company_name || null,
                company_description: draft.company_description || null,
                feature_flags: draft.feature_flags,
                live_chat_queue_timeout_seconds: draft.live_chat_queue_timeout_seconds,
                live_chat_max_queue_size: draft.live_chat_max_queue_size,
            };
            await updateClientSettings(payload, selectedBot?.id);
            // Re-pull so the crawl auto-fill lock state (manual_field_overrides)
            // and any crawl-written values reflect the just-saved reality.
            await fetchSettings();
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (error) {
            console.error('Error saving settings:', error);
            const msg = typeof error === 'string' ? error : error?.detail || error?.message || 'Failed to save settings';
            setSaveError(msg);
            setTimeout(() => setSaveError(null), 5000);
        } finally {
            setIsSaving(false);
        }
    };

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Bot Settings" description="Create a chatbot first, then configure its personality, appearance, and behavior here." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    const tabProps = { draft, set, ent };

    // Page-level actions rendered in the contextual app bar (PageHeader
    // `actions`). Defined as elements so the Save-button markup lives once.
    const previewButton = (
        <button
            type="button"
            onClick={() => setWebsitePreviewOpen((v) => !v)}
            className="inline-flex items-center gap-2 px-3 h-9 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-700 dark:text-surface-200 text-sm font-medium hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
        >
            <Sparkles className="w-4 h-4 text-primary-500" />
            {websitePreviewOpen ? 'Hide website preview' : 'Preview on my website'}
        </button>
    );

    const saveButton = (
        <button
            onClick={handleSave}
            disabled={!isBotManager || isSaving || saved}
            className={`group relative flex items-center gap-2 px-5 h-10 rounded-xl shadow-sm transition-all font-medium text-sm disabled:opacity-70 overflow-hidden ${saved
                ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                : 'bg-primary-600 hover:bg-primary-700 text-white'
                }`}
        >
            <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
            {saved ? (
                <>
                    <CheckCircle className="w-4 h-4 relative z-10" />
                    <span className="relative z-10">Saved!</span>
                </>
            ) : isSaving ? (
                <>
                    <RefreshCw className="w-4 h-4 relative z-10 animate-spin" />
                    <span className="relative z-10">Saving...</span>
                </>
            ) : (
                <>
                    <CheckCircle className="w-4 h-4 relative z-10" />
                    <span className="relative z-10">Save Configuration</span>
                </>
            )}
        </button>
    );

    return (
        <div className="max-w-6xl mx-auto space-y-6 animate-fade-in pb-20 -mt-2">
            {/* Error Toast */}
            {saveError && (
                <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-5 py-3 rounded-xl shadow-lg border bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/20 text-rose-600 dark:text-rose-400 animate-fade-in">
                    <AlertCircle size={18} />
                    <span className="text-sm font-medium">{saveError}</span>
                    <button onClick={() => setSaveError(null)} className="ml-2 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
                        <X size={14} />
                    </button>
                </div>
            )}

            {/* Contextual app-bar header. Published unconditionally: this editor
                is mounted inside Chatbot's Appearance tab, so it owns the top-bar
                breadcrumb (Home › My Bots › Bot Settings) plus the Save + Preview
                actions in the sticky action row. */}
            <PageHeader
                crumbs={[{ label: 'Home', to: '/' }, { label: 'My Bots', to: '/chatbot' }, { label: 'Bot Settings' }]}
                title="Bot Settings"
                actions={<>{previewButton}{saveButton}</>}
            />

            {/* Read-only access note — preserved from the old hero for viewers
                who can't edit this bot. */}
            {!isBotManager && (
                <p className="text-sm text-surface-500 dark:text-surface-400">
                    You have read-only access to this bot configuration.
                </p>
            )}

            {/* Live website preview panel */}
            {websitePreviewOpen && (
                <div className="rounded-2xl border border-surface-200 dark:border-surface-700 bg-[var(--bg-card)] dark:bg-surface-900 p-4 shadow-sm animate-fade-in">
                    <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                        <div className="flex-1">
                            <label className="block text-[12px] font-semibold text-surface-600 dark:text-surface-300 mb-1">
                                Your website URL
                            </label>
                            <input
                                type="url"
                                value={previewUrlInput}
                                onChange={(e) => setPreviewUrlInput(e.target.value)}
                                placeholder="https://yourcompany.com"
                                className="w-full h-10 px-3 rounded-lg border border-surface-200 dark:border-surface-700 bg-[var(--bg-card)] dark:bg-surface-900 text-sm text-surface-900 dark:text-surface-100 focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)]"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={handleLoadPreview}
                            disabled={!previewUrlInput.trim() || !selectedBot?.bot_key}
                            className="sm:self-end h-10 px-4 rounded-lg bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {loadedPreviewUrl ? 'Reload' : 'Load preview'}
                        </button>
                    </div>
                    {previewIframeSrc && (
                        <div className="mt-3">
                            <p className="text-[12px] text-surface-500 dark:text-surface-400 mb-2">
                                Changes you make above apply to the widget inside this preview in real time — no save needed. If the site blocks embedding, a fallback page appears; your changes still apply on your real site once you save.
                            </p>
                            <iframe
                                ref={previewIframeRef}
                                key={previewIframeSrc}
                                src={previewIframeSrc}
                                title="Website preview with chat widget"
                                className="w-full h-[560px] rounded-xl border border-surface-200 dark:border-surface-700 bg-white"
                                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                            />
                        </div>
                    )}
                </div>
            )}

            {/* Tab Navigation Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-surface-200 dark:border-surface-700 w-full">
                <div className="flex items-center gap-1 bg-surface-100 dark:bg-surface-800 p-1 rounded-xl w-full max-w-4xl overflow-x-auto no-scrollbar">
                    {TABS.map((tab) => {
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => handleTabClick(tab)}
                                aria-disabled={tab.locked ? 'true' : undefined}
                                title={tab.locked ? 'Available on Starter and above' : undefined}
                                className={`flex-1 min-w-max px-3 py-2 text-[12px] rounded-lg transition-all inline-flex items-center justify-center gap-1.5 ${isActive && !tab.locked
                                    ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-100 shadow-sm font-semibold'
                                    : tab.locked
                                        ? 'text-surface-400 dark:text-surface-500 font-medium hover:text-surface-600 dark:hover:text-surface-300'
                                        : 'text-surface-500 dark:text-surface-400 font-medium hover:text-surface-700 dark:hover:text-surface-200'
                                    }`}
                            >
                                <span>{tab.label}</span>
                                {tab.locked && (
                                    <span
                                        className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-600 leading-none dark:bg-amber-500/15 dark:text-amber-400"
                                        aria-hidden="true"
                                    >
                                        <Lock size={11} strokeWidth={2.4} className="block" />
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex flex-col lg:flex-row gap-8 items-start w-full">
                {/* Left Side: 60% Configuration Column */}
                <div className="w-full lg:w-[60%] flex flex-col gap-10 lg:pr-6">
                    {activeTab === 'general' && <GeneralTab {...tabProps} />}
                    {activeTab === 'personality' && (
                        <PersonalityTab
                            {...tabProps}
                            brandTonePresets={brandTonePresets}
                            onDetectTone={handleDetectTone}
                            detectingTone={detectingTone}
                            onPreviewTone={handleTonePreview}
                            previewingTone={previewingTone}
                            tonePreviewSample={tonePreviewSample}
                            canDetectTone={Boolean(selectedBot?.website)}
                            isBotManager={isBotManager}
                        />
                    )}
                    {activeTab === 'appearance' && (
                        <AppearanceTab
                            {...tabProps}
                            isUploading={isUploading}
                            onFile={handleFile}
                            onRemoveLogo={handleRemoveLogo}
                        />
                    )}
                    {activeTab === 'messages' && <MessagesTab {...tabProps} isSaving={isSaving} />}
                    {activeTab === 'behavior' && <BehaviorTab {...tabProps} advancedLocked={advancedLocked} requestUpgrade={requestUpgrade} />}
                    {activeTab === 'leads' && <LeadsTab {...tabProps} requestUpgrade={requestUpgrade} />}
                    {activeTab === 'live_chat' && <LiveChatTab {...tabProps} />}
                </div>

                {/* Right Side: 40% Live Preview Column (Sticky) */}
                <div className="lg:w-[40%] flex flex-col items-center sticky top-8 self-start animate-fade-in" style={{ animationDelay: '0.15s' }}>
                    <div className="flex items-center justify-between w-full max-w-[380px] mb-3 px-2">
                        <span className="text-[11px] font-black uppercase tracking-widest text-surface-400">Live Preview</span>
                        <div className="flex gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-red-400/30" />
                            <div className="w-2 h-2 rounded-full bg-amber-400/30" />
                            <div className="w-2 h-2 rounded-full bg-green-400/30" />
                        </div>
                    </div>

                    {/* Preview State Tabs */}
                    <div className="flex gap-1 bg-surface-100 dark:bg-surface-800 p-1 rounded-lg w-full max-w-[380px] mb-3">
                        {[
                            { key: 'chat', label: 'Chat' },
                            { key: 'waiting', label: 'Waiting' },
                            { key: 'unavailable', label: 'Unavailable' },
                        ].map(({ key, label }) => (
                            <button
                                key={key}
                                onClick={() => setPreviewState(key)}
                                className={`flex-1 py-1.5 text-[11px] font-semibold rounded-md transition-all ${previewState === key ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-100 shadow-sm' : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    {/* Live widget mock — extracted to WidgetChatPreview so Bot
                        Settings and the Build Studio render pixel-identically and
                        both stay pinned to the real widget. `live_chat_allowed`
                        carries the plan entitlement so the handoff affordance keeps
                        the same lock behaviour it had inline. */}
                    <WidgetChatPreview
                        settings={{ ...draft, live_chat_allowed: liveChatAllowed }}
                        state={previewState}
                    />
                </div>
            </div>

            {/* Crop Modal */}
            {showCropModal && cropImage && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-surface-900/70 backdrop-blur-sm animate-fade-in">
                    <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl shadow-2xl w-full max-w-md border border-surface-200 dark:border-surface-700 overflow-hidden">
                        {/* Header */}
                        <div className="px-5 py-4 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
                            <div>
                                <h3 className="text-base font-bold text-surface-900 dark:text-surface-100">Crop Avatar</h3>
                                <p className="text-[11px] text-surface-400 dark:text-surface-500 mt-0.5">Drag to reposition, scroll to zoom</p>
                            </div>
                            <button
                                onClick={() => { setShowCropModal(false); setCropImage(null); }}
                                className="p-1.5 rounded-lg text-surface-400 hover:text-surface-600 dark:hover:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Crop Area */}
                        <div className="relative w-full h-64 bg-surface-900">
                            <Cropper
                                image={cropImage}
                                crop={crop}
                                zoom={zoom}
                                rotation={rotation}
                                aspect={1}
                                cropShape="round"
                                showGrid={false}
                                onCropChange={setCrop}
                                onZoomChange={setZoom}
                                onCropComplete={onCropComplete}
                            />
                        </div>

                        {/* Controls */}
                        <div className="px-5 py-4 space-y-3">
                            {/* Zoom */}
                            <div className="flex items-center gap-3">
                                <ZoomOut size={14} className="text-surface-400 flex-shrink-0" />
                                <input
                                    type="range"
                                    min={1}
                                    max={3}
                                    step={0.05}
                                    value={zoom}
                                    onChange={(e) => setZoom(Number(e.target.value))}
                                    className="flex-1 h-1.5 bg-surface-200 dark:bg-surface-700 rounded-full appearance-none cursor-pointer accent-primary-500"
                                />
                                <ZoomIn size={14} className="text-surface-400 flex-shrink-0" />
                            </div>

                            {/* Rotate */}
                            <div className="flex items-center gap-3">
                                <RotateCw size={14} className="text-surface-400 flex-shrink-0" />
                                <input
                                    type="range"
                                    min={0}
                                    max={360}
                                    step={1}
                                    value={rotation}
                                    onChange={(e) => setRotation(Number(e.target.value))}
                                    className="flex-1 h-1.5 bg-surface-200 dark:bg-surface-700 rounded-full appearance-none cursor-pointer accent-primary-500"
                                />
                                <span className="text-[11px] font-mono text-surface-400 w-8 text-right">{rotation}°</span>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="px-5 py-3 border-t border-surface-200 dark:border-surface-700 flex items-center justify-end gap-3">
                            <button
                                onClick={() => { setShowCropModal(false); setCropImage(null); }}
                                className="px-4 py-2 text-sm font-medium text-surface-600 dark:text-surface-300 bg-surface-100 dark:bg-surface-800 hover:bg-surface-200 dark:hover:bg-surface-600 rounded-xl transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCropConfirm}
                                className="px-4 py-2 text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 rounded-xl shadow-lg shadow-primary-500/25 transition-all flex items-center gap-2"
                            >
                                <Check size={14} />
                                Apply &amp; Upload
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
