import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Copy, Loader2, Pencil, Plus, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Tabs from '../components/ui/Tabs';
import EmptyState from '../components/ui/EmptyState';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import {
    createWebhook,
    deleteWebhook,
    getWebhookDeliveries,
    getWebhooks,
    testWebhook,
    updateWebhook,
} from '../services/api';

const EVENT_OPTIONS = [
    'tier_transition',
    'lead_captured',
    'handoff_requested',
    'chat_closed',
    'meeting_booked',
];

const tabs = [
    { id: 'webhooks', label: 'Webhooks', icon: WebhookIcon },
    { id: 'delivery-log', label: 'Delivery Log', icon: Activity },
];

const truncate = (value, max = 64) => (value.length > max ? `${value.slice(0, max)}...` : value);

const badgeClassByStatus = (statusCode) => {
    if (statusCode >= 200 && statusCode < 300) return 'bg-green-100 text-green-700';
    return 'bg-red-100 text-red-700';
};

function Toggle({ checked, onChange, disabled = false }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out disabled:cursor-not-allowed disabled:opacity-50 ${
                checked ? 'bg-primary-600' : 'bg-secondary-200'
            }`}
        >
            <span
                aria-hidden="true"
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    checked ? 'translate-x-4' : 'translate-x-0'
                }`}
            />
        </button>
    );
}

