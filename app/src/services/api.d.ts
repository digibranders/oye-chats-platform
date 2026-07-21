/**
 * Type shim for the legacy JS API client (`services/api.js`).
 * The `.js` stays the runtime source; this only supplies types to new TS code.
 * Only the exports the new app consumes are declared — widen as needed.
 */
import type {
  ActivityPoint,
  Bot,
  CannedResponse,
  CannedResponsesResult,
  ChatMessage,
  CrawlDiscovery,
  CurrentUser,
  Department,
  KnowledgeSource,
  Lead,
  LeadsQuery,
  LeadsResult,
  OfflineMessagesResult,
  Operator,
  OperatorInvite,
  OperatorInviteCreated,
  OperatorStatus,
  SelfOperatorResult,
  SourcePagesResult,
  TopQuestion,
  Webhook,
  WebhookDeliveriesResult,
  Workspace,
} from '../types/domain';

// ── Agents (bots) ────────────────────────────────────────────────────────────
export function createBot(data: { name: string; website?: string; system_prompt?: string }): Promise<Bot>;
export function updateBot(botId: number, data: Record<string, unknown>): Promise<Bot>;
export function getBot(botId: number): Promise<Bot>;
export function getBots(): Promise<Bot[]>;
export function deleteBot(botId: number): Promise<Record<string, unknown>>;
export function getFrameworkPresets(botId: number): Promise<Record<string, unknown>>;

/** Absolute URL of the hosted demo page for a bot. */
export function getBotDemoUrl(botKey: string): string;
/** Absolute URL of the demo page with an optional overlay website + edit mode. */
export function getBotPreviewUrl(
  botKey: string,
  websiteUrl?: string,
  opts?: { edit?: boolean },
): string;

// ── Knowledge / crawl ────────────────────────────────────────────────────────
export function discoverCrawlUrls(url: string, botId?: number): Promise<CrawlDiscovery>;
export function getDocuments(botId?: number): Promise<KnowledgeSource[]>;
export function getDocumentPages(source: string, botId?: number): Promise<SourcePagesResult>;
export function deleteDocument(documentName: string, botId?: number): Promise<Record<string, unknown>>;

export function getSeedQuestions(botId: number): Promise<string[]>;
export function previewChatStream(
  botId: number,
  question: string,
  sessionId?: string | null,
  handlers?: {
    onChunk?: (text: string) => void;
    onFinal?: (meta: unknown) => void;
    onError?: (err: unknown) => void;
  },
): Promise<void>;

export function getClientSettings(botId?: number): Promise<Record<string, unknown>>;
export function updateClientSettings(
  settings: Record<string, unknown>,
  botId?: number,
): Promise<Record<string, unknown>>;
export function uploadLogo(file: File): Promise<{ url: string }>;
export function uploadDocuments(files: File[], botId?: number): Promise<unknown>;

// ── Onboarding / activation ──────────────────────────────────────────────────
export function completeOnboarding(): Promise<Record<string, unknown> | null>;
export function recordActivationEvent(
  eventType: string,
  opts?: { botId?: number | null; eventData?: unknown },
): Promise<void>;

// ── Identity / workspace ─────────────────────────────────────────────────────
export function getCurrentUser(): Promise<CurrentUser>;
export function getMyWorkspaces(): Promise<{ workspaces: Workspace[] }>;
/**
 * Update the authenticated client's display name. Email changes go through the
 * separate password-confirmed flow (requestClientEmailChange / confirm…).
 */
export function updateClientProfile(patch: {
  name?: string;
}): Promise<{ id: number; name: string; email: string; pending_email: string | null }>;

// ── Dashboard / analytics ────────────────────────────────────────────────────
export function getDashboardStats(botId?: number, days?: number | null): Promise<Record<string, unknown>>;
export function getActivityStats(botId?: number): Promise<ActivityPoint[]>;
export function getTopQuestions(botId?: number): Promise<TopQuestion[]>;
export function getRatingsSummary(botId?: number): Promise<Record<string, unknown>>;
export function getResolutionSummary(botId?: number): Promise<Record<string, unknown>>;
export function getFeedbackData(botId?: number): Promise<Array<Record<string, unknown>>>;
export function getVisitorsData(botId?: number): Promise<Array<Record<string, unknown>>>;
export function getChatHistory(
  sessionId: string,
  options?: { beforeId?: number; limit?: number },
): Promise<ChatMessage[]>;
export function getQualificationFunnel(botId: number, period?: string): Promise<Record<string, unknown>>;

