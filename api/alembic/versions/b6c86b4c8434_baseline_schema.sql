CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE TYPE public.credit_reason AS ENUM (
    'plan_grant',
    'topup',
    'ai_chat',
    'url_scan',
    'email_send',
    'manual_adjust',
    'refund',
    'expiry',
    'document_upload'
);
CREATE TABLE public.activation_events (
    id integer NOT NULL,
    client_id integer NOT NULL,
    bot_id integer,
    event_type character varying NOT NULL,
    event_data jsonb,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.activation_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.activation_events_id_seq OWNED BY public.activation_events.id;
CREATE TABLE public.affiliate_invites (
    id integer NOT NULL,
    email character varying NOT NULL,
    token_hash text NOT NULL,
    max_active_codes integer DEFAULT 10 NOT NULL,
    commission_bps integer DEFAULT 0 NOT NULL,
    invited_by integer,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_invite_max_codes_positive CHECK ((max_active_codes > 0))
);
CREATE SEQUENCE public.affiliate_invites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.affiliate_invites_id_seq OWNED BY public.affiliate_invites.id;
CREATE TABLE public.affiliates (
    id integer NOT NULL,
    client_id integer NOT NULL,
    invited_by integer,
    max_active_codes integer DEFAULT 10 NOT NULL,
    commission_bps integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp with time zone,
    CONSTRAINT chk_affiliate_commission_bps_range CHECK (((commission_bps >= 0) AND (commission_bps <= 10000))),
    CONSTRAINT chk_affiliate_max_codes_positive CHECK ((max_active_codes > 0))
);
CREATE SEQUENCE public.affiliates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.affiliates_id_seq OWNED BY public.affiliates.id;
CREATE TABLE public.audit_logs (
    id integer NOT NULL,
    actor_id integer,
    actor_name character varying,
    action character varying NOT NULL,
    target_type character varying,
    target_id character varying,
    before jsonb,
    after jsonb,
    ip character varying,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;
CREATE TABLE public.bant_signals (
    id integer NOT NULL,
    session_id character varying NOT NULL,
    message_id integer,
    dimension character varying NOT NULL,
    signal_text text NOT NULL,
    extracted_value text,
    confidence character varying DEFAULT 'medium'::character varying NOT NULL,
    score_before integer DEFAULT 0 NOT NULL,
    score_after integer DEFAULT 0 NOT NULL,
    source character varying DEFAULT 'llm'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.bant_signals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.bant_signals_id_seq OWNED BY public.bant_signals.id;
CREATE TABLE public.bot_growth_events (
    id integer NOT NULL,
    bot_id integer NOT NULL,
    event_type character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ck_bot_growth_events_event_type CHECK (((event_type)::text = ANY ((ARRAY['demo_share_clicked'::character varying, 'demo_link_opened'::character varying])::text[])))
);
CREATE SEQUENCE public.bot_growth_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.bot_growth_events_id_seq OWNED BY public.bot_growth_events.id;
CREATE TABLE public.bots (
    id integer NOT NULL,
    client_id integer NOT NULL,
    bot_key character varying NOT NULL,
    name character varying DEFAULT 'AI Assistant'::character varying,
    system_prompt text,
    brand_tone text,
    brand_tone_preset character varying,
    company_name character varying,
    company_description text,
    seed_questions jsonb,
    manual_field_overrides jsonb DEFAULT '[]'::jsonb NOT NULL,
    website character varying,
    bot_logo text,
    launcher_name character varying DEFAULT 'Have Questions?'::character varying,
    launcher_logo text,
    primary_color character varying DEFAULT '#ba68c8'::character varying,
    background_color character varying DEFAULT '#ffffff'::character varying,
    header_color character varying DEFAULT '#3A0CA3'::character varying,
    recommended_colors jsonb,
    user_bubble_color character varying DEFAULT '#DBE9FF'::character varying,
    bant_enabled boolean DEFAULT true NOT NULL,
    bant_config jsonb,
    relevance_threshold double precision,
    avatar_type character varying DEFAULT 'upload'::character varying NOT NULL,
    orb_color character varying,
    lead_form_enabled boolean DEFAULT false NOT NULL,
    lead_form_fields jsonb,
    notification_email character varying,
    notification_emails jsonb,
    reply_to_email character varying,
    email_on_qualified boolean DEFAULT true NOT NULL,
    email_on_handoff boolean DEFAULT true NOT NULL,
    email_on_offline boolean DEFAULT true NOT NULL,
    email_visitor_confirmation boolean DEFAULT true NOT NULL,
    live_chat_enabled boolean DEFAULT true NOT NULL,
    operator_timeout_seconds integer DEFAULT 120 NOT NULL,
    visitor_disconnect_timeout integer DEFAULT 120 NOT NULL,
    operator_disconnect_timeout integer DEFAULT 60 NOT NULL,
    business_hours json,
    live_chat_routing_strategy character varying DEFAULT 'least_busy'::character varying NOT NULL,
    live_chat_queue_timeout_seconds integer DEFAULT 20 NOT NULL,
    live_chat_max_queue_size integer DEFAULT 10 NOT NULL,
    welcome_title character varying DEFAULT 'Hi there 👋'::character varying NOT NULL,
    welcome_subtitle character varying DEFAULT 'How can we help you today?'::character varying NOT NULL,
    waiting_message character varying DEFAULT 'Connecting you to support...'::character varying NOT NULL,
    offline_message character varying DEFAULT 'We''ll be right back! Leave a message and we''ll follow up shortly.'::character varying NOT NULL,
    handoff_delay_seconds integer DEFAULT 0 NOT NULL,
    calendly_url character varying,
    meeting_booking_enabled boolean DEFAULT false NOT NULL,
    meeting_provider character varying,
    zcal_url character varying,
    calcom_url character varying,
    feature_flags jsonb DEFAULT '{"file_sharing": false, "show_branding": true, "queue_position": false, "typing_preview": true, "email_transcript": false, "post_chat_rating": true}'::jsonb NOT NULL,
    widget_messages jsonb DEFAULT '{"rating_prompt": "How was your experience?", "end_chat_label": "End chat and return to AI", "live_chat_label": "Live chat", "offline_message": "We''ll be right back! Leave a message and we''ll follow up shortly.", "greeting_message": "Hi! Let us know if you have any questions.", "welcome_greeting": "Hi There, How can I help you today?", "input_placeholder": "Write a message...", "welcome_suggestions": ["Our Services", "About us", "Contact us"]}'::jsonb NOT NULL,
    widget_config jsonb DEFAULT '{"greeting_delay_ms": 3000, "typing_timeout_ms": 2000, "heartbeat_hidden_ms": 50000, "heartbeat_visible_ms": 25000, "frustration_window_ms": 30000, "max_reconnect_attempts": 15, "max_reconnect_delay_ms": 30000, "welcome_exit_duration_ms": 350, "handoff_auto_submit_delay_ms": 300, "frustration_threshold_messages": 3}'::jsonb NOT NULL,
    branding_text character varying DEFAULT 'Powered by OyeChats'::character varying NOT NULL,
    branding_url character varying DEFAULT 'https://oyechats.com'::character varying NOT NULL,
    services jsonb,
    services_url character varying,
    allowed_domains jsonb DEFAULT '[]'::jsonb NOT NULL,
    domain_check_enabled boolean DEFAULT true NOT NULL,
    widget_installed_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    plan_id integer,
    subscription_id integer,
    is_legacy_pooled boolean DEFAULT false NOT NULL,
    credits_balance integer DEFAULT 0 NOT NULL,
    recrawl_enabled boolean DEFAULT false NOT NULL,
    next_recrawl_at timestamp with time zone,
    last_recrawl_at timestamp with time zone,
    last_recrawl_status character varying,
    last_recrawl_summary jsonb,
    recrawl_history jsonb DEFAULT '[]'::jsonb NOT NULL
);
CREATE SEQUENCE public.bots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.bots_id_seq OWNED BY public.bots.id;
CREATE TABLE public.canned_responses (
    id integer NOT NULL,
    client_id integer NOT NULL,
    title character varying NOT NULL,
    content text NOT NULL,
    shortcut character varying,
    category character varying,
    created_by_operator_id integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.canned_responses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.canned_responses_id_seq OWNED BY public.canned_responses.id;
CREATE TABLE public.chat_audit_logs (
    id integer NOT NULL,
    session_id character varying NOT NULL,
    operator_id integer,
    action character varying NOT NULL,
    details jsonb,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.chat_audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.chat_audit_logs_id_seq OWNED BY public.chat_audit_logs.id;
CREATE TABLE public.chat_messages (
    id integer NOT NULL,
    session_id character varying NOT NULL,
    role character varying NOT NULL,
    content text NOT NULL,
    feedback integer,
    trace_id character varying(255),
    media_card jsonb,
    media_secondary jsonb,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.chat_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.chat_messages_id_seq OWNED BY public.chat_messages.id;
CREATE TABLE public.chat_sessions (
    id character varying NOT NULL,
    client_id integer,
    bot_id integer,
    location character varying,
    device character varying,
    behavioral_score integer DEFAULT 0 NOT NULL,
    page_url character varying,
    referrer character varying,
    utm_params jsonb,
    visitor_journey jsonb,
    visit_count integer DEFAULT 1 NOT NULL,
    bant_need text,
    bant_timeline character varying,
    bant_authority character varying,
    bant_budget character varying,
    bant_need_score integer DEFAULT 0 NOT NULL,
    bant_budget_score integer DEFAULT 0 NOT NULL,
    bant_authority_score integer DEFAULT 0 NOT NULL,
    bant_timeline_score integer DEFAULT 0 NOT NULL,
    bant_score integer DEFAULT 0 NOT NULL,
    bant_tier character varying DEFAULT 'unqualified'::character varying NOT NULL,
    dimensions_assessed integer DEFAULT 0 NOT NULL,
    bant_last_updated timestamp with time zone,
    dimension_scores jsonb,
    qualification_framework character varying DEFAULT 'bant'::character varying NOT NULL,
    status character varying DEFAULT 'bot'::character varying NOT NULL,
    assigned_operator_id integer,
    handoff_reason text,
    department_id integer,
    visitor_metadata jsonb,
    inline_cards_shown jsonb,
    visitor_rating integer,
    visitor_resolved boolean,
    lead_viewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    last_active_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.clients (
    id integer NOT NULL,
    name character varying NOT NULL,
    email character varying NOT NULL,
    company_name character varying,
    legal_name character varying,
    gstin character varying(15),
    billing_address jsonb,
    billing_country character varying(2),
    billing_state_code character varying(2),
    billing_email character varying,
    hashed_password character varying,
    api_key character varying NOT NULL,
    is_superadmin boolean NOT NULL,
    superadmin_role character varying,
    suspended_at timestamp with time zone,
    max_bots integer DEFAULT 100 NOT NULL,
    extra_bot_seats integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    is_verified boolean DEFAULT false NOT NULL,
    email_otp character varying,
    email_otp_expires_at timestamp with time zone,
    onboarding_complete boolean DEFAULT false NOT NULL,
    reset_otp character varying,
    reset_otp_expires_at timestamp with time zone,
    pending_email character varying,
    email_change_otp character varying,
    email_change_otp_expires_at timestamp with time zone,
    referral_code_id integer,
    referral_attributed_at timestamp with time zone,
    deactivated_at timestamp with time zone,
    system_prompt text,
    website character varying,
    bot_name character varying,
    bot_logo text,
    launcher_name character varying,
    launcher_logo text,
    primary_color character varying,
    background_color character varying,
    header_color character varying,
    recommended_colors jsonb
);
CREATE SEQUENCE public.clients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.clients_id_seq OWNED BY public.clients.id;
CREATE TABLE public.coupons (
    id integer NOT NULL,
    code character varying NOT NULL,
    percent_off integer,
    amount_off_cents integer,
    max_redemptions integer,
    redemptions integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    applies_to_plan_ids jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.coupons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.coupons_id_seq OWNED BY public.coupons.id;
CREATE TABLE public.credit_ledger (
    id integer NOT NULL,
    client_id integer NOT NULL,
    bot_id integer,
    delta integer NOT NULL,
    reason public.credit_reason NOT NULL,
    reference_id integer,
    idempotency_key character varying,
    grant_id integer,
    expires_at timestamp with time zone,
    note text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.credit_ledger_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.credit_ledger_id_seq OWNED BY public.credit_ledger.id;
CREATE TABLE public.departments (
    id integer NOT NULL,
    client_id integer NOT NULL,
    name character varying NOT NULL,
    description text,
    business_hours jsonb,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.departments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.departments_id_seq OWNED BY public.departments.id;
CREATE TABLE public.discounted_plan_cache (
    id integer NOT NULL,
    base_plan_id integer NOT NULL,
    billing_cycle character varying NOT NULL,
    discount_bps integer NOT NULL,
    razorpay_plan_id character varying NOT NULL,
    amount_paise integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT chk_discount_bps_range CHECK (((discount_bps > 0) AND (discount_bps < 10000)))
);
CREATE SEQUENCE public.discounted_plan_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.discounted_plan_cache_id_seq OWNED BY public.discounted_plan_cache.id;
CREATE TABLE public.documents (
    id integer NOT NULL,
    client_id integer,
    bot_id integer,
    document_name character varying NOT NULL,
    source character varying DEFAULT 'upload'::character varying NOT NULL,
    file_hash character varying NOT NULL,
    content text NOT NULL,
    metadata_info jsonb,
    embedding public.vector(768) NOT NULL,
    search_vector tsvector,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.documents_id_seq OWNED BY public.documents.id;
CREATE TABLE public.events (
    id integer NOT NULL,
    bot_id integer NOT NULL,
    title character varying NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    url character varying,
    location character varying,
    source_url character varying NOT NULL,
    source_chunk_id integer,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.events_id_seq OWNED BY public.events.id;
CREATE TABLE public.failed_webhooks (
    id integer NOT NULL,
    provider text NOT NULL,
    event_id text,
    event_type text,
    raw_payload bytea NOT NULL,
    signature text,
    headers jsonb,
    error text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    replayed_at timestamp with time zone
);
CREATE SEQUENCE public.failed_webhooks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.failed_webhooks_id_seq OWNED BY public.failed_webhooks.id;
CREATE TABLE public.impersonation_tokens (
    id integer NOT NULL,
    token_hash character varying NOT NULL,
    actor_id integer NOT NULL,
    target_id integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.impersonation_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.impersonation_tokens_id_seq OWNED BY public.impersonation_tokens.id;
CREATE TABLE public.invoice_counters (
    financial_year character varying(5) NOT NULL,
    prefix character varying(3) NOT NULL,
    last_serial integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.invoices (
    id integer NOT NULL,
    client_id integer NOT NULL,
    subscription_id integer,
    bot_id integer,
    amount_cents integer NOT NULL,
    currency character varying DEFAULT 'inr'::character varying NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    razorpay_payment_id character varying,
    invoice_url character varying,
    pdf_url character varying,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    description text,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    invoice_number character varying(20),
    invoice_type character varying DEFAULT 'legacy'::character varying NOT NULL,
    issued_at timestamp with time zone,
    seller_snapshot jsonb,
    buyer_snapshot jsonb,
    place_of_supply character varying(2),
    supply_kind character varying,
    taxable_value_minor integer,
    tax_rate_bps integer,
    cgst_minor integer,
    sgst_minor integer,
    igst_minor integer,
    total_tax_minor integer,
    hsn_sac character varying(8),
    is_export boolean DEFAULT false NOT NULL,
    line_items jsonb,
    credit_note_of_id integer,
    razorpay_invoice_id character varying,
    emailed_at timestamp with time zone,
    irn character varying,
    signed_qr text
);
CREATE SEQUENCE public.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;
CREATE TABLE public.lead_info (
    id integer NOT NULL,
    session_id character varying NOT NULL,
    bot_id integer NOT NULL,
    name character varying,
    email character varying,
    phone character varying,
    company character varying,
    utm_params jsonb,
    visitor_journey jsonb,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.lead_info_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.lead_info_id_seq OWNED BY public.lead_info.id;
CREATE TABLE public.live_chat_queue (
    id integer NOT NULL,
    session_id character varying NOT NULL,
    bot_id integer NOT NULL,
    "position" integer NOT NULL,
    enqueued_at timestamp with time zone DEFAULT now() NOT NULL,
    dequeued_at timestamp with time zone,
    dequeue_reason character varying
);
CREATE SEQUENCE public.live_chat_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.live_chat_queue_id_seq OWNED BY public.live_chat_queue.id;
CREATE TABLE public.llm_call_logs (
    id integer NOT NULL,
    bot_id integer,
    client_id integer,
    model character varying NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    cost_cents integer DEFAULT 0 NOT NULL,
    latency_ms integer DEFAULT 0 NOT NULL,
    fallback_used boolean DEFAULT false NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.llm_call_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.llm_call_logs_id_seq OWNED BY public.llm_call_logs.id;
CREATE TABLE public.meeting_bookings (
    id integer NOT NULL,
    session_id character varying NOT NULL,
    bot_id integer NOT NULL,
    booking_url character varying,
    meeting_time timestamp with time zone,
    attendee_email character varying,
    status character varying DEFAULT 'scheduled'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.meeting_bookings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.meeting_bookings_id_seq OWNED BY public.meeting_bookings.id;
CREATE TABLE public.notifications (
    id integer NOT NULL,
    client_id integer NOT NULL,
    operator_id integer,
    type character varying NOT NULL,
    title character varying NOT NULL,
    body text,
    link character varying,
    data jsonb,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;
CREATE TABLE public.oauth_accounts (
    id integer NOT NULL,
    client_id integer NOT NULL,
    provider character varying NOT NULL,
    provider_user_id character varying NOT NULL,
    email character varying,
    picture_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone
);
CREATE SEQUENCE public.oauth_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.oauth_accounts_id_seq OWNED BY public.oauth_accounts.id;
CREATE TABLE public.offline_messages (
    id integer NOT NULL,
    bot_id integer NOT NULL,
    session_id character varying,
    department_id integer,
    visitor_name character varying NOT NULL,
    visitor_email character varying NOT NULL,
    visitor_phone character varying,
    message_body text NOT NULL,
    status character varying DEFAULT 'new'::character varying NOT NULL,
    transcript jsonb,
    fallback_reason character varying,
    created_at timestamp with time zone DEFAULT now(),
    read_at timestamp with time zone,
    replied_at timestamp with time zone
);
CREATE SEQUENCE public.offline_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.offline_messages_id_seq OWNED BY public.offline_messages.id;
CREATE TABLE public.operator_invites (
    id integer NOT NULL,
    client_id integer NOT NULL,
    email character varying NOT NULL,
    role character varying DEFAULT 'operator'::character varying NOT NULL,
    department_id integer,
    token_hash character varying(64) NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    invited_by_client_id integer,
    invited_by_name character varying,
    accepted_at timestamp with time zone,
    accepted_by_client_id integer,
    revoked_at timestamp with time zone,
    revoked_by_client_id integer,
    sent_at timestamp with time zone,
    resend_count integer DEFAULT 0 NOT NULL
);
CREATE SEQUENCE public.operator_invites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.operator_invites_id_seq OWNED BY public.operator_invites.id;
CREATE TABLE public.operator_push_subscriptions (
    id integer NOT NULL,
    operator_id integer,
    client_id integer,
    endpoint text NOT NULL,
    p256dh character varying NOT NULL,
    auth character varying NOT NULL,
    user_agent character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT chk_push_subscription_owner_xor CHECK (((((operator_id IS NULL))::integer + ((client_id IS NULL))::integer) = 1))
);
CREATE SEQUENCE public.operator_push_subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.operator_push_subscriptions_id_seq OWNED BY public.operator_push_subscriptions.id;
CREATE TABLE public.operators (
    id integer NOT NULL,
    client_id integer NOT NULL,
    name character varying NOT NULL,
    email character varying NOT NULL,
    is_online boolean DEFAULT false NOT NULL,
    last_seen_at timestamp with time zone,
    is_accepting_chats boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    hashed_password character varying,
    operator_api_key character varying,
    is_active boolean DEFAULT true NOT NULL,
    bot_id integer NOT NULL,
    role character varying DEFAULT 'operator'::character varying NOT NULL,
    department_id integer,
    avatar_url character varying,
    max_concurrent_chats integer DEFAULT 5 NOT NULL,
    notification_preferences jsonb,
    linked_client_id integer,
    invited_email character varying
);
CREATE SEQUENCE public.operators_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.operators_id_seq OWNED BY public.operators.id;
CREATE TABLE public.payment_methods (
    id integer NOT NULL,
    client_id integer NOT NULL,
    provider character varying NOT NULL,
    type character varying NOT NULL,
    last4 character varying(4),
    brand character varying,
    expiry_month integer,
    expiry_year integer,
    is_default boolean DEFAULT false NOT NULL,
    razorpay_token_id character varying,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.payment_methods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.payment_methods_id_seq OWNED BY public.payment_methods.id;
CREATE TABLE public.plans (
    id integer NOT NULL,
    name character varying NOT NULL,
    slug character varying NOT NULL,
    description text,
    pricing_model character varying DEFAULT 'per_operator'::character varying NOT NULL,
    currency character varying(3) DEFAULT 'INR'::character varying NOT NULL,
    monthly_price_cents integer DEFAULT 0 NOT NULL,
    annual_price_cents integer DEFAULT 0 NOT NULL,
    annual_discount_percent integer DEFAULT 30 NOT NULL,
    trial_days integer DEFAULT 14 NOT NULL,
    limits jsonb DEFAULT '{"url_scans": 50, "storage_mb": 5, "ai_messages": 250, "email_summaries": 0, "knowledge_pages": 50, "chat_history_days": 7, "live_chat_messages": 0, "email_notifications": 0}'::jsonb NOT NULL,
    features jsonb DEFAULT '{"sso": false, "bant": false, "webhooks": false, "live_chat": false, "api_access": false, "custom_sla": false, "whitelabel": false, "dedicated_csm": false, "advanced_analytics": false, "branding_removable": false}'::jsonb NOT NULL,
    overage_rate_cents integer DEFAULT 0 NOT NULL,
    credits_per_month integer DEFAULT 0 NOT NULL,
    included_operator_seats integer DEFAULT 1 NOT NULL,
    extra_seat_price_cents integer DEFAULT 1500 NOT NULL,
    razorpay_plan_id_monthly character varying,
    razorpay_plan_id_annual character varying,
    monthly_price_usd_cents integer,
    annual_price_usd_cents integer,
    extra_seat_price_usd_cents integer,
    is_active boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    marketing jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.plans_id_seq OWNED BY public.plans.id;
CREATE TABLE public.platform_feedback (
    id integer NOT NULL,
    client_id integer,
    message text NOT NULL,
    attachment_url character varying,
    category character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type character varying(20) DEFAULT 'other'::character varying NOT NULL,
    area character varying(20),
    severity character varying(10),
    context jsonb,
    attachments jsonb,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    admin_response text,
    resolved_at timestamp with time zone,
    resolved_by integer
);
CREATE SEQUENCE public.platform_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.platform_feedback_id_seq OWNED BY public.platform_feedback.id;
CREATE TABLE public.pricing_config (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer
);
CREATE TABLE public.processed_webhooks (
    event_id text NOT NULL,
    provider text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.referral_clicks (
    id bigint NOT NULL,
    code_id integer NOT NULL,
    ip_hash text,
    ua_hash text,
    referrer text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.referral_clicks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.referral_clicks_id_seq OWNED BY public.referral_clicks.id;
CREATE TABLE public.referral_codes (
    id integer NOT NULL,
    affiliate_id integer NOT NULL,
    code public.citext NOT NULL,
    label text,
    active boolean DEFAULT true NOT NULL,
    affiliate_commission_bps integer DEFAULT 0 NOT NULL,
    customer_discount_bps integer DEFAULT 0 NOT NULL,
    max_redemptions integer,
    redeemed_count integer DEFAULT 0 NOT NULL,
    valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp with time zone,
    CONSTRAINT chk_code_split_range CHECK (((affiliate_commission_bps >= 0) AND (affiliate_commission_bps <= 10000) AND (customer_discount_bps >= 0) AND (customer_discount_bps <= 10000) AND ((affiliate_commission_bps + customer_discount_bps) <= 10000))),
    CONSTRAINT chk_referral_code_format CHECK ((code OPERATOR(public.~) '^[A-Za-z0-9_-]{3,20}$'::public.citext)),
    CONSTRAINT chk_referral_redemption_counts CHECK (((redeemed_count >= 0) AND ((max_redemptions IS NULL) OR (max_redemptions >= 0))))
);
CREATE SEQUENCE public.referral_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.referral_codes_id_seq OWNED BY public.referral_codes.id;
CREATE TABLE public.referral_conversions (
    id integer NOT NULL,
    client_id integer NOT NULL,
    referral_code_id integer,
    affiliate_id integer,
    commission_bps integer NOT NULL,
    customer_discount_bps integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.referral_conversions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.referral_conversions_id_seq OWNED BY public.referral_conversions.id;
CREATE TABLE public.subscriptions (
    id integer NOT NULL,
    client_id integer NOT NULL,
    plan_id integer NOT NULL,
    bot_id integer,
    status character varying DEFAULT 'trialing'::character varying NOT NULL,
    billing_cycle character varying DEFAULT 'monthly'::character varying NOT NULL,
    operator_quantity integer DEFAULT 1 NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    last_granted_period_end timestamp with time zone,
    trial_start timestamp with time zone,
    trial_end timestamp with time zone,
    data_retention_until timestamp with time zone,
    past_due_since timestamp with time zone,
    trial_emails_sent jsonb DEFAULT '{}'::jsonb NOT NULL,
    canceled_at timestamp with time zone,
    cancel_reason text,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    razorpay_billing_plan_id character varying,
    payment_provider character varying DEFAULT 'razorpay'::character varying NOT NULL,
    razorpay_subscription_id character varying,
    razorpay_customer_id character varying,
    prev_razorpay_subscription_id character varying,
    scheduled_plan_id integer,
    scheduled_billing_cycle character varying(16),
    scheduled_change_at timestamp with time zone,
    upgrade_credit_pending_cents integer DEFAULT 0 NOT NULL,
    upgrade_pending_subscription_id character varying,
    upgrade_pending_plan_id integer,
    seat_addon_subscription_id character varying,
    seat_addon_quantity integer DEFAULT 0 NOT NULL,
    seat_addon_pending_quantity integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.subscriptions_id_seq OWNED BY public.subscriptions.id;
CREATE TABLE public.usage_records (
    id integer NOT NULL,
    client_id integer NOT NULL,
    plan_id integer,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    ai_messages_used integer DEFAULT 0 NOT NULL,
    ai_messages_limit integer DEFAULT 0 NOT NULL,
    live_chat_messages_used integer DEFAULT 0 NOT NULL,
    live_chat_messages_limit integer DEFAULT 0 NOT NULL,
    url_scans_used integer DEFAULT 0 NOT NULL,
    url_scans_limit integer DEFAULT 0 NOT NULL,
    email_summaries_used integer DEFAULT 0 NOT NULL,
    email_summaries_limit integer DEFAULT 0 NOT NULL,
    email_notifications_used integer DEFAULT 0 NOT NULL,
    email_notifications_limit integer DEFAULT 0 NOT NULL,
    bots_count integer DEFAULT 0 NOT NULL,
    operators_count integer DEFAULT 0 NOT NULL,
    storage_used_mb integer DEFAULT 0 NOT NULL,
    storage_limit_mb integer DEFAULT 0 NOT NULL,
    overage_messages integer DEFAULT 0 NOT NULL,
    overage_amount_cents integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.usage_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.usage_records_id_seq OWNED BY public.usage_records.id;
CREATE TABLE public.visitor_events (
    id integer NOT NULL,
    session_id character varying NOT NULL,
    bot_id integer NOT NULL,
    event_type character varying NOT NULL,
    event_data jsonb,
    created_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.visitor_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.visitor_events_id_seq OWNED BY public.visitor_events.id;
CREATE TABLE public.webhook_deliveries (
    id integer NOT NULL,
    webhook_id integer NOT NULL,
    event_type character varying NOT NULL,
    payload jsonb NOT NULL,
    status_code integer,
    response_body text,
    attempt integer DEFAULT 1 NOT NULL,
    next_retry_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    delivered_at timestamp with time zone
);
CREATE SEQUENCE public.webhook_deliveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.webhook_deliveries_id_seq OWNED BY public.webhook_deliveries.id;
CREATE TABLE public.webhooks (
    id integer NOT NULL,
    bot_id integer NOT NULL,
    url character varying NOT NULL,
    secret character varying NOT NULL,
    events jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE SEQUENCE public.webhooks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.webhooks_id_seq OWNED BY public.webhooks.id;
ALTER TABLE ONLY public.activation_events ALTER COLUMN id SET DEFAULT nextval('public.activation_events_id_seq'::regclass);
ALTER TABLE ONLY public.affiliate_invites ALTER COLUMN id SET DEFAULT nextval('public.affiliate_invites_id_seq'::regclass);
ALTER TABLE ONLY public.affiliates ALTER COLUMN id SET DEFAULT nextval('public.affiliates_id_seq'::regclass);
ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);
ALTER TABLE ONLY public.bant_signals ALTER COLUMN id SET DEFAULT nextval('public.bant_signals_id_seq'::regclass);
ALTER TABLE ONLY public.bot_growth_events ALTER COLUMN id SET DEFAULT nextval('public.bot_growth_events_id_seq'::regclass);
ALTER TABLE ONLY public.bots ALTER COLUMN id SET DEFAULT nextval('public.bots_id_seq'::regclass);
ALTER TABLE ONLY public.canned_responses ALTER COLUMN id SET DEFAULT nextval('public.canned_responses_id_seq'::regclass);
ALTER TABLE ONLY public.chat_audit_logs ALTER COLUMN id SET DEFAULT nextval('public.chat_audit_logs_id_seq'::regclass);
ALTER TABLE ONLY public.chat_messages ALTER COLUMN id SET DEFAULT nextval('public.chat_messages_id_seq'::regclass);
ALTER TABLE ONLY public.clients ALTER COLUMN id SET DEFAULT nextval('public.clients_id_seq'::regclass);
ALTER TABLE ONLY public.coupons ALTER COLUMN id SET DEFAULT nextval('public.coupons_id_seq'::regclass);
ALTER TABLE ONLY public.credit_ledger ALTER COLUMN id SET DEFAULT nextval('public.credit_ledger_id_seq'::regclass);
ALTER TABLE ONLY public.departments ALTER COLUMN id SET DEFAULT nextval('public.departments_id_seq'::regclass);
ALTER TABLE ONLY public.discounted_plan_cache ALTER COLUMN id SET DEFAULT nextval('public.discounted_plan_cache_id_seq'::regclass);
ALTER TABLE ONLY public.documents ALTER COLUMN id SET DEFAULT nextval('public.documents_id_seq'::regclass);
ALTER TABLE ONLY public.events ALTER COLUMN id SET DEFAULT nextval('public.events_id_seq'::regclass);
ALTER TABLE ONLY public.failed_webhooks ALTER COLUMN id SET DEFAULT nextval('public.failed_webhooks_id_seq'::regclass);
ALTER TABLE ONLY public.impersonation_tokens ALTER COLUMN id SET DEFAULT nextval('public.impersonation_tokens_id_seq'::regclass);
ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);
ALTER TABLE ONLY public.lead_info ALTER COLUMN id SET DEFAULT nextval('public.lead_info_id_seq'::regclass);
ALTER TABLE ONLY public.live_chat_queue ALTER COLUMN id SET DEFAULT nextval('public.live_chat_queue_id_seq'::regclass);
ALTER TABLE ONLY public.llm_call_logs ALTER COLUMN id SET DEFAULT nextval('public.llm_call_logs_id_seq'::regclass);
ALTER TABLE ONLY public.meeting_bookings ALTER COLUMN id SET DEFAULT nextval('public.meeting_bookings_id_seq'::regclass);
ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);
ALTER TABLE ONLY public.oauth_accounts ALTER COLUMN id SET DEFAULT nextval('public.oauth_accounts_id_seq'::regclass);
ALTER TABLE ONLY public.offline_messages ALTER COLUMN id SET DEFAULT nextval('public.offline_messages_id_seq'::regclass);
ALTER TABLE ONLY public.operator_invites ALTER COLUMN id SET DEFAULT nextval('public.operator_invites_id_seq'::regclass);
ALTER TABLE ONLY public.operator_push_subscriptions ALTER COLUMN id SET DEFAULT nextval('public.operator_push_subscriptions_id_seq'::regclass);
ALTER TABLE ONLY public.operators ALTER COLUMN id SET DEFAULT nextval('public.operators_id_seq'::regclass);
ALTER TABLE ONLY public.payment_methods ALTER COLUMN id SET DEFAULT nextval('public.payment_methods_id_seq'::regclass);
ALTER TABLE ONLY public.plans ALTER COLUMN id SET DEFAULT nextval('public.plans_id_seq'::regclass);
ALTER TABLE ONLY public.platform_feedback ALTER COLUMN id SET DEFAULT nextval('public.platform_feedback_id_seq'::regclass);
ALTER TABLE ONLY public.referral_clicks ALTER COLUMN id SET DEFAULT nextval('public.referral_clicks_id_seq'::regclass);
ALTER TABLE ONLY public.referral_codes ALTER COLUMN id SET DEFAULT nextval('public.referral_codes_id_seq'::regclass);
ALTER TABLE ONLY public.referral_conversions ALTER COLUMN id SET DEFAULT nextval('public.referral_conversions_id_seq'::regclass);
ALTER TABLE ONLY public.subscriptions ALTER COLUMN id SET DEFAULT nextval('public.subscriptions_id_seq'::regclass);
ALTER TABLE ONLY public.usage_records ALTER COLUMN id SET DEFAULT nextval('public.usage_records_id_seq'::regclass);
ALTER TABLE ONLY public.visitor_events ALTER COLUMN id SET DEFAULT nextval('public.visitor_events_id_seq'::regclass);
ALTER TABLE ONLY public.webhook_deliveries ALTER COLUMN id SET DEFAULT nextval('public.webhook_deliveries_id_seq'::regclass);
ALTER TABLE ONLY public.webhooks ALTER COLUMN id SET DEFAULT nextval('public.webhooks_id_seq'::regclass);
ALTER TABLE ONLY public.activation_events
    ADD CONSTRAINT activation_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.affiliate_invites
    ADD CONSTRAINT affiliate_invites_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.affiliates
    ADD CONSTRAINT affiliates_client_id_key UNIQUE (client_id);
ALTER TABLE ONLY public.affiliates
    ADD CONSTRAINT affiliates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.bant_signals
    ADD CONSTRAINT bant_signals_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.bot_growth_events
    ADD CONSTRAINT bot_growth_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.canned_responses
    ADD CONSTRAINT canned_responses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.chat_audit_logs
    ADD CONSTRAINT chat_audit_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.discounted_plan_cache
    ADD CONSTRAINT discounted_plan_cache_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.failed_webhooks
    ADD CONSTRAINT failed_webhooks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.impersonation_tokens
    ADD CONSTRAINT impersonation_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.invoice_counters
    ADD CONSTRAINT invoice_counters_pkey PRIMARY KEY (financial_year, prefix);
ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lead_info
    ADD CONSTRAINT lead_info_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.lead_info
    ADD CONSTRAINT lead_info_session_id_key UNIQUE (session_id);
ALTER TABLE ONLY public.live_chat_queue
    ADD CONSTRAINT live_chat_queue_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.llm_call_logs
    ADD CONSTRAINT llm_call_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.meeting_bookings
    ADD CONSTRAINT meeting_bookings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.oauth_accounts
    ADD CONSTRAINT oauth_accounts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.offline_messages
    ADD CONSTRAINT offline_messages_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.operator_invites
    ADD CONSTRAINT operator_invites_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.operator_push_subscriptions
    ADD CONSTRAINT operator_push_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.platform_feedback
    ADD CONSTRAINT platform_feedback_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pricing_config
    ADD CONSTRAINT pricing_config_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.processed_webhooks
    ADD CONSTRAINT processed_webhooks_pkey PRIMARY KEY (event_id);
ALTER TABLE ONLY public.referral_clicks
    ADD CONSTRAINT referral_clicks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_code_key UNIQUE (code);
ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.referral_conversions
    ADD CONSTRAINT referral_conversions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.discounted_plan_cache
    ADD CONSTRAINT uq_discounted_plan UNIQUE (base_plan_id, billing_cycle, discount_bps);
ALTER TABLE ONLY public.events
    ADD CONSTRAINT uq_events_bot_source_title UNIQUE (bot_id, source_url, title);
ALTER TABLE ONLY public.operator_push_subscriptions
    ADD CONSTRAINT uq_operator_push_endpoint UNIQUE (endpoint);
ALTER TABLE ONLY public.usage_records
    ADD CONSTRAINT usage_records_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.visitor_events
    ADD CONSTRAINT visitor_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);
CREATE INDEX documents_embedding_hnsw_idx ON public.documents USING hnsw (embedding public.vector_cosine_ops);
CREATE INDEX ix_activation_events_client_id ON public.activation_events USING btree (client_id);
CREATE INDEX ix_activation_events_created_at ON public.activation_events USING btree (created_at);
CREATE INDEX ix_activation_events_event_type ON public.activation_events USING btree (event_type);
CREATE UNIQUE INDEX ix_affiliate_invites_token_hash ON public.affiliate_invites USING btree (token_hash);
CREATE INDEX ix_audit_logs_action ON public.audit_logs USING btree (action);
CREATE INDEX ix_audit_logs_actor_created ON public.audit_logs USING btree (actor_id, created_at DESC);
CREATE INDEX ix_audit_logs_created_at ON public.audit_logs USING btree (created_at);
CREATE INDEX ix_audit_logs_target_id ON public.audit_logs USING btree (target_id);
CREATE INDEX ix_audit_logs_target_type ON public.audit_logs USING btree (target_type);
CREATE INDEX ix_bant_signals_session_id ON public.bant_signals USING btree (session_id);
CREATE INDEX ix_bot_growth_events_bot_id ON public.bot_growth_events USING btree (bot_id);
CREATE UNIQUE INDEX ix_bots_bot_key ON public.bots USING btree (bot_key);
CREATE INDEX ix_bots_plan_id ON public.bots USING btree (plan_id);
CREATE INDEX ix_bots_subscription_id ON public.bots USING btree (subscription_id);
CREATE INDEX ix_chat_sessions_client_id ON public.chat_sessions USING btree (client_id);
CREATE UNIQUE INDEX ix_clients_api_key ON public.clients USING btree (api_key);
CREATE UNIQUE INDEX ix_clients_email ON public.clients USING btree (email);
CREATE UNIQUE INDEX ix_coupons_code ON public.coupons USING btree (code);
CREATE INDEX ix_credit_ledger_bot_id ON public.credit_ledger USING btree (bot_id);
CREATE INDEX ix_credit_ledger_client_created ON public.credit_ledger USING btree (client_id, created_at DESC);
CREATE INDEX ix_credit_ledger_grant_id ON public.credit_ledger USING btree (grant_id);
CREATE INDEX ix_credit_ledger_reference_id ON public.credit_ledger USING btree (reference_id);
CREATE INDEX ix_credit_ledger_topup_expiry ON public.credit_ledger USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (delta > 0));
CREATE INDEX ix_documents_bot_id ON public.documents USING btree (bot_id);
CREATE INDEX ix_documents_client_id ON public.documents USING btree (client_id);
CREATE INDEX ix_documents_file_hash ON public.documents USING btree (file_hash);
CREATE INDEX ix_documents_search_vector ON public.documents USING gin (search_vector);
CREATE INDEX ix_events_bot_id ON public.events USING btree (bot_id);
CREATE INDEX ix_events_bot_last_seen_at ON public.events USING btree (bot_id, last_seen_at);
CREATE INDEX ix_events_bot_starts_at ON public.events USING btree (bot_id, starts_at);
CREATE INDEX ix_failed_webhooks_event_id ON public.failed_webhooks USING btree (event_id);
CREATE INDEX ix_failed_webhooks_provider ON public.failed_webhooks USING btree (provider);
CREATE UNIQUE INDEX ix_impersonation_tokens_token_hash ON public.impersonation_tokens USING btree (token_hash);
CREATE INDEX ix_invoices_bot_id ON public.invoices USING btree (bot_id);
CREATE INDEX ix_invoices_client_id ON public.invoices USING btree (client_id);
CREATE UNIQUE INDEX ix_invoices_invoice_number ON public.invoices USING btree (invoice_number);
CREATE INDEX ix_invoices_razorpay_invoice_id ON public.invoices USING btree (razorpay_invoice_id);
CREATE UNIQUE INDEX ix_invoices_razorpay_payment_id ON public.invoices USING btree (razorpay_payment_id);
CREATE INDEX ix_live_chat_queue_bot_id_dequeued_at ON public.live_chat_queue USING btree (bot_id, dequeued_at);
CREATE INDEX ix_live_chat_queue_session_id ON public.live_chat_queue USING btree (session_id);
CREATE INDEX ix_llm_call_logs_bot_id ON public.llm_call_logs USING btree (bot_id);
CREATE INDEX ix_llm_call_logs_client_id ON public.llm_call_logs USING btree (client_id);
CREATE INDEX ix_llm_call_logs_created_at ON public.llm_call_logs USING btree (created_at);
CREATE INDEX ix_llm_call_logs_model ON public.llm_call_logs USING btree (model);
CREATE INDEX ix_meeting_bookings_session_id ON public.meeting_bookings USING btree (session_id);
CREATE INDEX ix_notifications_client_created ON public.notifications USING btree (client_id, created_at);
CREATE INDEX ix_notifications_client_id ON public.notifications USING btree (client_id);
CREATE INDEX ix_notifications_client_unread ON public.notifications USING btree (client_id, is_read);
CREATE INDEX ix_notifications_created_at ON public.notifications USING btree (created_at);
CREATE INDEX ix_notifications_operator_id ON public.notifications USING btree (operator_id);
CREATE INDEX ix_notifications_type ON public.notifications USING btree (type);
CREATE INDEX ix_oauth_accounts_client_id ON public.oauth_accounts USING btree (client_id);
CREATE UNIQUE INDEX ix_oauth_accounts_client_provider ON public.oauth_accounts USING btree (client_id, provider);
CREATE UNIQUE INDEX ix_oauth_accounts_provider_subject ON public.oauth_accounts USING btree (provider, provider_user_id);
CREATE INDEX ix_operator_invites_client_id ON public.operator_invites USING btree (client_id);
CREATE INDEX ix_operator_invites_email ON public.operator_invites USING btree (email);
CREATE UNIQUE INDEX ix_operator_invites_token_hash ON public.operator_invites USING btree (token_hash);
CREATE INDEX ix_operator_push_subscriptions_client_id ON public.operator_push_subscriptions USING btree (client_id);
CREATE INDEX ix_operator_push_subscriptions_operator_id ON public.operator_push_subscriptions USING btree (operator_id);
CREATE INDEX ix_operators_bot_id ON public.operators USING btree (bot_id);
CREATE INDEX ix_operators_linked_client_id ON public.operators USING btree (linked_client_id);
CREATE UNIQUE INDEX ix_operators_operator_api_key ON public.operators USING btree (operator_api_key);
CREATE INDEX ix_payment_methods_client_id ON public.payment_methods USING btree (client_id);
CREATE UNIQUE INDEX ix_payment_methods_razorpay_token_id ON public.payment_methods USING btree (razorpay_token_id);
CREATE UNIQUE INDEX ix_plans_slug ON public.plans USING btree (slug);
CREATE INDEX ix_platform_feedback_area ON public.platform_feedback USING btree (area);
CREATE INDEX ix_platform_feedback_client_id ON public.platform_feedback USING btree (client_id);
CREATE INDEX ix_platform_feedback_created_at ON public.platform_feedback USING btree (created_at);
CREATE INDEX ix_platform_feedback_status ON public.platform_feedback USING btree (status);
CREATE INDEX ix_platform_feedback_type ON public.platform_feedback USING btree (type);
CREATE INDEX ix_processed_webhooks_provider ON public.processed_webhooks USING btree (provider);
CREATE INDEX ix_referral_conversions_client_id ON public.referral_conversions USING btree (client_id);
CREATE INDEX ix_subscriptions_bot_id ON public.subscriptions USING btree (bot_id);
CREATE UNIQUE INDEX ix_subscriptions_client_bot_active ON public.subscriptions USING btree (client_id, bot_id) WHERE ((bot_id IS NOT NULL) AND ((status)::text = ANY ((ARRAY['active'::character varying, 'trialing'::character varying, 'past_due'::character varying])::text[])));
CREATE INDEX ix_subscriptions_client_id ON public.subscriptions USING btree (client_id);
CREATE UNIQUE INDEX ix_subscriptions_client_legacy_active ON public.subscriptions USING btree (client_id) WHERE ((bot_id IS NULL) AND ((status)::text = ANY ((ARRAY['active'::character varying, 'trialing'::character varying, 'past_due'::character varying])::text[])));
CREATE INDEX ix_subscriptions_razorpay_customer_id ON public.subscriptions USING btree (razorpay_customer_id);
CREATE UNIQUE INDEX ix_subscriptions_razorpay_subscription_id ON public.subscriptions USING btree (razorpay_subscription_id);
CREATE INDEX ix_usage_records_client_id ON public.usage_records USING btree (client_id);
CREATE UNIQUE INDEX ix_usage_records_client_period ON public.usage_records USING btree (client_id, period_start);
CREATE INDEX ix_visitor_events_session_id ON public.visitor_events USING btree (session_id);
CREATE INDEX ix_webhook_deliveries_webhook_id ON public.webhook_deliveries USING btree (webhook_id);
CREATE INDEX ix_webhooks_bot_id ON public.webhooks USING btree (bot_id);
CREATE UNIQUE INDEX uq_credit_ledger_idempotency_key ON public.credit_ledger USING btree (idempotency_key) WHERE ((idempotency_key IS NOT NULL) AND (delta < 0));
CREATE UNIQUE INDEX ux_operator_invites_pending_unique ON public.operator_invites USING btree (client_id, email) WHERE ((status)::text = 'pending'::text);
CREATE UNIQUE INDEX ux_operators_linked_per_workspace ON public.operators USING btree (client_id, linked_client_id) WHERE (linked_client_id IS NOT NULL);
ALTER TABLE ONLY public.activation_events
    ADD CONSTRAINT activation_events_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.activation_events
    ADD CONSTRAINT activation_events_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.affiliate_invites
    ADD CONSTRAINT affiliate_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.affiliates
    ADD CONSTRAINT affiliates_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.affiliates
    ADD CONSTRAINT affiliates_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.bant_signals
    ADD CONSTRAINT bant_signals_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.chat_messages(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.bant_signals
    ADD CONSTRAINT bant_signals_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.bot_growth_events
    ADD CONSTRAINT bot_growth_events_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.canned_responses
    ADD CONSTRAINT canned_responses_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.canned_responses
    ADD CONSTRAINT canned_responses_created_by_operator_id_fkey FOREIGN KEY (created_by_operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.chat_audit_logs
    ADD CONSTRAINT chat_audit_logs_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.chat_audit_logs
    ADD CONSTRAINT chat_audit_logs_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_assigned_operator_id_fkey FOREIGN KEY (assigned_operator_id) REFERENCES public.operators(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_referral_code_id_fkey FOREIGN KEY (referral_code_id) REFERENCES public.referral_codes(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES public.credit_ledger(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.discounted_plan_cache
    ADD CONSTRAINT discounted_plan_cache_base_plan_id_fkey FOREIGN KEY (base_plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_source_chunk_id_fkey FOREIGN KEY (source_chunk_id) REFERENCES public.documents(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.impersonation_tokens
    ADD CONSTRAINT impersonation_tokens_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.impersonation_tokens
    ADD CONSTRAINT impersonation_tokens_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_credit_note_of_id_fkey FOREIGN KEY (credit_note_of_id) REFERENCES public.invoices(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.lead_info
    ADD CONSTRAINT lead_info_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.lead_info
    ADD CONSTRAINT lead_info_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.live_chat_queue
    ADD CONSTRAINT live_chat_queue_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.live_chat_queue
    ADD CONSTRAINT live_chat_queue_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.llm_call_logs
    ADD CONSTRAINT llm_call_logs_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.llm_call_logs
    ADD CONSTRAINT llm_call_logs_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.meeting_bookings
    ADD CONSTRAINT meeting_bookings_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.meeting_bookings
    ADD CONSTRAINT meeting_bookings_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_accounts
    ADD CONSTRAINT oauth_accounts_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.offline_messages
    ADD CONSTRAINT offline_messages_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.offline_messages
    ADD CONSTRAINT offline_messages_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.offline_messages
    ADD CONSTRAINT offline_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.operator_invites
    ADD CONSTRAINT operator_invites_accepted_by_client_id_fkey FOREIGN KEY (accepted_by_client_id) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.operator_invites
    ADD CONSTRAINT operator_invites_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.operator_invites
    ADD CONSTRAINT operator_invites_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.operator_invites
    ADD CONSTRAINT operator_invites_invited_by_client_id_fkey FOREIGN KEY (invited_by_client_id) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.operator_invites
    ADD CONSTRAINT operator_invites_revoked_by_client_id_fkey FOREIGN KEY (revoked_by_client_id) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.operator_push_subscriptions
    ADD CONSTRAINT operator_push_subscriptions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.operator_push_subscriptions
    ADD CONSTRAINT operator_push_subscriptions_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_linked_client_id_fkey FOREIGN KEY (linked_client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.platform_feedback
    ADD CONSTRAINT platform_feedback_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.platform_feedback
    ADD CONSTRAINT platform_feedback_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.pricing_config
    ADD CONSTRAINT pricing_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.referral_clicks
    ADD CONSTRAINT referral_clicks_code_id_fkey FOREIGN KEY (code_id) REFERENCES public.referral_codes(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_affiliate_id_fkey FOREIGN KEY (affiliate_id) REFERENCES public.affiliates(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.referral_conversions
    ADD CONSTRAINT referral_conversions_affiliate_id_fkey FOREIGN KEY (affiliate_id) REFERENCES public.affiliates(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.referral_conversions
    ADD CONSTRAINT referral_conversions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.referral_conversions
    ADD CONSTRAINT referral_conversions_referral_code_id_fkey FOREIGN KEY (referral_code_id) REFERENCES public.referral_codes(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_scheduled_plan_id_fkey FOREIGN KEY (scheduled_plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_upgrade_pending_plan_id_fkey FOREIGN KEY (upgrade_pending_plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.usage_records
    ADD CONSTRAINT usage_records_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.usage_records
    ADD CONSTRAINT usage_records_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.visitor_events
    ADD CONSTRAINT visitor_events_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.visitor_events
    ADD CONSTRAINT visitor_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_fkey FOREIGN KEY (webhook_id) REFERENCES public.webhooks(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