export default function Webhooks() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();

    const [activeTab, setActiveTab] = useState('webhooks');
    const [webhooks, setWebhooks] = useState([]);
    const [loadingWebhooks, setLoadingWebhooks] = useState(true);
    const [savingWebhookId, setSavingWebhookId] = useState(null);

    const [showModal, setShowModal] = useState(false);
    const [editingWebhook, setEditingWebhook] = useState(null);
    const [formUrl, setFormUrl] = useState('');
    const [formEvents, setFormEvents] = useState(['tier_transition', 'lead_captured']);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [newSecret, setNewSecret] = useState('');

    const [selectedWebhookId, setSelectedWebhookId] = useState(null);
    const [deliveries, setDeliveries] = useState([]);
    const [deliveryTotal, setDeliveryTotal] = useState(0);
    const [deliveryPage, setDeliveryPage] = useState(1);
    const [loadingDeliveries, setLoadingDeliveries] = useState(false);

    useEffect(() => {
        const load = async () => {
            if (!selectedBot?.id) return;
            setLoadingWebhooks(true);
            try {
                const data = await getWebhooks(selectedBot.id);
                setWebhooks(data || []);
                setSelectedWebhookId((current) => current || data?.[0]?.id || null);
            } catch (error) {
                showToast('error', error.message || 'Failed to load webhooks');
                setWebhooks([]);
            } finally {
                setLoadingWebhooks(false);
            }
        };
        load();
    }, [selectedBot?.id, showToast]);

    useEffect(() => {
        const loadDeliveries = async () => {
            if (!selectedWebhookId) {
                setDeliveries([]);
                setDeliveryTotal(0);
                return;
            }
            setLoadingDeliveries(true);
            try {
                const data = await getWebhookDeliveries(selectedWebhookId, deliveryPage);
                setDeliveries(data.deliveries || []);
                setDeliveryTotal(data.total || 0);
            } catch (error) {
                showToast('error', error.message || 'Failed to load delivery log');
            } finally {
                setLoadingDeliveries(false);
            }
        };
        loadDeliveries();
    }, [selectedWebhookId, deliveryPage, showToast]);

    const openCreateModal = () => {
        setEditingWebhook(null);
        setFormUrl('');
        setFormEvents(['tier_transition', 'lead_captured']);
        setNewSecret('');
        setShowModal(true);
    };

    const openEditModal = (webhook) => {
        setEditingWebhook(webhook);
        setFormUrl(webhook.url);
        setFormEvents(webhook.events || []);
        setNewSecret('');
        setShowModal(true);
    };

    const closeModal = () => {
        setShowModal(false);
        setEditingWebhook(null);
        setFormUrl('');
        setFormEvents(['tier_transition', 'lead_captured']);
    };

    const toggleEvent = (eventType) => {
        setFormEvents((prev) =>
            prev.includes(eventType) ? prev.filter((item) => item !== eventType) : [...prev, eventType]
        );
    };

    const submitWebhook = async () => {
        if (!selectedBot?.id || !formUrl.trim() || formEvents.length === 0) {
            showToast('error', 'URL and at least one event are required');
            return;
        }

        setIsSubmitting(true);
        try {
            if (editingWebhook) {
                await updateWebhook(editingWebhook.id, { url: formUrl.trim(), events: formEvents });
                showToast('success', 'Webhook updated');
                closeModal();
            } else {
                const created = await createWebhook(selectedBot.id, { url: formUrl.trim(), events: formEvents, is_active: true });
                setNewSecret(created.secret || '');
                showToast('success', 'Webhook created');
            }
            const refreshed = await getWebhooks(selectedBot.id);
            setWebhooks(refreshed || []);
            setSelectedWebhookId((current) => current || refreshed?.[0]?.id || null);
        } catch (error) {
            showToast('error', error.message || 'Failed to save webhook');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleToggleActive = async (webhook, nextValue) => {
        setSavingWebhookId(webhook.id);
        setWebhooks((prev) => prev.map((item) => (item.id === webhook.id ? { ...item, is_active: nextValue } : item)));
        try {
            await updateWebhook(webhook.id, { is_active: nextValue });
        } catch (error) {
            setWebhooks((prev) => prev.map((item) => (item.id === webhook.id ? { ...item, is_active: webhook.is_active } : item)));
            showToast('error', error.message || 'Failed to update webhook');
        } finally {
            setSavingWebhookId(null);
        }
    };

    const handleDelete = async (webhookId) => {
        try {
            await deleteWebhook(webhookId);
            showToast('success', 'Webhook deleted');
            const refreshed = await getWebhooks(selectedBot.id);
            setWebhooks(refreshed || []);
            if (selectedWebhookId === webhookId) {
                setSelectedWebhookId(refreshed?.[0]?.id || null);
                setDeliveryPage(1);
            }
        } catch (error) {
            showToast('error', error.message || 'Failed to delete webhook');
        }
    };

    const handleTest = async (webhookId) => {
        try {
            await testWebhook(webhookId);
            showToast('success', 'Test event dispatched');
        } catch (error) {
            showToast('error', error.message || 'Failed to dispatch test event');
        }
    };

    const copySecret = async () => {
        if (!newSecret) return;
        try {
            await navigator.clipboard.writeText(newSecret);
            showToast('success', 'Secret copied');
        } catch {
            showToast('error', 'Failed to copy secret');
        }
    };

    const totalPages = useMemo(() => Math.max(1, Math.ceil(deliveryTotal / 50)), [deliveryTotal]);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Webhooks" description="Create a chatbot first to configure webhook events." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    return (
        <div className="space-y-4 animate-fade-in">
            <PageHeader title="Webhooks" subtitle="Push lead and qualification events to your CRM or backend">
                <button
                    onClick={openCreateModal}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Add Webhook
                </button>
            </PageHeader>

            <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'webhooks' && (
                <div className="bg-white border border-secondary-200 rounded-2xl p-5">
                    {loadingWebhooks ? (
                        <div className="flex items-center gap-2 text-secondary-500">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Loading webhooks...
                        </div>
                    ) : webhooks.length === 0 ? (
                        <p className="text-sm text-secondary-500">No webhooks configured for this bot yet.</p>
                    ) : (
                        <div className="space-y-3">
                            {webhooks.map((webhook) => (
                                <div key={webhook.id} className="border border-secondary-200 rounded-xl p-4">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="space-y-2 flex-1 min-w-0">
                                            <p className="text-sm font-semibold text-secondary-900" title={webhook.url}>
                                                {truncate(webhook.url, 96)}
                                            </p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {(webhook.events || []).map((eventType) => (
                                                    <span key={eventType} className="px-2 py-0.5 rounded-full text-[11px] bg-secondary-100 text-secondary-700">
                                                        {eventType}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 flex-shrink-0">
                                            <Toggle
                                                checked={webhook.is_active}
                                                disabled={savingWebhookId === webhook.id}
                                                onChange={(nextValue) => handleToggleActive(webhook, nextValue)}
                                            />
                                            <button
                                                onClick={() => openEditModal(webhook)}
                                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-secondary-200 text-secondary-700 hover:bg-secondary-50"
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                                Edit
                                            </button>
                                            <button
                                                onClick={() => handleTest(webhook.id)}
                                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-200 text-blue-700 hover:bg-blue-50"
                                            >
                                                <Send className="w-3.5 h-3.5" />
                                                Test
                                            </button>
                                            <button
                                                onClick={() => handleDelete(webhook.id)}
                                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 text-red-700 hover:bg-red-50"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'delivery-log' && (
                <div className="bg-white border border-secondary-200 rounded-2xl p-5 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                        <select
                            value={selectedWebhookId || ''}
                            onChange={(e) => {
                                setSelectedWebhookId(e.target.value ? Number(e.target.value) : null);
                                setDeliveryPage(1);
                            }}
                            className="text-sm border border-secondary-200 rounded-lg px-3 py-2 bg-white text-secondary-900 focus:outline-none focus:border-primary-500"
                        >
                            <option value="">Select webhook</option>
                            {webhooks.map((webhook) => (
                                <option key={webhook.id} value={webhook.id}>
                                    {truncate(webhook.url, 70)}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={() => selectedWebhookId && getWebhookDeliveries(selectedWebhookId, deliveryPage).then((data) => {
                                setDeliveries(data.deliveries || []);
                                setDeliveryTotal(data.total || 0);
                            }).catch((error) => showToast('error', error.message || 'Failed to refresh log'))}
                            disabled={!selectedWebhookId || loadingDeliveries}
                            className="px-3 py-2 text-sm rounded-lg border border-secondary-200 text-secondary-700 hover:bg-secondary-50 disabled:opacity-50"
                        >
                            Refresh
                        </button>
                    </div>

                    {!selectedWebhookId ? (
                        <p className="text-sm text-secondary-500">Choose a webhook to view delivery attempts.</p>
                    ) : loadingDeliveries ? (
                        <div className="flex items-center gap-2 text-secondary-500">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Loading delivery log...
                        </div>
                    ) : deliveries.length === 0 ? (
                        <p className="text-sm text-secondary-500">No deliveries yet.</p>
                    ) : (
                        <>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-secondary-100">
                                            <th className="text-left py-2.5 text-[11px] uppercase tracking-wider text-secondary-500">Event</th>
                                            <th className="text-left py-2.5 text-[11px] uppercase tracking-wider text-secondary-500">Status</th>
                                            <th className="text-left py-2.5 text-[11px] uppercase tracking-wider text-secondary-500">Attempt</th>
                                            <th className="text-left py-2.5 text-[11px] uppercase tracking-wider text-secondary-500">Created</th>
                                            <th className="text-left py-2.5 text-[11px] uppercase tracking-wider text-secondary-500">Delivered</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {deliveries.map((item) => (
                                            <tr key={item.id} className="border-b border-secondary-50">
                                                <td className="py-2.5 text-secondary-800">{item.event_type}</td>
                                                <td className="py-2.5">
                                                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${badgeClassByStatus(item.status_code || 0)}`}>
                                                        {item.status_code || 0}
                                                    </span>
                                                </td>
                                                <td className="py-2.5 text-secondary-700">{item.attempt}</td>
                                                <td className="py-2.5 text-secondary-600">
                                                    {item.created_at ? new Date(item.created_at).toLocaleString() : '—'}
                                                </td>
                                                <td className="py-2.5 text-secondary-600">
                                                    {item.delivered_at
                                                        ? new Date(item.delivered_at).toLocaleString()
                                                        : item.next_retry_at
                                                          ? `Pending retry (${new Date(item.next_retry_at).toLocaleString()})`
                                                          : 'Pending retry'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            <div className="flex items-center justify-between pt-2">
                                <p className="text-xs text-secondary-500">
                                    Page {deliveryPage} of {totalPages}
                                </p>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => setDeliveryPage((prev) => Math.max(1, prev - 1))}
                                        disabled={deliveryPage <= 1}
                                        className="px-3 py-1.5 text-xs rounded-md border border-secondary-200 text-secondary-700 hover:bg-secondary-50 disabled:opacity-50"
                                    >
                                        Previous
                                    </button>
                                    <button
                                        onClick={() => setDeliveryPage((prev) => Math.min(totalPages, prev + 1))}
                                        disabled={deliveryPage >= totalPages}
                                        className="px-3 py-1.5 text-xs rounded-md border border-secondary-200 text-secondary-700 hover:bg-secondary-50 disabled:opacity-50"
                                    >
                                        Next
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            )}

            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
                    <div className="absolute inset-0 bg-black/30" onClick={closeModal} />
                    <div className="relative w-full max-w-xl rounded-2xl bg-white border border-secondary-200 shadow-2xl p-6 space-y-4">
                        <h2 className="text-lg font-bold text-secondary-900">
                            {editingWebhook ? 'Edit Webhook' : 'Add Webhook'}
                        </h2>

                        <div className="space-y-2">
                            <label className="text-xs font-bold uppercase tracking-wider text-secondary-500">Endpoint URL</label>
                            <input
                                type="url"
                                value={formUrl}
                                onChange={(e) => setFormUrl(e.target.value)}
                                placeholder="https://your-crm.com/webhooks/oyechats"
                                className="w-full px-3 py-2.5 rounded-lg border border-secondary-200 text-sm focus:outline-none focus:border-primary-500"
                                disabled={isSubmitting || !!newSecret}
                            />
                        </div>

                        <div className="space-y-2">
                            <p className="text-xs font-bold uppercase tracking-wider text-secondary-500">Events</p>
                            <div className="grid sm:grid-cols-2 gap-2">
                                {EVENT_OPTIONS.map((eventType) => (
                                    <label key={eventType} className="flex items-center gap-2 text-sm text-secondary-800">
                                        <input
                                            type="checkbox"
                                            checked={formEvents.includes(eventType)}
                                            onChange={() => toggleEvent(eventType)}
                                            disabled={isSubmitting || !!newSecret}
                                        />
                                        {eventType}
                                    </label>
                                ))}
                            </div>
                        </div>

                        {newSecret && (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2">
                                <p className="text-xs font-semibold text-amber-800">Save this secret - it won&apos;t be shown again</p>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        readOnly
                                        value={newSecret}
                                        className="flex-1 px-3 py-2 text-xs rounded-lg border border-amber-200 bg-white text-secondary-800"
                                    />
                                    <button
                                        onClick={copySecret}
                                        className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium rounded-lg border border-amber-300 text-amber-800 hover:bg-amber-100"
                                    >
                                        <Copy className="w-3.5 h-3.5" />
                                        Copy
                                    </button>
                                </div>
                                <div className="flex items-center gap-1.5 text-xs text-green-700">
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    Webhook created successfully.
                                </div>
                            </div>
                        )}

                        <div className="flex items-center justify-end gap-2">
                            <button
                                onClick={closeModal}
                                className="px-4 py-2 rounded-lg border border-secondary-200 text-secondary-700 text-sm hover:bg-secondary-50"
                            >
                                {newSecret ? 'Done' : 'Cancel'}
                            </button>
                            {!newSecret && (
                                <button
                                    onClick={submitWebhook}
                                    disabled={isSubmitting}
                                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-60"
                                >
                                    {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                                    Save
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