// ── Leads ────────────────────────────────────────────────────────────────────
export function getLeads(botId?: number, params?: LeadsQuery): Promise<LeadsResult>;
export function getLeadDetail(sessionId: string): Promise<Lead & { messages?: ChatMessage[] }>;
export function getLeadStats(botId?: number): Promise<Record<string, unknown>>;
/** Downloads a CSV of leads (triggers a browser download; resolves to void). */
export function exportLeadsCsv(botId?: number): Promise<void>;
export function markLeadViewed(sessionId: string): Promise<void>;
export function markAllLeadsViewed(botId?: number): Promise<void>;

// ── Inbox / offline messages ─────────────────────────────────────────────────
export function getOfflineMessages(params?: Record<string, unknown>): Promise<OfflineMessagesResult>;
export function updateOfflineMessage(
  messageId: number,
  data: Record<string, unknown>,
): Promise<{ success: boolean; status?: string }>;
export function deleteOfflineMessage(messageId: number): Promise<{ success: boolean }>;

// ── Canned responses (quick replies) ─────────────────────────────────────────
export function getCannedResponses(category?: string | null): Promise<CannedResponsesResult>;
export function createCannedResponse(data: {
  title: string;
  content: string;
  shortcut?: string;
  category?: string | null;
}): Promise<CannedResponse>;
export function updateCannedResponse(
  responseId: number,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>>;
export function deleteCannedResponse(responseId: number): Promise<{ success: boolean }>;

// ── Operator self-status ─────────────────────────────────────────────────────
export function getMyOperatorStatus(opts?: { botId?: number }): Promise<OperatorStatus | null>;
export function toggleOperatorStatus(opts?: { isOnline?: boolean; botId?: number }): Promise<Record<string, unknown>>;

// ── Team: operators ──────────────────────────────────────────────────────────
export function getOperators(): Promise<Operator[]>;
export function createOperator(data: Record<string, unknown>): Promise<Operator>;
export function updateOperator(operatorId: number, data: Record<string, unknown>): Promise<Operator>;
export function deleteOperator(operatorId: number): Promise<Record<string, unknown>>;

// ── Team: departments ────────────────────────────────────────────────────────
export function getDepartments(): Promise<Department[]>;
export function createDepartment(data: Record<string, unknown>): Promise<Department>;
export function updateDepartment(departmentId: number, data: Record<string, unknown>): Promise<Department>;
export function deleteDepartment(departmentId: number): Promise<Record<string, unknown>>;

// ── Team: invites + self-operator ────────────────────────────────────────────
export function createOperatorInvite(data: {
  email: string;
  botId: number;
  role?: 'operator' | 'admin' | string;
  departmentId?: number | null;
}): Promise<OperatorInviteCreated>;
export function listOperatorInvites(statusFilter?: string | null): Promise<OperatorInvite[]>;
export function resendOperatorInvite(inviteId: number): Promise<OperatorInviteCreated>;
export function revokeOperatorInvite(inviteId: number): Promise<boolean>;
export function getInvitePublic(token: string): Promise<Record<string, unknown>>;
export function acceptInvitePublic(token: string): Promise<Record<string, unknown>>;
export function addSelfAsOperator(botId?: number): Promise<SelfOperatorResult>;
export function removeSelfAsOperator(): Promise<boolean>;

// ── Billing / subscription ───────────────────────────────────────────────────
export function getCurrentSubscription(): Promise<Record<string, unknown>>;
export function getSubscriptionPlans(): Promise<Array<Record<string, unknown>>>;
export function getSubscriptionUsage(): Promise<Record<string, unknown>>;
export function getInvoices(): Promise<Array<Record<string, unknown>>>;
export function getBillingDetails(): Promise<Record<string, unknown>>;
export function updateBillingDetails(patch: Record<string, unknown>): Promise<Record<string, unknown>>;

// ── Credits / top-ups ────────────────────────────────────────────────────────
export function getCreditBalance(): Promise<Record<string, unknown>>;
export function getCreditHistory(params?: { page?: number; limit?: number }): Promise<Record<string, unknown>>;
export function getTopupPacks(): Promise<Array<Record<string, unknown>>>;

// ── Security / account ───────────────────────────────────────────────────────
export function changeClientPassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }>;
export function getClientApiKey(): Promise<{ api_key_masked: string }>;
export function regenerateClientApiKey(): Promise<{ ok: boolean; api_key: string; api_key_masked: string }>;

// ── Integrations: webhooks ───────────────────────────────────────────────────
export function getWebhooks(botId?: number): Promise<Webhook[]>;
export function createWebhook(botId: number, data: Record<string, unknown>): Promise<Webhook>;
export function updateWebhook(webhookId: number, data: Record<string, unknown>): Promise<Webhook>;
export function deleteWebhook(webhookId: number): Promise<Record<string, unknown>>;
export function getWebhookDeliveries(webhookId: number, page?: number): Promise<WebhookDeliveriesResult>;
export function testWebhook(webhookId: number): Promise<Record<string, unknown>>;
